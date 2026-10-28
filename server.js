'use strict';
/* Gezinsplanner server
   - geen externe pakketten nodig (alleen Node 20+)
   - accounts per gezin (gezinscode + accountnaam + eigen code)
   - de server bepaalt rollen en controleert elke wijziging
   - gegevens delen via PUT/GET /api/state, direct doorgeven via SSE (/api/events)
   - bellen: de server geeft alleen de verbindingsberichten door (WebRTC), geen beeld of geluid */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
fs.mkdirSync(DATA, { recursive: true });

/* ---------- geheim voor tokens ---------- */
let SECRET = process.env.SECRET;
if (!SECRET) {
  const f = path.join(DATA, 'secret.key');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); }
  catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}

/* ---------- opslag (JSON-bestand, atomisch geschreven) ---------- */
const DBF = path.join(DATA, 'db.json');
let DB = { families: {} };
try { DB = JSON.parse(fs.readFileSync(DBF, 'utf8')); } catch { /* eerste keer */ }
let saveTimer = null;
const flush = () => { clearTimeout(saveTimer); saveTimer = null; const t = DBF + '.tmp'; fs.writeFileSync(t, JSON.stringify(DB)); fs.renameSync(t, DBF); };
const persist = () => { if (!saveTimer) saveTimer = setTimeout(flush, 250); };
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { try { flush(); } catch {} process.exit(0); });

/* ---------- hulpjes ---------- */
const rid = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => { let s = ''; for (let i = 0; i < 6; i++) s += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)]; return s; };
const key = (s) => String(s).trim().toLowerCase();
const fail = (code, error) => Object.assign(new Error(error), { code });
const ROLES = ['b', 'o', 'k', 'a', 'v'];
const famByCode = (c) => Object.values(DB.families).find((f) => f.code === String(c || '').trim().toUpperCase());
const uniqueCode = () => { let c; do c = genCode(); while (famByCode(c)); return c; };

const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (p) => { const body = b64(JSON.stringify(p)); return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); };
function verify(t) {
  const [body, sig] = String(t || '').split('.');
  if (!body || !sig) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const issue = (fam, u) => sign({ f: fam.id, u: u.id, tv: u.tv, exp: Date.now() + 60 * 864e5 });

async function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: (await scrypt(pw, salt, 32)).toString('hex') };
}
async function checkPw(u, pw) {
  const h = (await scrypt(String(pw), u.salt, 32));
  const a = Buffer.from(u.hash, 'hex');
  return a.length === h.length && crypto.timingSafeEqual(a, h);
}

/* ---------- beperken van pogingen ---------- */
const hits = new Map();
const recent = (k, win) => { const n = Date.now(); const a = (hits.get(k) || []).filter((t) => n - t < win); hits.set(k, a); return a; };
const blocked = (k, max, win = 15 * 60e3) => recent(k, win).length >= max;
const hit = (k, win = 15 * 60e3) => { const a = recent(k, win); a.push(Date.now()); hits.set(k, a); };
setInterval(() => { for (const k of hits.keys()) if (!recent(k, 36e5).length) hits.delete(k); }, 6e5).unref();
const ipOf = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

/* ---------- gegevens van een gezin ---------- */
const blank = (member) => ({ ev: [], li: { Boodschappen: [], Klusjes: [] }, ch: [], me: {}, mb: [member], nt: [], lg: [], ct: [], wl: [] });
const cleanName = (s, what = 'naam') => {
  const n = String(s || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 24) throw fail(400, `Kies een ${what} van 2 tot 24 tekens.`);
  return n;
};
const cleanColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#F28C28');
const cleanPw = (p, min) => {
  p = String(p || '');
  if (p.length < min || p.length > 72) throw fail(400, `Kies een code van minstens ${min} tekens.`);
  return p;
};
const newMid = () => 'u' + Date.now().toString(36) + rid(3);

