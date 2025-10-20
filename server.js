// server.js — Express + Firebase Admin (Realtime Database, modular API)
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { getDatabase } = require('firebase-admin/database');
const { v4: uuidv4 } = require('uuid');

// ---- Firebase Admin init (explicit cert + clean URL) ----
const sa = require('./serviceAccount.json'); // keep this file next to server.js
const CLEAN_DB_URL = (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: CLEAN_DB_URL,
  });
}
console.log('Admin app initialized for project:', sa.project_id, '→', CLEAN_DB_URL);

// RTDB (modular)
const rtdb = getDatabase(undefined, CLEAN_DB_URL);

// ---- Express ----
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true }));
app.use(express.json());

// Static hosting
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile('index.html'));

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Auth middleware (verify Firebase ID token) ----
async function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = decoded;
    next();
  } catch (e) {
    console.error('verifyIdToken failed', e);
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---- Helpers ----
const userRoot = (uid) => `users/${uid}`;
const sessionRoot = (uid, sid) => `${userRoot(uid)}/sessions/${sid}`;
const sessionMetaRef = (uid, sid) => rtdb.ref(`${sessionRoot(uid, sid)}/meta`);
const sessionMsgsRef = (uid, sid) => rtdb.ref(`${sessionRoot(uid, sid)}/messages`);

// ---- API: me ----
app.get('/api/me', auth, async (req, res) => {
  res.json({ uid: req.user.uid, email: req.user.email || null, name: req.user.name || null });
});

// ---- API: sessions list (recent first) ----
app.get('/api/sessions', auth, async (req, res) => {
  const uid = req.user.uid;
  const snap = await rtdb.ref(`${userRoot(uid)}/sessions`).get();
  const val = snap.val() || {};
  const rows = Object.entries(val).map(([id, s]) => ({
    id,
    ...(s.meta || {}),
  }));
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json(rows.slice(0, 200));
});

// ---- API: create session ----
app.post('/api/sessions', auth, async (req, res) => {
  const uid = req.user.uid;
  const title = (req.body && req.body.title) || 'New chat';
  const sid = uuidv4();
  await sessionMetaRef(uid, sid).set({
    title,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  });
  res.status(201).json({ id: sid, title });
});

// ---- API: rename session ----
app.patch('/api/sessions/:sid', auth, async (req, res) => {
  const uid = req.user.uid;
  const { sid } = req.params;
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  await sessionMetaRef(uid, sid).update({
    title,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  });
  res.json({ ok: true });
});

// ---- API: delete session ----
app.delete('/api/sessions/:sid', auth, async (req, res) => {
  const uid = req.user.uid;
  const { sid } = req.params;
  await rtdb.ref(sessionRoot(uid, sid)).remove();
  res.json({ ok: true });
});

// ---- API: get messages ----
app.get('/api/sessions/:sid/messages', auth, async (req, res) => {
  const uid = req.user.uid;
  const { sid } = req.params;
  const snap = await sessionMsgsRef(uid, sid).get();
  const val = snap.val() || {};
  const rows = Object.entries(val).map(([id, m]) => ({ id, ...m }));
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  res.json(rows);
});

// ---- API: send message (echo assistant reply placeholder) ----
const { generateReply } = require('./ai');

app.post('/api/sessions/:sid/messages', auth, async (req, res) => {
  const uid = req.user.uid;
  const { sid } = req.params;
  const { text } = req.body || {};
  if (!text || typeof text !== 'string')
    return res.status(400).json({ error: 'text required' });

  const msgsRef = sessionMsgsRef(uid, sid);
  const metaRef = sessionMetaRef(uid, sid);

  // 1. Store the user's message
  const userRef = msgsRef.push();
  const userMsg = { role: 'user', text, ts: admin.database.ServerValue.TIMESTAMP };
  await userRef.set(userMsg);

  // 2. Fetch recent messages for context
  const snap = await msgsRef.limitToLast(20).get();
  const history = [];
  if (snap.exists()) {
    for (const m of Object.values(snap.val())) {
      if (m.role && m.text) history.push({ role: m.role, text: m.text });
    }
  }
  history.push({ role: 'user', text });

  // 3. Call Gemini for a reply
  let replyText = '…';
  try {
    const { text: aiText } = await generateReply({ messages: history, userId: uid });
    replyText = aiText || '…';
  } catch (err) {
    console.error('[AI Error]', err);
    replyText = '⚠️ AI service error.';
  }

  // 4. Store assistant message
  const aiRef = msgsRef.push();
  const aiMsg = { role: 'assistant', text: replyText, ts: admin.database.ServerValue.TIMESTAMP };
  await aiRef.set(aiMsg);

  // 5. Update metadata timestamp
  await metaRef.update({ updatedAt: admin.database.ServerValue.TIMESTAMP });

  res.status(201).json({ user: userMsg, assistant: aiMsg });
});


// ---- Start ----
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('API listening on :' + PORT));
