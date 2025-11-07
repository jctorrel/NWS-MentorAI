import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const mongoClient = new MongoClient(process.env.MONGODB_URI);

const config = JSON.parse(fs.readFileSync("./config/mentor-config.json", "utf8"));

let db;
async function init() {
  await mongoClient.connect();
  db = mongoClient.db(); // default DB from URI
  console.log("Mongo connecté, MVP prêt.");
}
init().catch(console.error);

// Récupérer le résumé "mémoire" d'un étudiant
async function getStudentSummary(email) {
  const doc = await db.collection("student_summaries").findOne({ email });
  return doc?.summary || "";
}

// Mettre à jour le résumé après chaque échange (MVP : on régénère à partir d'un historique léger)
async function updateStudentSummary(email, lastUserMessage, lastAssistantReply) {
  const base = await getStudentSummary(email);

  const prompt = [
    {
      role: "system",
      content:
        "Tu résumes la situation d'un étudiant en quelques puces factuelles, pour aider un mentor à le suivre."
    },
    {
      role: "user",
      content:
        `Résumé actuel : ${base || "(aucun)"}\n` +
        `Dernier message étudiant : ${lastUserMessage}\n` +
        `Dernière réponse mentor : ${lastAssistantReply}\n` +
        `Mets à jour le résumé (court, utile, sans doublons).`
    }
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-5.1-mini", // ou modèle dispo dans ton compte
    messages: prompt,
    max_tokens: 150
  });

  const newSummary = completion.choices[0].message.content;

  await db.collection("student_summaries").updateOne(
    { email },
    { $set: { email, summary: newSummary, updatedAt: new Date() } },
    { upsert: true }
  );
}

// Endpoint principal
app.post("/api/chat", async (req, res) => {
  try {
    const { email, message } = req.body;
    if (!email || !message) {
      return res.status(400).json({ error: "email et message requis" });
    }

    const summary = await getStudentSummary(email);

    const systemPrompt = `
Tu es le mentor pédagogique personnel de l'étudiant ${email} à ${config.school_name}.
Ton ton : ${config.tone}.

Règles obligatoires :
${config.rules.map(r => "- " + r).join("\n")}

Contexte étudiant (résumé) :
${summary || "- Aucun historique significatif pour l'instant."}

Ta mission :
- Comprendre ses difficultés.
- Proposer des actions concrètes et adaptées.
- Rester dans le cadre de l'école et du programme.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.1-mini", // adapte selon les modèles recommandés :contentReference[oaicite:0]{index=0}
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 400
    });

    const reply = completion.choices[0].message.content.trim();

    // Met à jour la mémoire résumée (non bloquant dans un MVP simple)
    updateStudentSummary(email, message, reply).catch(console.error);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur interne" });
  }
});

app.listen(3000, () => {
  console.log("Serveur MVP sur http://localhost:3000");
});
