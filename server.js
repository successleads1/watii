// server.js
// Multi-session WhatsApp Web API using Baileys + Socket.IO (real-time updates)

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios'); // For DeepSeek API requests

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DeepSeek API Key
const DEEPSEEK_API_KEY = 'sk-bb30906f4e0d407bae6f58fdb464c451';

// Function to interact with DeepSeek API
async function sendToDeepSeek(message, context = '') {
  try {
    const systemPrompt = context || 'You are a helpful AI assistant.';
    const englishInstruction = ' IMPORTANT: Always respond in English only, regardless of the language the user writes in.';
    
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: systemPrompt + englishInstruction
        },
        {
          role: 'user',
          content: message
        }
      ],
      max_tokens: 1000,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content; // DeepSeek's response
  } catch (error) {
    console.error("Error communicating with DeepSeek:", error.response?.data || error.message);
    return "I'm sorry, I couldn't understand that.";
  }
}

// Health Check Endpoint
// This will help Render monitor the health of your app
app.get('/healthz', (req, res) => {
  res.status(200).send('OK'); // Returns "OK" with a 200 status code to indicate the app is running
});

const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const Sessions = new Map();
const logger = pino({ level: 'silent' });

let isAIEnabled = true; // Track whether AI is enabled or paused

function jidFromNumber(msisdn) {
  const digits = String(msisdn || '').replace(/\D/g, '');
  return digits.endsWith('@s.whatsapp.net') ? digits : `${digits}@s.whatsapp.net`;
}

function sessionRoom(id) {
  return `sess:${id}`;
}

async function broadcastQR(record) {
  if (!record.qr) {
    io.to(sessionRoom(record.id)).emit('session:qr', { id: record.id, dataURL: null });
    return;
  }
  try {
    const dataURL = await QRCode.toDataURL(record.qr, { margin: 1, width: 300 });
    io.to(sessionRoom(record.id)).emit('session:qr', { id: record.id, dataURL });
  } catch (e) {
    io.to(sessionRoom(record.id)).emit('session:qr', { id: record.id, dataURL: null });
  }
}

function broadcastStatus(record) {
  const me = record.sock?.user?.id || null;
  io.to(sessionRoom(record.id)).emit('session:update', {
    id: record.id,
    status: record.status,
    me
  });
}

function broadcastMessage(record, msg) {
  io.to(sessionRoom(record.id)).emit('session:message', {
    id: record.id,
    message: msg
  });
}

async function startSession(sessionId, { auto = false } = {}) {
  let record = Sessions.get(sessionId);
  if (!record) {
    record = { id: sessionId, sock: null, qr: null, status: 'idle', messages: [], startedAt: Date.now() };
    Sessions.set(sessionId, record);
  }
  if (record.sock && record.status === 'open') return record;

  const authDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  record.status = 'connecting';
  record.qr = null;
  broadcastStatus(record);

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['AfroIntelligent', 'Chrome', '1.0.0']
  });

  record.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      record.qr = qr;
      record.status = 'qr';
      broadcastStatus(record);
      await broadcastQR(record);
    }

    if (connection === 'open') {
      record.qr = null;
      record.status = 'open';
      broadcastStatus(record);
      await broadcastQR(record);
      console.log(`[${sessionId}] connected as ${sock.user?.id}`);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log(`[${sessionId}] closed (code=${code}). Reconnect: ${shouldReconnect}`);

      if (code === DisconnectReason.loggedOut) {
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        record.status = 'logged-out';
        record.qr = null;
        record.sock = null;
        broadcastStatus(record);
        await broadcastQR(record);
      } else if (shouldReconnect) {
        record.status = 'connecting';
        record.qr = null;
        broadcastStatus(record);
        await broadcastQR(record);
        setTimeout(() => startSession(sessionId, { auto: true }).catch(() => {}), 1500);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msgs = m.messages || [];
    for (const msg of msgs) {
      const compact = {
        key: msg.key,
        messageTimestamp: msg.messageTimestamp,
        pushName: msg.pushName,
        from: msg.key.remoteJid,
        text:
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          null
      };
      record.messages.push(compact);
      if (record.messages.length > 50) record.messages.shift();
      broadcastMessage(record, compact);

      // Auto-respond with AI if enabled and it's not from us
      if (isAIEnabled && compact.text && !msg.key.fromMe) {
        try {
          const aiResponse = await sendToDeepSeek(
            compact.text, 
            "You are a professional sales agent helping to collect leads and provide information. You must always respond in English only, no matter what language the customer uses."
          );
          
          // Send AI response back to the sender
          if (aiResponse && record.sock) {
            await record.sock.sendMessage(compact.from, { text: aiResponse });
          }
        } catch (error) {
          console.error('Error sending AI response:', error);
        }
      }
    }
  });

  return record;
}

// ---------- HTTP API (kept minimal; sockets deliver realtime) ----------

app.post('/session/:id/start', async (req, res) => {
  const { id } = req.params;
  try {
    const s = await startSession(id);
    res.json({ ok: true, id: s.id, status: s.status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/session/:id/messages', (req, res) => {
  const { id } = req.params;
  const s = Sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, id, messages: s.messages || [] });
});

app.post('/session/:id/send', async (req, res) => {
  const { id } = req.params;
  const { to, text } = req.body || {};
  const s = Sessions.get(id);
  if (!s || !s.sock || s.status !== 'open') {
    return res.status(400).json({ ok: false, error: 'Session not ready/connected' });
  }
  if (!to || !text) {
    return res.status(400).json({ ok: false, error: 'Missing "to" or "text"' });
  }
  try {
    const jid = jidFromNumber(to);
    const r = await s.sock.sendMessage(jid, { text: String(text) });
    res.json({ ok: true, id, to: jid, response: r });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Pause AI
app.post('/pause-ai', (req, res) => {
  isAIEnabled = false;
  res.json({ status: 'AI paused' });
});

// Resume AI
app.post('/resume-ai', (req, res) => {
  isAIEnabled = true;
  res.json({ status: 'AI resumed' });
});

// ---------- DeepSeek Integration Route ----------
// DeepSeek integration to handle AI responses for lead collection
app.post('/deepseek', async (req, res) => {
  const { message, context } = req.body;
  const aiResponse = await sendToDeepSeek(message, context);
  res.json({ reply: aiResponse });
});

// ---------- Socket.IO: subscribe to a session room ----------

io.on('connection', (socket) => {
  socket.on('session:subscribe', async (id) => {
    if (!id) return;
    socket.join(sessionRoom(id));
    const s = Sessions.get(id);
    if (s) {
      broadcastStatus(s);
      broadcastQR(s).catch(() => {});
    }
  });

  socket.on('disconnect', () => {
    // no-op (Socket.IO auto-cleans rooms)
  });
});

// ---------- Auto-restore saved sessions ----------

function readSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

(async () => {
  const stored = readSubdirs(SESSIONS_DIR);
  for (const id of stored) startSession(id, { auto: true }).catch(() => {});
  server.listen(PORT, () => {
    console.log(`🚀 Server (WS + HTTP) on http://localhost:${PORT}`);
  });
})();