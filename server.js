'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Configuración (variables de entorno) ----------
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'solo-para-desarrollo';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const CURRENCY = process.env.MP_CURRENCY || 'PYG'; // ver notas: verificar moneda soportada
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.json');
const IS_PROD = process.env.NODE_ENV === 'production';

const BETS = [1000, 5000, 10000, 50000];
const MIN_DEPOSIT = 10000;
const MAX_DEPOSIT = 5000000;

// ---------- Base de datos JSON (todo en memoria, guardado atómico) ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
let db = { users: {}, deposits: {} };
if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

function save() {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_PATH);
}

// ---------- Utilidades de seguridad ----------
const safeEq = (a, b) => {
  a = Buffer.from(String(a));
  b = Buffer.from(String(b));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const mac = (s) => crypto.createHmac('sha256', TOKEN_SECRET).update(s).digest('base64url');

function sign(uid) {
  const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + mac(p);
}
function verify(t) {
  const [p, s] = String(t).split('.');
  if (!p || !s || !safeEq(mac(p), s)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() ? d.uid : null;
  } catch { return null; }
}
function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pass, salt, 64).toString('hex') };
}

const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now();
  const a = (hits.get(k) || []).filter((t) => now - t < ms);
  a.push(now);
  hits.set(k, a);
  if (a.length > max) return res.status(429).json({ error: 'Demasiados intentos. Espera un momento.' });
  next();
};

function auth(req, res, next) {
  const uid = verify((req.headers.authorization || '').replace('Bearer ', ''));
  const user = uid && db.users[uid];
  if (!user) return res.status(401).json({ error: 'Sesión inválida. Vuelve a entrar.' });
  req.user = user;
  next();
}
const pub = (u) => ({ email: u.email, balance: u.balance });

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.send('ok'));

// --- Cuentas ---
app.post('/api/register', limit(10, 60000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Correo no válido.' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  if (req.body.mayor18 !== true) return res.status(400).json({ error: 'Debes confirmar que eres mayor de 18 años.' });
  if (Object.values(db.users).some((u) => u.email === email)) return res.status(409).json({ error: 'Ese correo ya está registrado.' });
  const id = crypto.randomUUID();
  db.users[id] = { id, email, ...hashPass(password), balance: 0, createdAt: Date.now() };
  save();
  res.json({ token: sign(id), user: pub(db.users[id]) });
});

app.post('/api/login', limit(10, 60000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = Object.values(db.users).find((x) => x.email === email);
  const ok = u && safeEq(hashPass(String(req.body.password || ''), u.salt).hash, u.hash);
  if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  res.json({ token: sign(u.id), user: pub(u) });
});

app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));

// --- Juego: tragamonedas (RNG en el servidor) ---
const SYMS = ['🍒', '🍋', '🔔', '⭐', '7'];
const PAY = { '🍒': 5, '🍋': 10, '🔔': 15, '⭐': 25, '7': 50 }; // RTP teórico ≈ 93,6 %

app.post('/api/spin', auth, limit(60, 60000), (req, res) => {
  const bet = Number(req.body.bet);
  const u = req.user;
  if (!BETS.includes(bet)) return res.status(400).json({ error: 'Apuesta no válida.' });
  if (u.balance < bet) return res.status(400).json({ error: 'Saldo insuficiente. Deposita para seguir jugando.' });
  const reels = [0, 1, 2].map(() => SYMS[crypto.randomInt(SYMS.length)]);
  let mult = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) mult = PAY[reels[0]];
  else if (reels.filter((s) => s === '🍒').length === 2) mult = 1;
  const win = bet * mult;
  u.balance += win - bet;
  save();
  res.json({ reels, win, balance: u.balance });
});

// --- Depósitos: crea la preferencia de pago en Mercado Pago ---
app.post('/api/deposit', auth, limit(10, 60000), async (req, res) => {
  const amount = Math.round(Number(req.body.amount));
  if (!(amount >= MIN_DEPOSIT && amount <= MAX_DEPOSIT)) {
    return res.status(400).json({ error: `El depósito debe estar entre ${MIN_DEPOSIT} y ${MAX_DEPOSIT}.` });
  }
  if (!MP_TOKEN) return res.status(503).json({ error: 'Pagos no configurados todavía.' });

  const id = crypto.randomUUID();
  db.deposits[id] = { id, uid: req.user.id, amount, status: 'pending', at: Date.now() };
  save();
  try {
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ title: 'Saldo Casino Clave', quantity: 1, unit_price: amount, currency_id: CURRENCY }],
        external_reference: id,
        notification_url: `${BASE_URL}/api/webhook`,
        back_urls: { success: `${BASE_URL}/?pago=ok`, pending: `${BASE_URL}/?pago=pendiente`, failure: `${BASE_URL}/?pago=error` },
        auto_return: 'approved',
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || r.status);
    res.json({ url: d.init_point });
  } catch (e) {
    console.error('MP preference error:', e.message);
    res.status(502).json({ error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
  }
});

// --- Webhook de Mercado Pago ---
function validSignature(req, dataId) {
  if (!MP_WEBHOOK_SECRET) return !IS_PROD; // en producción la firma es obligatoria
  const parts = Object.fromEntries(
    String(req.headers['x-signature'] || '').split(',').map((s) => s.trim().split('='))
  );
  if (!parts.ts || !parts.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${req.headers['x-request-id'] || ''};ts:${parts.ts};`;
  const h = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeEq(h, parts.v1);
}

app.post('/api/webhook', async (req, res) => {
  const type = req.query.type || req.body?.type;
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '');
  if (type !== 'payment' || !dataId) return res.sendStatus(200); // otros eventos: ignorar
  if (!validSignature(req, dataId)) return res.sendStatus(401);

  try {
    // Nunca confiamos en el cuerpo de la notificación: consultamos el pago a Mercado Pago.
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(dataId)}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    if (!r.ok) return res.sendStatus(502); // MP reintentará
    const p = await r.json();
    const dep = db.deposits[p.external_reference];

    if (dep && p.status === 'approved' && dep.status !== 'credited' && Number(p.transaction_amount) === dep.amount) {
      dep.status = 'credited'; // marca primero: idempotente ante reintentos
      dep.paymentId = p.id;
      db.users[dep.uid].balance += dep.amount;
      save();
      console.log(`Depósito acreditado: ${dep.amount} a ${dep.uid}`);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

// --- Solo desarrollo: saldo de prueba sin pasar por Mercado Pago ---
if (!IS_PROD) {
  app.post('/api/dev/credit', auth, (req, res) => {
    req.user.balance += 50000;
    save();
    res.json(pub(req.user));
  });
}

app.listen(PORT, () => console.log(`Casino Clave en ${BASE_URL}`));
