  const studentEmail = "etudiant.test@normandiewebschool.fr";
  const chatEl = document.getElementById('chat');
  const form = document.getElementById('form');
  const input = document.getElementById('input');

  function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = 'msg ' + sender;
    div.textContent = (sender === 'me' ? 'Moi: ' : 'Mentor: ') + text;
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, 'me');
    input.value = '';

    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, email: studentEmail })
    });

    const data = await resp.json();
    addMessage(data.reply || '[Erreur serveur]', 'bot');
  });
