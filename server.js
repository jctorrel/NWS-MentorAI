// --- Load env ---
import dotenv from "dotenv";
dotenv.config();

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
const USE_MOCK = process.env.USE_MOCK_MENTOR === "true";
const LOG_MESSAGES = process.env.LOG_MESSAGES === "true";

// --- Basic env checks ---
if (!USE_MOCK && !process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY manquant dans .env (requis si USE_MOCK_MENTOR !== true)");
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

// --- OpenAI client (seulement si pas en mock) ---
const openai = !USE_MOCK
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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
let config = {
  school_name: "École Démo",
  tone: "bienveillant, concret, structuré",
  rules: [
    "Ne jamais conseiller à l'étudiant de quitter l'école.",
    "Ne pas remettre en cause le programme officiel.",
    "Toujours encourager des stratégies de travail réalistes.",
    "Rediriger vers un humain en cas de détresse ou problème grave."
  ]
};

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

// --- Mock helpers ---

function buildMockReply(message, summary) {
  const safeSummary = summary || "Peu d'informations pour le moment.";
  return [
    "👋 (mode démo) Je suis ton mentor pédagogique de test.",
    `Je sais pour l'instant : ${safeSummary}`,
    `Tu viens d'écrire : "${message}"`,
    "Dans la version connectée à l'API, je te proposerais ici un plan d'action personnalisé (organisation, priorités, ressources).",
    "En attendant, commence par définir 1 à 3 objectifs concrets pour la semaine, et découper ton travail en petites sessions de 25-30 minutes."
  ].join("\n");
}

async function updateStudentSummaryMock(email, lastUserMessage, lastAssistantReply) {
  if (!db) return;

  const previous = await getStudentSummary(email);
  const truncatedUser = lastUserMessage.slice(0, 140);
  const truncatedAssistant = lastAssistantReply.slice(0, 140);

  const newSummary =
    `• Historique (mode démo) : résumé précédent = ${previous || "aucun"}\n` +
    `• Dernier message étudiant (extrait) : "${truncatedUser}"\n` +
    `• Dernière réponse mentor (extrait) : "${truncatedAssistant}"\n` +
    `• Suivi suggéré : continuer à affiner les objectifs et identifier les matières à risque.`;

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
}

// --- Summary update (réel via OpenAI ou mock) ---

async function updateStudentSummary(email, lastUserMessage, lastAssistantReply) {
  if (USE_MOCK || !openai) {
    return updateStudentSummaryMock(email, lastUserMessage, lastAssistantReply);
  }

  if (!db) return;

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
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt
        }
      ],
      max_tokens: 250
    });

    const newSummary = completion.choices[0].message.content.trim();

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

// --- Routes ---

// Page d'accueil -> public/index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Endpoint de chat principal
app.post("/api/chat", async (req, res) => {
  try {
    const { email, message } = req.body;

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

    const systemPrompt = render(mentorSystemTemplate, {
      email,
      school_name: config.school_name,
      tone: config.tone,
      rules: rulesText || "- (aucune règle définie)",
      summary: summary || "- Aucun historique significatif pour l'instant."
    });

    if (!systemPrompt.trim()) {
      console.error("❌ mentor-system.txt est vide ou non chargé.");
      return res.status(500).json({
        reply:
          "Le mentor n'est pas correctement configuré. Contacte l'équipe pédagogique."
      });
    }

    // --- MODE MOCK : pas d'appel OpenAI, réponse locale ---
    if (USE_MOCK || !openai) {
      const mockReply = buildMockReply(message, summary);
      await saveMessage(email, "assistant", mockReply);
      updateStudentSummary(email, message, mockReply).catch(console.error);
      return res.json({ reply: mockReply });
    }

    // --- MODE RÉEL : appel OpenAI ---
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini", // adapte si besoin
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 400
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Je n'ai pas pu générer de réponse pour le moment.";

    // Log réponse mentor
    await saveMessage(email, "assistant", reply);

    // Mise à jour mémoire en arrière-plan
    updateStudentSummary(email, message, reply).catch(console.error);

    return res.json({ reply });
  } catch (err) {
    console.error("❌ Erreur /api/chat :", err);

    // Si problème quota, essayer un fallback mock si activé
    if (
      (err.status === 429 || err.code === "insufficient_quota") &&
      USE_MOCK
    ) {
      const summary = await getStudentSummary(req.body.email);
      const mockReply = buildMockReply(req.body.message, summary);
      await saveMessage(req.body.email, "assistant", mockReply);
      updateStudentSummary(req.body.email, req.body.message, mockReply).catch(
        console.error
      );
      return res.json({ reply: mockReply });
    }

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

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `✅ Serveur MVP sur http://localhost:${PORT} (mock=${USE_MOCK ? "ON" : "OFF"})`
  );
});