/* ---------- rechten: wat mag welke rol aanpassen ---------- */
const ARR = ['ev', 'ch', 'nt', 'lg', 'ct', 'wl', 'st', 'rw', 'rq'];
const OBJ = ['li', 'me', 'bg'];
const eq = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => eq(a[k], b[k]));
};
function sanitize(fam, user, next) {
  const prev = fam.state, role = user.role, me = user.mid;
  const out = structuredClone(prev);
  const take = (k) => {
    if (next[k] === undefined) return;
    if (ARR.includes(k) && !Array.isArray(next[k])) return;
    if (OBJ.includes(k) && (typeof next[k] !== 'object' || !next[k] || Array.isArray(next[k]))) return;
    out[k] = structuredClone(next[k]);
  };
  const own = (k, f) => {
    const n = Array.isArray(next[k]) ? next[k] : [];
    out[k] = (prev[k] || []).filter((x) => x[f] !== me).concat(n.filter((x) => x && x[f] === me).map((x) => structuredClone(x)));
  };
  if (role === 'a') { take('ev'); take('nt'); }
  else if (role === 'o' || role === 'b') {
    ['ev', 'li', 'ch', 'me', 'nt', 'lg', 'ct', 'wl', 'st', 'rw', 'rq', 'bg'].forEach(take);
    if (role === 'b' && typeof next.wb === 'string') out.wb = next.wb.slice(0, 300);
  } else if (role === 'k') {
    ['ev', 'li', 'me', 'nt'].forEach(take);
    const nm = new Map((Array.isArray(next.ch) ? next.ch : []).map((c) => [c && c.id, c]));
    out.ch = (prev.ch || []).map((c) => { const n = nm.get(c.id); return n && c.w === me ? { ...c, x: n.x ? 1 : 0 } : c; });
    own('lg', 'w'); own('wl', 'o'); own('ct', 'o'); own('rq', 'w');
    const old = new Set((prev.rq || []).map((r) => r.id));
    out.rq = out.rq.map((r) => (r.w === me && !old.has(r.id) ? { ...r, st: 'open' } : r));
  }
  /* gezinsleden: alleen een beheerder mag leden en rollen aanpassen */
  const nmb = Array.isArray(next.mb) ? next.mb : null;
  if (role === 'b' && nmb) {
    const clean = nmb.filter((m) => m && typeof m.id === 'string' && typeof m.n === 'string')
      .map((m) => { const x = { ...m }; delete x.pin; delete x.acc; if (!ROLES.includes(x.r)) x.r = 'k'; return structuredClone(x); });
    if (!clean.some((m) => m.id === me)) clean.push(structuredClone(prev.mb.find((m) => m.id === me)));
    if (!clean.some((m) => m.r === 'b')) clean.find((m) => m.id === me).r = 'b';
    out.mb = clean;
  } else {
    out.mb = (prev.mb || []).map((m) => {
      if (m.id !== me) return m;
      const n = (nmb || []).find((x) => x && x.id === me) || {};
      const o = { ...m };
      for (const f of ['av', 'bg']) if (n[f] !== undefined) o[f] = n[f];
      return o;
    });
  }
  out.mb.forEach((m) => { delete m.pin; delete m.acc; });
  delete out.ic;
  return out;
}

/* wat een gebruiker te zien krijgt (met uitnodigingscode voor de beheerder en een slotje bij leden met account) */
function view(fam, user) {
  const s = structuredClone(fam.state);
  const withAcc = new Set(Object.values(fam.users).map((u) => u.mid));
  s.mb.forEach((m) => { if (withAcc.has(m.id)) m.acc = true; });
  if (user.role === 'b') s.ic = fam.code;
  return s;
}
const publicUser = (u) => ({ id: u.id, name: u.name, mid: u.mid, role: u.role });

