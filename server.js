/**
 * Vérificateur de numéros WhatsApp
 * - Dit si un numéro est toujours disponible sur WhatsApp, ou introuvable / plus disponible
 * - Garde l'historique (dernière fois vu actif, date/heure où il a disparu)
 * - Surveillance automatique de numéros
 * - Mot de passe créé au premier accès (rien à configurer)
 */
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const env = process.env;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const DB_FILE = path.join(DATA_DIR, 'history.json');
const SET_FILE = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEMO = env.DEMO_MODE === '1';
const DAILY_LIMIT = Number(env.DAILY_LIMIT || 300); // vérifications max par jour (protège ton numéro)
const WATCH_EVERY_MIN = Number(env.CHECK_INTERVAL_MIN || 30);
const MAX_PER_REQUEST = 20;
const UP_URL = env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
const REMOTE = !!(UP_URL && UP_TOKEN);
const EPHEMERAL = !REMOTE && !!env.RENDER; // hébergeur gratuit qui efface les fichiers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('unhandledRejection', (e) => console.error('Erreur non gérée :', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('Exception :', e && e.message ? e.message : e));

/* ======================= Stockage : Upstash (permanent) ou fichiers ======================= */
async function rcmd(args) {
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

let db = { numbers: {}, daily: {} };
let settings = {};

async function loadState() {
  try {
    if (REMOTE) {
      const a = await rcmd(['GET', 'vw:db']);
      if (a) db = JSON.parse(a);
      const b = await rcmd(['GET', 'vw:settings']);
      if (b) settings = JSON.parse(b);
    } else {
      try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* premier démarrage */ }
      try { settings = JSON.parse(fs.readFileSync(SET_FILE, 'utf8')); } catch (e) { /* premier démarrage */ }
    }
  } catch (e) {
    console.error('Lecture du stockage impossible :', e.message);
  }
  db.numbers = db.numbers || {};
  db.daily = db.daily || {};
  if (!settings.secret) { settings.secret = crypto.randomBytes(32).toString('hex'); save(); }
}

let saveTimer = null;
export async function flush() {
  saveTimer = null;
  const d = JSON.stringify(db);
  const s = JSON.stringify(settings);
  try {
    if (REMOTE) {
      await rcmd(['SET', 'vw:db', d]);
      await rcmd(['SET', 'vw:settings', s]);
    } else {
      fs.writeFileSync(DB_FILE + '.tmp', d);
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
      fs.writeFileSync(SET_FILE + '.tmp', s);
      fs.renameSync(SET_FILE + '.tmp', SET_FILE);
    }
  } catch (e) { console.error('Sauvegarde impossible :', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 300); }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await flush(); process.exit(0); });

await loadState();

