// --- Load env ---
import dotenv from "dotenv";
dotenv.config();

const MENTOR_MODEL = process.env.MENTOR_MODEL || "gpt-4.1-mini";
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gpt-4.1-mini";

// --- Imports ---
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- ESM dirname/filename shim ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Flags ---
const LOG_MESSAGES = process.env.LOG_MESSAGES === "true";

// --- Basic env checks ---
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY manquant dans .env");
}
if (!process.env.MONGODB_URI) {
  console.warn("⚠️  MONGODB_URI manquant dans .env");
}

// --- Express app ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Static files (/public) ---
app.use(express.static(path.join(__dirname, "public")));

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- MongoDB setup ---
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

async function initMongo() {
  try {
    await mongoClient.connect();
    db = mongoClient.db();
    console.log("✅ Mongo connecté");
  } catch (err) {
    console.error("❌ Erreur connexion Mongo :", err);
  }
}
initMongo().catch(console.error);

// --- Load mentor config ---
let config = {};
try {
  const raw = fs.readFileSync(
    path.join(__dirname, "config", "mentor-config.json"),
    "utf8"
  );
  const parsed = JSON.parse(raw);
  config = { ...config, ...parsed };
  console.log("✅ Config mentor chargée");
} catch (err) {
  console.warn(
    "⚠️ Impossible de charger config/mentor-config.json, utilisation des valeurs par défaut."
  );
}

// --- Load prompt templates ---
function loadPrompt(name) {
  const filePath = path.join(__dirname, "config", "prompts", name);
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`❌ Impossible de charger le prompt ${name} :`, err);
    return "";
  }
}

const mentorSystemTemplate = loadPrompt("mentor-system.txt");
const summarySystemTemplate = loadPrompt("summary-system.txt");

// --- Tiny template engine ---
function render(template, vars) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) &&
      vars[key] !== undefined &&
      vars[key] !== null
      ? String(vars[key])
      : "";
  });
}

// --- DB helpers ---

async function getStudentSummary(email) {
  if (!db) return "";
  const doc = await db.collection("student_summaries").findOne({ email });
  return doc?.summary || "";
}

async function saveMessage(email, role, content) {
  if (!db) return;
  if (!LOG_MESSAGES) return; // ➜ si false, on ne stocke rien
  await db.collection("messages").insertOne({
    email,
    role,
    content,
    createdAt: new Date()
  });
}


// --- Summary update  ---
async function updateStudentSummary(email, lastUserMessage, lastAssistantReply) {
  if (!openai || !db) return;

  const previous = await getStudentSummary(email);

  const systemPrompt = render(summarySystemTemplate, {
    previous_summary: previous || "(aucun)",
    last_user_message: lastUserMessage,
    last_assistant_reply: lastAssistantReply
  });

  if (!systemPrompt.trim()) {
    console.warn("⚠️ summary-system.txt est vide ou non chargé, skip update summary.");
    return;
  }

  try {
    const completion = await openai.responses.create({
      model: SUMMARY_MODEL,
      input: systemPrompt
    });

    const newSummary = completion.output_text.trim();

    await db.collection("student_summaries").updateOne(
      { email },
      {
        $set: {
          email,
          summary: newSummary,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("❌ Erreur updateStudentSummary (OpenAI) :", err);
  }
}

// --- Load programs config ---
let programs = {};

try {
  const raw = fs.readFileSync(
    path.join(__dirname, "config", "programs.json"),
    "utf8"
  );
  programs = JSON.parse(raw);
  console.log("✅ Programmes chargés");
} catch (err) {
  console.warn("⚠️ Impossible de charger config/programs.json, aucun programme en mémoire.");
}

// --- Routes ---

// Page d'accueil -> public/index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Endpoint de chat principal
app.post("/api/chat", async (req, res) => {
  try {
    const { email, message, programId } = req.body;

    if (!email || !message) {
      return res
        .status(400)
        .json({ reply: "email et message sont requis." });
    }

    // Log message utilisateur
    await saveMessage(email, "user", message);

    const summary = await getStudentSummary(email);
    const rulesText = (config.rules || [])
      .map((r) => "- " + r)
      .join("\n");
    const programContext = programs[programId];

    const systemPrompt = render(mentorSystemTemplate, {
      email,
      school_name: config.school_name,
      tone: config.tone,
      rules: rulesText,
      summary: summary || "- Aucun historique significatif pour l'instant.",
      program_context: programContext
    });

    if (!systemPrompt.trim()) {
      console.error("❌ mentor-system.txt est vide ou non chargé.");
      return res.status(500).json({
        reply:
          "Le mentor n'est pas correctement configuré. Contacte l'équipe pédagogique."
      });
    }

    const completion = await openai.responses.create({
      model: MENTOR_MODEL,
      instructions: systemPrompt,
      input: message
    });

    const reply = completion.output_text.trim();

    // Log réponse mentor
    await saveMessage(email, "assistant", reply);

    // Mise à jour mémoire en arrière-plan
    updateStudentSummary(email, message, reply).catch(console.error);

    return res.json({ reply });
  } catch (err) {
    console.error("❌ Erreur /api/chat :", err);

    if (err.status === 429 || err.code === "insufficient_quota") {
      return res.status(503).json({
        reply:
          "Le mentor est temporairement indisponible (limite d'utilisation technique atteinte). Réessaie plus tard ou signale-le à l'équipe."
      });
    }

    return res.status(500).json({
      reply:
        "Je rencontre un problème technique. Réessaie dans un moment ou signale-le à l'équipe."
    });
  }
});

// --- En ligne <> Hors ligne ---
app.get('/api/health', async (req, res) => {
  try {
    const status = openai !== null;

    // Si ok => 200, sinon => 503
    res.status(status ? 200 : 503).json(status);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ ok: false, error: 'health_check_failed' });
  }
});


// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `✅ Serveur MVP sur http://localhost:${PORT}`
  );
});