/* ---------- live verbindingen (SSE) ---------- */
const conns = new Map(); // cid -> { res, fid, uid, mid }
const sse = (res, ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
const toFamily = (fid, ev, data, exceptCid) => { for (const [cid, c] of conns) if (c.fid === fid && cid !== exceptCid) sse(c.res, ev, data); };
const peersOf = (fid) => [...conns].filter(([, c]) => c.fid === fid).map(([cid, c]) => ({ peer: cid, mid: c.mid }));
const pushPeers = (fid) => toFamily(fid, 'peers', peersOf(fid));
const dropUser = (fid, uid) => { for (const [cid, c] of conns) if (c.fid === fid && c.uid === uid) { try { c.res.end(); } catch {} conns.delete(cid); } pushPeers(fid); };

/* ---------- ICE-servers voor bellen ---------- */
function iceServers(user) {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${user.id}`;
    list.push({ urls: process.env.TURN_URL.split(','), username, credential: crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64') });
  }
  return list;
}

/* ---------- verzoeken ---------- */
const readBody = (req, max = 262144) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', (d) => { n += d.length; if (n > max) { no(fail(413, 'Dat is te groot.')); req.destroy(); } else c.push(d); });
  req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch { no(fail(400, 'Ongeldig verzoek.')); } });
  req.on('error', no);
});
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };

function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const p = m && verify(m[1]);
  const fam = p && DB.families[p.f];
  const user = fam && fam.users[p.u];
  if (!user || user.tv !== p.tv) throw fail(401, 'Je bent niet meer ingelogd. Log opnieuw in.');
  return { fam, user };
}
const session = (fam, user) => ({ token: issue(fam, user), user: publicUser(user), family: { name: fam.name } });

async function api(req, res, url) {
  const r = req.method + ' ' + url.pathname;
  const ip = ipOf(req);

  if (r === 'GET /api/health') return json(res, 200, { ok: true });

  if (r === 'POST /api/family') {
    if (blocked('fam:' + ip, 5, 36e5)) throw fail(429, 'Te veel pogingen. Probeer het later opnieuw.');
    hit('fam:' + ip, 36e5);
    const b = await readBody(req);
    const familyName = cleanName(b.familyName, 'gezinsnaam'), name = cleanName(b.name), pw = cleanPw(b.password, 8);
    const id = rid(10), uid = rid(10), mid = newMid();
    const fam = { id, name: familyName, code: uniqueCode(), rev: 1, created: Date.now(), users: {}, state: null };
    fam.state = blank({ id: mid, n: name, c: cleanColor(b.color), r: 'b' });
    fam.users[uid] = { id: uid, name, key: key(name), role: 'b', mid, tv: 1, ...(await hashPw(pw)) };
    DB.families[id] = fam; persist();
    return json(res, 201, session(fam, fam.users[uid]));
  }

  if (r === 'POST /api/join') {
    if (blocked('join:' + ip, 20, 36e5)) throw fail(429, 'Te veel pogingen. Probeer het later opnieuw.');
    hit('join:' + ip, 36e5);
    const b = await readBody(req);
    const fam = famByCode(b.code);
    if (!fam) throw fail(404, 'Die uitnodigingscode klopt niet.');
    const name = cleanName(b.name), pw = cleanPw(b.password, 4);
    if (Object.values(fam.users).some((u) => u.key === key(name))) throw fail(409, 'Die naam is al in gebruik in dit gezin. Kies een andere naam of log in.');
    const uid = rid(10), mid = newMid();
    fam.users[uid] = { id: uid, name, key: key(name), role: 'k', mid, tv: 1, ...(await hashPw(pw)) };
    fam.state.mb.push({ id: mid, n: name, c: cleanColor(b.color), r: 'k' });
    fam.rev++; persist();
    toFamily(fam.id, 'state', { rev: fam.rev });
    return json(res, 201, session(fam, fam.users[uid]));
  }

  if (r === 'POST /api/login') {
    const b = await readBody(req);
    const code = String(b.code || '').trim().toUpperCase(), nk = key(b.name || '');
    const ka = 'acct:' + code + ':' + nk, ki = 'ip:' + ip;
    if (blocked(ka, 8) || blocked(ki, 30)) throw fail(429, 'Te veel foute pogingen. Wacht even en probeer het later opnieuw.');
    const fam = famByCode(code);
    const user = fam && Object.values(fam.users).find((u) => u.key === nk);
    const ok = user && await checkPw(user, b.password || '');
    if (!ok) { hit(ka); hit(ki); throw fail(401, 'Gezinscode, naam of code klopt niet.'); }
    return json(res, 200, session(fam, user));
  }

  /* vanaf hier: ingelogd */
  const { fam, user } = auth(req);

  if (r === 'GET /api/me') return json(res, 200, { user: publicUser(user), family: { name: fam.name } });
  if (r === 'GET /api/ice') return json(res, 200, { iceServers: iceServers(user) });
  if (r === 'GET /api/state') return json(res, 200, { rev: fam.rev, state: view(fam, user) });

  if (r === 'PUT /api/state') {
    if (user.role === 'v') throw fail(403, 'Met jouw rol kun je alleen kijken.');
    const b = await readBody(req, 1.5e6);
    if (!b.state || typeof b.state !== 'object') throw fail(400, 'Ongeldig verzoek.');
    const next = sanitize(fam, user, b.state);
    const submitted = structuredClone(b.state); delete submitted.ic;
    submitted.mb = (submitted.mb || []).map((m) => { const x = { ...m }; delete x.acc; delete x.pin; return x; });
    const changed = !eq(next, submitted);
    if (!eq(next, fam.state)) {
      fam.state = next;
      /* accounts volgen de gezinsleden: rol overnemen, verwijderde leden loggen uit */
      for (const u of Object.values(fam.users)) {
        const m = next.mb.find((x) => x.id === u.mid);
        if (!m) { delete fam.users[u.id]; dropUser(fam.id, u.id); }
        else if (m.r !== u.role) { u.role = m.r; u.tv++; }
      }
      fam.rev++; persist();
      toFamily(fam.id, 'state', { rev: fam.rev }, req.headers['x-client']);
    }
    return json(res, 200, changed ? { rev: fam.rev, changed: true, state: view(fam, user) } : { rev: fam.rev });
  }

  if (r === 'GET /api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const cid = rid(10);
    conns.set(cid, { res, fid: fam.id, uid: user.id, mid: user.mid });
    sse(res, 'hello', { cid, rev: fam.rev });
    pushPeers(fam.id);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(hb); conns.delete(cid); pushPeers(fam.id); });
    return;
  }

  if (r === 'POST /api/signal') {
    const b = await readBody(req, 16384);
    const from = req.headers['x-client'], me = conns.get(from);
    const to = conns.get(b.to);
    if (!me || me.uid !== user.id) throw fail(409, 'Geen verbinding met de server.');
    if (!to || to.fid !== fam.id) throw fail(404, 'Die persoon is niet meer online.');
    sse(to.res, 'sig', { from, mid: user.mid, data: b.data });
    return json(res, 200, { ok: true });
  }

  if (r === 'POST /api/password') {
    const b = await readBody(req);
    if (!(await checkPw(user, b.old || ''))) throw fail(403, 'Je huidige code klopt niet.');
    Object.assign(user, await hashPw(cleanPw(b.password, user.role === 'b' ? 8 : 4)));
    user.tv++; persist();
    return json(res, 200, session(fam, user)); // nieuwe token; andere toestellen loggen uit
  }

  if (r === 'POST /api/reset') {
    const b = await readBody(req);
    const t = Object.values(fam.users).find((u) => u.mid === b.mid);
    if (!t) throw fail(404, 'Dit gezinslid heeft geen account.');
    const allowed = user.role === 'b' || (user.role === 'o' && ['k', 'a', 'v'].includes(t.role));
    if (!allowed || t.id === user.id) throw fail(403, 'Dat mag je niet doen met jouw rol.');
    Object.assign(t, await hashPw(cleanPw(b.password, 4)));
    t.tv++; persist(); dropUser(fam.id, t.id);
    return json(res, 200, { ok: true });
  }

  if (r === 'POST /api/newcode') {
    if (user.role !== 'b') throw fail(403, 'Alleen een beheerder kan dit.');
    fam.code = uniqueCode(); persist();
    return json(res, 200, { code: fam.code });
  }

  if (r === 'GET /api/export') {
    if (user.role !== 'b') throw fail(403, 'Alleen een beheerder kan dit.');
    return json(res, 200, { family: fam.name, exported: new Date().toISOString(), accounts: Object.values(fam.users).map(publicUser), state: view(fam, user) });
  }

  if (r === 'POST /api/delete-family') {
    if (user.role !== 'b') throw fail(403, 'Alleen een beheerder kan dit.');
    const b = await readBody(req);
    if (!(await checkPw(user, b.password || ''))) throw fail(403, 'Je code klopt niet.');
    for (const u of Object.values(fam.users)) dropUser(fam.id, u.id);
    delete DB.families[fam.id]; persist();
    return json(res, 200, { ok: true });
  }

  throw fail(404, 'Onbekend adres.');
}

/* ---------- bestanden van de app ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(PUB, p));
  if (f !== PUB && !f.startsWith(PUB + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Niet gevonden'); return; }
    const ext = path.extname(f);
    const cc = ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cc });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error(e);
    json(res, code, { error: code === 500 ? 'Er ging iets mis op de server.' : e.message });
  }
});
server.requestTimeout = 0;

module.exports = server;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Gezinsplanner draait op http://localhost:${PORT}`));
}