/* ======================= Outils ======================= */
const fmt = (ms) =>
  ms ? new Date(ms).toLocaleString('fr-FR', { timeZone: 'Africa/Libreville', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (heure du Gabon)' : '—';

function normalizePhone(input) {
  let s = String(input || '').replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

function addEvent(rec, type, t) {
  rec.events.push({ t, type });
  if (rec.events.length > 30) rec.events.shift();
}

/** Enregistre le résultat d'une vérification et détecte les changements. */
function record(number, exists, now = Date.now()) {
  let rec = db.numbers[number];
  if (!rec) {
    rec = db.numbers[number] = { number, firstChecked: now, lastChecked: now, status: null, lastActiveAt: null, unavailableSince: null, reactivatedAt: null, checks: 0, watch: false, events: [] };
  }
  const prev = rec.status;
  rec.checks++;
  rec.lastChecked = now;
  if (exists) {
    if (prev === 'inactive' && rec.lastActiveAt) { rec.reactivatedAt = now; addEvent(rec, 'back', now); }
    else if (prev === null) addEvent(rec, 'first_active', now);
    rec.status = 'active';
    rec.lastActiveAt = now;
    rec.unavailableSince = null;
  } else {
    if (prev === 'active') { rec.unavailableSince = now; rec.reactivatedAt = null; addEvent(rec, 'gone', now); }
    else if (prev === null) addEvent(rec, 'first_missing', now);
    rec.status = 'inactive';
  }
  save();
  return rec;
}

const EVENT_LABEL = {
  first_active: 'Premier contrôle : numéro actif',
  first_missing: 'Premier contrôle : numéro introuvable',
  gone: 'Numéro devenu indisponible (banni, supprimé ou désactivé)',
  back: 'Numéro de nouveau disponible',
};

function view(rec) {
  let state, headline;
  const lines = [];
  if (rec.status === 'active') {
    state = 'active';
    headline = '✅ Numéro toujours disponible sur WhatsApp';
    lines.push('Vérifié le : ' + fmt(rec.lastChecked));
    if (rec.reactivatedAt) lines.push('Redevenu disponible le : ' + fmt(rec.reactivatedAt));
  } else if (rec.lastActiveAt) {
    state = 'gone';
    headline = '🚫 Numéro plus disponible sur WhatsApp (banni, supprimé ou désactivé)';
    lines.push('Dernière fois vu actif : ' + fmt(rec.lastActiveAt));
    lines.push('Détecté indisponible le : ' + fmt(rec.unavailableSince));
    lines.push('Vérifié le : ' + fmt(rec.lastChecked));
    lines.push("WhatsApp ne dit pas la cause (banni, désinstallé ou supprimé) ni l'heure exacte : la date affichée est celle où ce site l'a constaté.");
  } else {
    state = 'notfound';
    headline = '❓ Numéro introuvable sur WhatsApp';
    lines.push('Jamais vu actif depuis le 1er contrôle du ' + fmt(rec.firstChecked) + ". Il n'est pas inscrit, ou il était déjà banni.");
    lines.push('Vérifié le : ' + fmt(rec.lastChecked));
  }
  return {
    number: rec.number, state, headline, lines, watch: !!rec.watch, checks: rec.checks,
    events: rec.events.slice(-6).reverse().map((e) => fmt(e.t) + ' — ' + EVENT_LABEL[e.type]),
  };
}

/* ======================= Connexion WhatsApp (Baileys) ======================= */
const wa = { status: 'disconnected', qr: null, qrReady: false, me: null, pairing: null };
let sock = null;
let starting = false;

async function clearAuth() {
  try {
    if (REMOTE) {
      const keys = await rcmd(['KEYS', 'vw:auth:*']);
      for (const k of keys || []) await rcmd(['DEL', k]);
    } else {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (e) { console.error('Effacement de la liaison impossible :', e.message); }
}

/** Sauvegarde de la liaison WhatsApp : fichiers, ou Upstash si configuré (survit aux redémarrages). */
async function makeAuthState(B) {
  const get = (k) => B[k] || (B.default && B.default[k]);
  if (!REMOTE) return await get('useMultiFileAuthState')(AUTH_DIR);
  const initAuthCreds = get('initAuthCreds');
  const BufferJSON = get('BufferJSON');
  const proto = get('proto');
  const P = 'vw:auth:';
  const read = async (k) => { const v = await rcmd(['GET', P + k]); return v ? JSON.parse(v, BufferJSON.reviver) : null; };
  const write = (k, d) => rcmd(['SET', P + k, JSON.stringify(d, BufferJSON.replacer)]);
  const del = (k) => rcmd(['DEL', P + k]);
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(type + '-' + id);
            if (type === 'app-state-sync-key' && v && proto) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const cat in data) for (const id in data[cat]) {
            const v = data[cat][id];
            tasks.push(v ? write(cat + '-' + id, v) : del(cat + '-' + id));
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

async function startWA() {
  if (starting) return;
  starting = true;
  if (DEMO) {
    // MODE DÉMO : pas de vrai WhatsApp. Fin en 0 = "introuvable". Fin en 9 = actif au 1er contrôle puis "banni".
    wa.status = 'connected';
    wa.me = 'DEMO';
    const seen9 = new Set();
    sock = {
      onWhatsApp: async (jid) => {
        const n = jid.split('@')[0];
        let exists = !n.endsWith('0');
        if (n.endsWith('9')) { exists = !seen9.has(n); seen9.add(n); }
        return [{ jid, exists }];
      },
      requestPairingCode: async () => 'DEMO1234',
    };
    wa.qrReady = true;
    return;
  }
  try {
    const B = await import('@whiskeysockets/baileys');
    const get = (k) => B[k] || (B.default && B.default[k]);
    const make = typeof B.default === 'function' ? B.default : (B.makeWASocket || (B.default && B.default.default));
    const pino = (await import('pino')).default;
    const QRCode = (await import('qrcode')).default;

    const { state, saveCreds } = await makeAuthState(B);
    let version;
    try { version = (await get('fetchLatestBaileysVersion')()).version; } catch (e) { /* version par défaut */ }

    wa.qrReady = false;
    wa.qr = null;
    wa.status = 'connecting';
    const s = make({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sock = s;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        wa.qrReady = true;
        try { wa.qr = await QRCode.toDataURL(qr); } catch (e) { /* ignore */ }
      }
      if (connection === 'connecting') wa.status = 'connecting';
      if (connection === 'open') {
        wa.status = 'connected';
        wa.qr = null;
        wa.pairing = null;
        wa.me = String((s.user && s.user.id) || '').split(':')[0].split('@')[0];
        console.log('WhatsApp connecté :', wa.me);
      }
      if (connection === 'close') {
        wa.status = 'disconnected';
        wa.qr = null;
        wa.qrReady = false;
        wa.pairing = null;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const DR = get('DisconnectReason') || {};
        if (code === DR.loggedOut) await clearAuth();
        starting = false;
        setTimeout(startWA, 3000);
      }
    });
  } catch (e) {
    console.error('Démarrage WhatsApp impossible :', e.message);
    wa.status = 'error';
    starting = false;
    setTimeout(startWA, 15000);
  }
}

async function requestPairing(phone) {
  if (wa.status === 'connected' && !DEMO) throw new Error('Déjà connecté à WhatsApp.');
  for (let i = 0; i < 40 && !wa.qrReady; i++) await sleep(500);
  if (!wa.qrReady || !sock) throw new Error('La connexion à WhatsApp n’est pas encore prête. Attends 10 secondes et réessaie.');
  const code = await sock.requestPairingCode(phone.replace('+', ''));
  wa.pairing = code;
  return code;
}

async function lookup(number) {
  if (wa.status !== 'connected' || !sock) throw new Error('Le WhatsApp du vérificateur n’est pas connecté.');
  const r = await sock.onWhatsApp(number.replace('+', '') + '@s.whatsapp.net');
  return !!(r && r[0] && r[0].exists);
}

/* ======================= Limites quotidiennes ======================= */
const today = () => new Date().toISOString().slice(0, 10);
function useQuota(n) {
  const day = today();
  db.daily = { [day]: db.daily[day] || 0 };
  if (db.daily[day] + n > DAILY_LIMIT) return false;
  db.daily[day] += n;
  save();
  return true;
}
const usedToday = () => db.daily[today()] || 0;

/* ======================= Surveillance automatique ======================= */
let watching = false;
async function watchLoop() {
  if (watching || wa.status !== 'connected') return;
  watching = true;
  try {
    for (const rec of Object.values(db.numbers)) {
      if (!rec.watch) continue;
      if (!useQuota(1)) break;
      try { record(rec.number, await lookup(rec.number)); } catch (e) { console.error('Surveillance :', e.message); break; }
      await sleep(DEMO ? 0 : 1500 + Math.random() * 2000);
    }
  } finally { watching = false; }
}
setInterval(watchLoop, WATCH_EVERY_MIN * 60 * 1000);

// Évite que l'hébergeur gratuit endorme le site (il s'endort après 15 min sans visite)
const SELF_URL = env.RENDER_EXTERNAL_URL || env.KEEPALIVE_URL;
if (SELF_URL && !DEMO) setInterval(() => fetch(SELF_URL + '/healthz').catch(() => {}), 10 * 60 * 1000);

/* ======================= Mot de passe & sessions ======================= */
const safeEq = (a, b) =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const hashPass = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
const passwordSet = () => !!(env.ADMIN_PASSWORD || settings.passHash);
function checkPass(p) {
  if (env.ADMIN_PASSWORD) return safeEq(p, env.ADMIN_PASSWORD);
  if (!settings.passHash) return false;
  return safeEq(hashPass(String(p), settings.salt), settings.passHash);
}
const hmac = (s) => crypto.createHmac('sha256', settings.secret).update(s).digest('base64url');
function makeSession() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + 30 * 86400000 })).toString('base64url');
  return body + '.' + hmac(body);
}
function getCookie(req, name) {
  for (const p of String((req.headers && req.headers.cookie) || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return null;
}
function authed(req) {
  const t = getCookie(req, 'vsess');
  if (!t) return false;
  const [body, sig] = t.split('.');
  if (!body || !sig) return false;
  const exp = hmac(body);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch (e) { return false; }
}
const cookie = (req, value, maxAge) =>
  'vsess=' + encodeURIComponent(value) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + (String(req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '');

/* ======================= Serveur web ======================= */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
const failures = new Map();

app.use((req, res, next) => {
  const p = req.path || String(req.url || '/').split('?')[0];
  if (p === '/healthz') return next();
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'verif') return res.status(403).json({ ok: false, message: 'Requête refusée.' });
  if (p === '/' || p === '/api/setup' || p === '/api/login') return next();
  if (!authed(req)) return res.status(401).json({ ok: false, auth: true, message: 'Connecte-toi.' });
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ ok: false, message: e.message || 'Erreur serveur.' });
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(!passwordSet() ? SETUP_PAGE : !authed(req) ? LOGIN_PAGE : MAIN_PAGE);
});

app.post('/api/setup', (req, res) => {
  if (passwordSet()) return res.status(403).json({ ok: false, message: 'Un mot de passe existe déjà.' });
  const p = String((req.body && req.body.password) || '');
  if (p.length < 6) return res.status(400).json({ ok: false, message: 'Le mot de passe doit faire au moins 6 caractères.' });
  settings.salt = crypto.randomBytes(16).toString('hex');
  settings.passHash = hashPass(p, settings.salt);
  save();
  res.set('Set-Cookie', cookie(req, makeSession(), 30 * 86400));
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const ip = ipOf(req);
  const f = failures.get(ip);
  if (f && f.n >= 8 && Date.now() - f.t < 10 * 60 * 1000) return res.status(429).json({ ok: false, message: 'Trop d’essais. Réessaie dans 10 minutes.' });
  if (!passwordSet()) return res.status(400).json({ ok: false, message: 'Aucun mot de passe défini.' });
  if (!checkPass((req.body && req.body.password) || '')) {
    failures.set(ip, { n: (f && Date.now() - f.t < 10 * 60 * 1000 ? f.n : 0) + 1, t: Date.now() });
    return res.status(401).json({ ok: false, message: 'Mot de passe incorrect.' });
  }
  failures.delete(ip);
  res.set('Set-Cookie', cookie(req, makeSession(), 30 * 86400));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', cookie(req, '', 0));
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ demo: DEMO, ephemeral: EPHEMERAL, status: wa.status, me: wa.me, qr: wa.qr, pairing: wa.pairing, usedToday: usedToday(), dailyLimit: DAILY_LIMIT });
});

