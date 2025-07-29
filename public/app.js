const $ = (id) => document.getElementById(id);

const sessionIdEl = $('sessionId');
const startBtn = $('startBtn');
const statusBtn = $('statusBtn');
const statusText = $('statusText');
const meVal = $('meVal');
const qrWrap = $('qrWrap');
const qrImg = $('qrImg');

const toEl = $('to');
const textEl = $('text');
const sendBtn = $('sendBtn');

const liveEl = $('live');
const loadMsgsBtn = $('loadMsgsBtn');
const msgsEl = $('msgs');

const socket = io(); // same origin

function updateStatusUI({ status, me }) {
  statusText.textContent = status || '—';
  meVal.textContent = me || '—';
  if (status === 'qr') {
    qrWrap.style.display = 'block';
  } else {
    qrWrap.style.display = 'none';
    qrImg.src = '';
  }
}

socket.on('session:update', (payload) => {
  if (!payload) return;
  updateStatusUI(payload);
});

socket.on('session:qr', (payload) => {
  if (!payload) return;
  if (payload.dataURL) {
    qrWrap.style.display = 'block';
    qrImg.src = payload.dataURL;
  } else {
    qrWrap.style.display = 'none';
    qrImg.src = '';
  }
});

socket.on('session:message', (payload) => {
  if (!payload || !payload.message) return;
  const { message } = payload;
  const line = `[${message.messageTimestamp}] from=${message.from} name=${message.pushName || ''} text=${message.text || ''}\n`;
  liveEl.textContent += line;
});

async function jsonFetch(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function startSession() {
  const id = sessionIdEl.value.trim();
  if (!id) return alert('Enter a Session ID');
  await jsonFetch(`/session/${encodeURIComponent(id)}/start`, { method: 'POST' });
  // subscribe after starting
  socket.emit('session:subscribe', id);
}

function subscribe() {
  const id = sessionIdEl.value.trim();
  if (!id) return alert('Enter a Session ID');
  socket.emit('session:subscribe', id);
}

async function sendMessage() {
  const id = sessionIdEl.value.trim();
  if (!id) return alert('Enter a Session ID');
  const to = toEl.value.trim();
  const text = textEl.value;
  if (!to || !text) return alert('Provide "to" and "text"');
  await jsonFetch(`/session/${encodeURIComponent(id)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, text })
  });
  alert('Sent (or queued).');
}

async function loadMessages() {
  const id = sessionIdEl.value.trim();
  if (!id) return alert('Enter a Session ID');
  const r = await jsonFetch(`/session/${encodeURIComponent(id)}/messages`);
  msgsEl.textContent = JSON.stringify(r.messages || [], null, 2);
}

startBtn.addEventListener('click', startSession);
statusBtn.addEventListener('click', subscribe);
sendBtn.addEventListener('click', sendMessage);
loadMsgsBtn.addEventListener('click', loadMessages);
