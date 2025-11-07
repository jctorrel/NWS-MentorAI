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

// --- Basic checks ---
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquant dans .env");
}
if (!process.env.MONGODB_URI) {
  console.error("❌ MONGODB_URI manquant dans .env");
}

// --- App init ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Static files (/public) ---
app.use(express.static(path.join(__dirname, "public")));

// --- OpenAI client ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --- MongoDB ---
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

async function initMongo() {
  try {
    await mongoClient.connect();
    db = mongoClient.db(); // DB par défaut dans l'URI
    console.log("✅ Mongo connecté");
  } catch (err) {
    console.error("❌ Erreur connexion Mongo :", err);
  }
}
initMongo();

// --- Config mentor ---
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
  config = JSON.parse(raw);
  console.log("✅ Config mentor chargée");
} catch (err) {
  console.warn("⚠️ Impossible de charger config/mentor-config.json, utilisation des valeurs par défaut.");
}

// --- Helpers mémoire étudiant ---

async function getStudentSummary(email) {
  if (!db) return "";
  const doc = await db.collection("student_summaries").findOne({ email });
  return doc?.summary || "";
}

async function updateStudentSummary(email, lastUserMessage, lastAssistantReply) {
  if (!db) return;

  const previous = await getStudentSummary(email);

  const messages = [
    {
      role: "system",
      content:
        "Tu es un assistant qui met à jour un résumé concis (5 puces max) décrivant la situation d'un étudiant pour aider un mentor pédagogique. Tu gardes seulement les infos utiles."
    },
    {
      role: "user",
      content:
        `Résumé actuel : ${previous || "(aucun)"}\n` +
        `Dernier message étudiant : ${lastUserMessage}\n` +
        `Dernière réponse mentor : ${lastAssistantReply}\n` +
        `Produis un nouveau résumé mis à jour, en français, sous forme de puces.`
    }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini", // adapte selon les modèles disponibles sur ton compte
      messages,
      max_tokens: 200
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
    console.error("❌ Erreur updateStudentSummary :", err);
  }
}

// --- Routes ---

// Page d'accueil (sert index.html depuis /public)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Endpoint principal de chat
app.post("/api/chat", async (req, res) => {
  try {
    const { email, message } = req.body;

    if (!email || !message) {
      return res
        .status(400)
        .json({ error: "email et message sont requis" });
    }

    const summary = await getStudentSummary(email);

    const systemPrompt = `
Tu es le mentor pédagogique personnel de l'étudiant ${email} à ${config.school_name}.
Ton ton : ${config.tone}.

Règles obligatoires :
${(config.rules || []).map((r) => "- " + r).join("\n")}

Contexte étudiant (résumé) :
${summary || "- Aucun historique significatif pour l'instant."}

Ta mission :
- Comprendre ses difficultés.
- Poser des questions si nécessaire.
- Proposer des actions concrètes, réalistes et bienveillantes.
- Rester strictement dans le cadre de l'école et de son programme.
- Ne jamais encourager l'abandon de l'école ou le contournement des règles.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini", // idem, à ajuster si besoin
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 400
    });

    const reply = completion.choices[0].message.content.trim();

    // Mise à jour mémoire en asynchrone (sans bloquer la réponse)
    updateStudentSummary(email, message, reply).catch(console.error);

    return res.json({ reply });
  } catch (err) {
    console.error("❌ Erreur /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne" });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur MVP sur http://localhost:${PORT}`);
});