app.post('/api/pair', wrap(async (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, message: 'Numéro invalide. Écris-le avec l’indicatif, ex : +241 07 12 34 56.' });
  const code = await requestPairing(phone);
  res.json({ ok: true, code });
}));

app.post('/api/check', wrap(async (req, res) => {
  const raw = Array.isArray(req.body && req.body.numbers) ? req.body.numbers : [];
  const watch = !!(req.body && req.body.watch);
  const numbers = [...new Set(raw.map(normalizePhone).filter(Boolean))];
  if (!numbers.length) return res.status(400).json({ ok: false, message: 'Aucun numéro valide. Utilise le format international, ex : +241 07 12 34 56.' });
  if (numbers.length > MAX_PER_REQUEST) return res.status(400).json({ ok: false, message: 'Maximum ' + MAX_PER_REQUEST + ' numéros à la fois.' });
  if (wa.status !== 'connected') return res.status(409).json({ ok: false, message: 'Le WhatsApp du vérificateur n’est pas connecté. Fais d’abord l’étape 1.' });
  if (!useQuota(numbers.length)) return res.status(429).json({ ok: false, message: 'Limite de ' + DAILY_LIMIT + ' vérifications par jour atteinte (elle protège ton numéro). Réessaie demain.' });

  const results = [];
  let warning = '';
  for (let i = 0; i < numbers.length; i++) {
    try {
      const rec = record(numbers[i], await lookup(numbers[i]));
      if (watch) { rec.watch = true; save(); }
      results.push(view(rec));
    } catch (e) {
      warning = 'WhatsApp a refusé la vérification (' + (e.message || 'erreur') + '). Les numéros restants n’ont pas été vérifiés : réessaie dans quelques minutes.';
      break;
    }
    if (i < numbers.length - 1) await sleep(DEMO ? 0 : 1200 + Math.random() * 1800);
  }
  if (!results.length) return res.status(502).json({ ok: false, message: warning });
  res.json({ ok: true, results, warning });
}));

