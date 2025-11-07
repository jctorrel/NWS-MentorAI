// Configuration minimale côté client
const DEFAULT_EMAIL = "etudiant.test@example.com";
const PROGRAM_ID = "A1";

// Récupère l'email via ?email=... si présent, sinon valeur par défaut
function getStudentEmail() {
  const params = new URLSearchParams(window.location.search);
  return params.get("email") || DEFAULT_EMAIL;
}

const studentEmail = getStudentEmail();

// Elements
const chatEl = document.getElementById("chat");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const sendBtnEl = document.getElementById("send-btn");
const errorEl = document.getElementById("error");
const statusLabelEl = document.getElementById("status-label");
const emailLabelEl = document.getElementById("student-email-label");

emailLabelEl.textContent = studentEmail;

// Utilitaires d'affichage
function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addUserMessage(text) {
  const row = document.createElement("div");
  row.className = "msg-row me";

  const bubble = document.createElement("div");
  bubble.className = "msg me";
  bubble.textContent = text;

  row.appendChild(bubble);
  chatEl.appendChild(row);
  scrollToBottom();
}

function addMentorMessageMarkdown(text) {
  const row = document.createElement("div");
  row.className = "msg-row mentor";

  const bubble = document.createElement("div");
  bubble.className = "msg mentor";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Mentor";

  const content = document.createElement("div");
  // Convertit le markdown en HTML
  content.innerHTML = marked.parse(text, { breaks: true });

  bubble.appendChild(label);
  bubble.appendChild(content);
  row.appendChild(bubble);
  chatEl.appendChild(row);
  scrollToBottom();
}

let typingRow = null;

function showTyping() {
  if (typingRow) return;
  typingRow = document.createElement("div");
  typingRow.className = "msg-row mentor";

  const bubble = document.createElement("div");
  bubble.className = "msg mentor";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Mentor";

  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = `<span></span><span></span><span></span>`;

  bubble.appendChild(label);
  bubble.appendChild(typing);
  typingRow.appendChild(bubble);
  chatEl.appendChild(typingRow);
  scrollToBottom();
}

function hideTyping() {
  if (typingRow && typingRow.parentNode) {
    typingRow.parentNode.removeChild(typingRow);
  }
  typingRow = null;
}

// Gestion erreurs UI
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}
function clearError() {
  errorEl.textContent = "";
  errorEl.style.display = "none";
}

// Appel API
async function sendMessage(message) {
  const payload = {
    email: studentEmail,
    message: message,
    programID : PROGRAM_ID
  };

  try {
    statusLabelEl.textContent = "Le mentor réfléchit...";
    showTyping();
    clearError();
    sendBtnEl.disabled = true;
    inputEl.disabled = true;

    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    hideTyping();

    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      // ignore parse error, handled below
    }

    if (!resp.ok) {
      const safeMsg =
        (data && data.reply) ||
        "Une erreur technique est survenue. Signale-le à l'équipe si cela persiste.";
      addMentorMessageMarkdown(safeMsg);
      showError(`Erreur ${resp.status} côté serveur.`);
      return;
    }

    const reply = (data && (data.reply || data.message)) || "Réponse vide.";
    addMentorMessageMarkdown(reply);
  } catch (err) {
    console.error("Erreur front /api/chat :", err);
    hideTyping();
    addMentorMessageMarkdown(
      "Je n'arrive pas à joindre le serveur du mentor. Vérifie ta connexion ou signale le problème."
    );
    showError("Impossible de contacter le serveur (`/api/chat`).");
  } finally {
    statusLabelEl.textContent = "Prêt";
    sendBtnEl.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
}

// Gestion du formulaire
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  addUserMessage(text);
  inputEl.value = "";
  sendMessage(text);
});

// Message d'accueil
addMentorMessageMarkdown(
  "Bonjour 👋\n\nJe suis ton mentor pédagogique numérique. " +
    "Explique-moi ta situation, tes difficultés ou tes objectifs, " +
    "et je t'aide à t'organiser dans le cadre de ton école."
);

inputEl.focus();

// En ligne <> Hors ligne
document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');

  function setStatus(online, reason = '') {
    if (!statusDot || !statusLabel) return;

    statusDot.classList.remove('status-online', 'status-offline');

    if (online) {
      statusDot.classList.add('status-online');
      statusLabel.textContent = 'En ligne';
    } else {
      statusDot.classList.add('status-offline');
      statusLabel.textContent = reason || 'Hors ligne';
    }
  }

  async function checkBackendStatus() {
    try {
      const res = await fetch('/api/health', { method: 'GET' });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data) {
        setStatus(false, 'Hors ligne (erreur serveur)');
        return;
      }

      // Tout est bon
      setStatus(true);
    } catch (err) {
      setStatus(false, 'Hors ligne (serveur injoignable)');
    }
  }

  // Premier check au chargement
  checkBackendStatus();

  // Réagit aux changements réseau
  window.addEventListener('online', checkBackendStatus);
  window.addEventListener('offline', () => {
    setStatus(false, 'Hors ligne (pas de connexion réseau)');
  });
});