app.get('/api/history', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ items: Object.values(db.numbers).sort((a, b) => b.lastChecked - a.lastChecked).map(view) });
});

app.post('/api/watch', (req, res) => {
  const n = normalizePhone(req.body && req.body.number);
  const rec = n && db.numbers[n];
  if (!rec) return res.status(404).json({ ok: false, message: 'Numéro inconnu.' });
  rec.watch = !!req.body.on;
  save();
  res.json({ ok: true, watch: rec.watch });
});

app.delete('/api/number', (req, res) => {
  const n = normalizePhone(req.body && req.body.number);
  if (n && db.numbers[n]) { delete db.numbers[n]; save(); }
  res.json({ ok: true });
});

/* ======================= Pages web ======================= */
const CSS = `
:root{--bg:#0b141a;--card:#111b21;--line:#233138;--text:#e9edef;--muted:#8696a0;--g:#25d366;--r:#ff5c5c;--o:#ffb020}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.5}
.wrap{max-width:760px;margin:0 auto;padding:16px 16px 60px}h1{font-size:24px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 10px}
.muted{color:var(--muted);font-size:14px}p{margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin:14px 0}
input,textarea{width:100%;background:#0b141a;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px;font:inherit;margin-bottom:10px}
input:focus,textarea:focus{outline:2px solid var(--g)}
.btn{background:var(--g);color:#06220f;border:0;border-radius:12px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer;width:100%}
.btn.small{width:auto;padding:6px 12px;font-size:13px}.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line);font-weight:500}
.btn:disabled{opacity:.5;cursor:not-allowed}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:600}
.b-ok{background:rgba(37,211,102,.15);color:var(--g)}.b-no{background:rgba(255,92,92,.15);color:var(--r)}.b-wait{background:rgba(255,176,32,.15);color:var(--o)}
.res{border-left:4px solid var(--line);padding:10px 12px;margin:10px 0;background:#0b141a;border-radius:10px}
.res.active{border-color:var(--g)}.res.gone{border-color:var(--r)}.res.notfound{border-color:var(--o)}
.res h3{margin:0 0 4px;font-size:15px}.res .num{font-family:ui-monospace,monospace;color:var(--muted);font-size:13px}
.res ul{margin:6px 0 0;padding-left:18px;font-size:13px;color:#c5d0d6}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.code{font-size:30px;letter-spacing:4px;font-weight:800;text-align:center;background:#0b141a;border:1px dashed var(--g);border-radius:12px;padding:12px;margin:10px 0}
.error{color:var(--r);font-size:14px}.hidden{display:none}
.note{background:rgba(255,176,32,.12);border:1px solid var(--o);color:var(--o);padding:8px 12px;border-radius:10px;font-size:13px;margin-bottom:10px}
label.chk{display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:10px}label.chk input{width:auto;margin:0}
img.qr{display:block;margin:10px auto;max-width:260px;background:#fff;padding:8px;border-radius:12px}
.top{display:flex;justify-content:space-between;align-items:center}
`;

const COMMON_JS = String.raw`
var H = { 'Content-Type': 'application/json', 'X-Requested-With': 'verif' };
function $(id) { return document.getElementById(id); }
function api(url, method, body) {
  return fetch(url, { method: method || 'GET', headers: H, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.auth) { location.reload(); } return d; });
}
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function setHidden(id, hide) { var e = $(id); var c = e.className.replace(/\s*hidden/g, ''); e.className = hide ? (c + ' hidden').trim() : c; }
`;

const head = (title) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body>`;

const SETUP_PAGE = head('Vérificateur WhatsApp') + `<div class="wrap">
<h1>🔎 Vérificateur de numéros WhatsApp</h1>
<div class="card"><h2>Bienvenue ! Crée ton mot de passe</h2>
<p class="muted">C'est ta première visite. Choisis un mot de passe (6 caractères minimum) : il protégera ton site. Garde-le bien.</p>
<input id="p1" type="password" placeholder="Mot de passe" autocomplete="new-password">
<input id="p2" type="password" placeholder="Confirme le mot de passe" autocomplete="new-password">
<button class="btn" id="go">Créer et entrer</button><p class="error" id="err"></p></div></div>
<script>${COMMON_JS}
$('go').onclick = function () {
  $('err').textContent = '';
  if ($('p1').value.length < 6) return ($('err').textContent = 'Au moins 6 caractères.');
  if ($('p1').value !== $('p2').value) return ($('err').textContent = 'Les deux mots de passe sont différents.');
  api('/api/setup', 'POST', { password: $('p1').value }).then(function (d) { if (d.ok) location.reload(); else $('err').textContent = d.message; });
};
</script></body></html>`;

const LOGIN_PAGE = head('Connexion') + `<div class="wrap">
<h1>🔎 Vérificateur de numéros WhatsApp</h1>
<div class="card"><h2>Connexion</h2>
<input id="p" type="password" placeholder="Mot de passe" autocomplete="current-password">
<button class="btn" id="go">Entrer</button><p class="error" id="err"></p></div></div>
<script>${COMMON_JS}
function login() { $('err').textContent = ''; api('/api/login', 'POST', { password: $('p').value }).then(function (d) { if (d.ok) location.reload(); else $('err').textContent = d.message; }); }
$('go').onclick = login;
$('p').onkeydown = function (e) { if (e.key === 'Enter') login(); };
</script></body></html>`;

const MAIN_PAGE = head('Vérificateur de numéros WhatsApp') + `<div class="wrap">
<div class="top"><h1>🔎 Vérificateur WhatsApp</h1><button class="btn small ghost" id="logout">Déconnexion</button></div>
<p class="muted">Vois si un numéro est toujours disponible, ou s'il a disparu (banni, supprimé), avec la date et l'heure.</p>
<div id="demo" class="note hidden">MODE DÉMO : résultats simulés. Numéro finissant par 0 = introuvable ; finissant par 9 = actif au 1er contrôle puis « banni » au suivant.</div>
<div id="eph" class="note hidden">Stockage temporaire : si le site redémarre, il faudra relier WhatsApp à nouveau et l'historique sera effacé. Pour tout garder, ajoute la base gratuite Upstash (voir le guide LISEZ-MOI).</div>

<section class="card">
  <h2>1. WhatsApp du vérificateur <span id="badge" class="badge b-wait">…</span></h2>
  <div id="connOk" class="hidden"><p class="muted">Connecté avec le numéro <strong id="me"></strong>. Vérifications aujourd'hui : <span id="quota"></span>.</p></div>
  <div id="connNo" class="hidden">
    <p class="muted">Utilise un numéro WhatsApp secondaire (pas ton numéro principal). Entre-le ici pour obtenir un code de liaison.</p>
    <input id="pairPhone" type="tel" inputmode="tel" placeholder="+241 07 12 34 56">
    <button class="btn" id="pairBtn">Obtenir le code de liaison</button>
    <div id="pairBox" class="hidden">
      <div class="code" id="pairCode"></div>
      <p class="muted">Sur ce téléphone, <strong>dans la minute</strong> : WhatsApp → ⋮ → Appareils connectés → Connecter un appareil → <strong>Associer avec le numéro de téléphone</strong> → tape ce code.</p>
    </div>
    <img id="qrImg" class="qr hidden" alt="QR code">
    <p class="error" id="pairErr"></p>
  </div>
</section>

<section class="card">
  <h2>2. Vérifier des numéros</h2>
  <textarea id="nums" rows="4" placeholder="Un numéro par ligne, avec l'indicatif&#10;+241 07 12 34 56&#10;+33 6 12 34 56 78"></textarea>
  <label class="chk"><input type="checkbox" id="watch"> Surveiller ces numéros (revérification automatique pour détecter quand ils disparaissent)</label>
  <button class="btn" id="checkBtn">Vérifier</button>
  <p class="error" id="checkErr"></p>
  <div id="results"></div>
</section>

<section class="card">
  <h2>3. Historique</h2>
  <div id="history"><p class="muted">Aucun numéro vérifié pour l'instant.</p></div>
</section>
<p class="muted">Note : le statut « spamé » n'existe pas côté WhatsApp et ne peut pas être détecté. Le site distingue seulement « disponible » et « introuvable / plus disponible ».</p>
</div>
<script>${COMMON_JS}
function card(r, withActions) {
  var d = el('div', 'res ' + r.state);
  d.appendChild(el('div', 'num', r.number));
  d.appendChild(el('h3', '', r.headline));
  var ul = el('ul');
  r.lines.forEach(function (l) { ul.appendChild(el('li', '', l)); });
  d.appendChild(ul);
  if (withActions) {
    if (r.events.length > 1) {
      var det = el('details'); det.appendChild(el('summary', 'muted', 'Historique (' + r.checks + ' contrôles)'));
      var u2 = el('ul'); r.events.forEach(function (l) { u2.appendChild(el('li', '', l)); }); det.appendChild(u2); d.appendChild(det);
    }
    var row = el('div', 'row');
    var w = el('button', 'btn small ghost', r.watch ? '👁 Surveillé (arrêter)' : '👁 Surveiller');
    w.onclick = function () { api('/api/watch', 'POST', { number: r.number, on: !r.watch }).then(loadHistory); };
    var re = el('button', 'btn small ghost', '↻ Revérifier');
    re.onclick = function () { $('nums').value = r.number; check(); };
    var x = el('button', 'btn small ghost', 'Supprimer');
    x.onclick = function () { if (confirm('Supprimer ce numéro et son historique ?')) api('/api/number', 'DELETE', { number: r.number }).then(loadHistory); };
    row.appendChild(w); row.appendChild(re); row.appendChild(x); d.appendChild(row);
  }
  return d;
}
function loadHistory() {
  api('/api/history').then(function (d) {
    var box = $('history'); box.innerHTML = '';
    if (!d.items || !d.items.length) { box.appendChild(el('p', 'muted', "Aucun numéro vérifié pour l'instant.")); return; }
    d.items.forEach(function (r) { box.appendChild(card(r, true)); });
  });
}
function refreshStatus() {
  api('/api/status').then(function (s) {
    if (!s || s.status === undefined) return;
    setHidden('demo', !s.demo); setHidden('eph', !s.ephemeral);
    var b = $('badge');
    if (s.status === 'connected') { b.textContent = 'Connecté'; b.className = 'badge b-ok'; }
    else if (s.status === 'connecting') { b.textContent = 'Connexion…'; b.className = 'badge b-wait'; }
    else { b.textContent = 'Non connecté'; b.className = 'badge b-no'; }
    setHidden('connOk', s.status !== 'connected'); setHidden('connNo', s.status === 'connected');
    $('me').textContent = s.me || ''; $('quota').textContent = s.usedToday + ' / ' + s.dailyLimit;
    if (s.pairing && s.status !== 'connected') { $('pairCode').textContent = s.pairing; setHidden('pairBox', false); } else if (s.status === 'connected') setHidden('pairBox', true);
    var q = $('qrImg'); if (s.qr && s.status !== 'connected') { q.src = s.qr; setHidden('qrImg', false); } else setHidden('qrImg', true);
  });
}
$('pairBtn').onclick = function () {
  $('pairErr').textContent = ''; $('pairBtn').disabled = true; $('pairBtn').textContent = 'Patiente…';
  api('/api/pair', 'POST', { phone: $('pairPhone').value }).then(function (d) {
    $('pairBtn').disabled = false; $('pairBtn').textContent = 'Obtenir le code de liaison';
    if (!d.ok) return ($('pairErr').textContent = d.message);
    $('pairCode').textContent = d.code; setHidden('pairBox', false);
  }).catch(function () { $('pairBtn').disabled = false; $('pairBtn').textContent = 'Obtenir le code de liaison'; $('pairErr').textContent = 'Erreur réseau, réessaie.'; });
};
function check() {
  $('checkErr').textContent = ''; $('results').innerHTML = '';
  var nums = $('nums').value.split(/[\\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  $('checkBtn').disabled = true; $('checkBtn').textContent = 'Vérification en cours…';
  api('/api/check', 'POST', { numbers: nums, watch: $('watch').checked }).then(function (d) {
    $('checkBtn').disabled = false; $('checkBtn').textContent = 'Vérifier';
    if (!d.ok) return ($('checkErr').textContent = d.message);
    d.results.forEach(function (r) { $('results').appendChild(card(r, false)); });
    if (d.warning) $('checkErr').textContent = d.warning;
    loadHistory();
  }).catch(function () { $('checkBtn').disabled = false; $('checkBtn').textContent = 'Vérifier'; $('checkErr').textContent = 'Erreur réseau.'; });
}
$('checkBtn').onclick = check;
$('logout').onclick = function () { api('/api/logout', 'POST').then(function () { location.reload(); }); };
refreshStatus(); loadHistory();
setInterval(refreshStatus, 4000);
</script></body></html>`;

app.listen(Number(env.PORT || 3000), () => console.log('Site prêt sur le port ' + (env.PORT || 3000) + (DEMO ? ' (MODE DÉMO)' : '') + (REMOTE ? ' (stockage Upstash)' : '')));
startWA();
