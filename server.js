const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = __dirname;
const dataFile = process.env.DATA_FILE || path.join(root, 'taxi-data.json');
const backupDir = process.env.BACKUP_DIR || path.join(root, 'backups');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const adminPhone = process.env.ADMIN_PHONE || '2223334444';
const adminPassword = process.env.ADMIN_PASSWORD || '1234';
const appSecret = process.env.APP_SECRET || 'local-dev-change-me';
const databaseUrl = process.env.DATABASE_URL || '';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png' };
const defaultSettings = { baseFare: 6, perMile: 2.25, bookingFee: 1.5, minimumFare: 10, driverCommission: 80 };

let pgPool = null;
if (databaseUrl) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  } catch (error) {
    console.warn('DATABASE_URL is set but pg is not installed. Falling back to file storage.');
  }
}

function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }
function nowLabel() { return new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function normalizePhone(value) { return String(value || '').replace(/\D/g, ''); }
function hashPassword(password) {
  const iterations = 210000;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterationText, salt, expected] = stored.split('$');
  const actual = crypto.pbkdf2Sync(String(password), salt, Number(iterationText), 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function signToken(user) {
  const payload = Buffer.from(JSON.stringify({ userId: user.id, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString('base64url');
  const sig = crypto.createHmac('sha256', appSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!parsed.exp || parsed.exp < Date.now()) return null;
  return parsed;
}
function userPublic(user) { return { id: user.id, role: user.role, name: user.name, phone: user.phone, vehicle: user.vehicle || '', online: Boolean(user.online), driverLocation: user.driverLocation || null, createdAt: user.createdAt || '' }; }
function sanitizeData(data) { return { users: data.users.map(userPublic), rides: data.rides, supportTickets: data.supportTickets, settings: data.settings }; }
function normalizeData(data) {
  const clean = {
    users: Array.isArray(data.users) ? data.users : [],
    rides: Array.isArray(data.rides) ? data.rides : [],
    supportTickets: Array.isArray(data.supportTickets) ? data.supportTickets : [],
    settings: Object.assign({}, defaultSettings, data.settings || {})
  };
  clean.users = clean.users.map(user => {
    const next = Object.assign({}, user);
    if (!next.passwordHash && next.password) next.passwordHash = hashPassword(next.password);
    delete next.password;
    next.phone = normalizePhone(next.phone);
    next.online = Boolean(next.online);
    return next;
  });
  const existingAdmin = clean.users.find(user => user.role === 'admin' && user.phone === adminPhone);
  if (!existingAdmin) clean.users.unshift({ id: 'admin-main', role: 'admin', name: 'Admin', phone: adminPhone, passwordHash: hashPassword(adminPassword), vehicle: '', online: false, createdAt: 'system' });
  return clean;
}
async function ensurePg() {
  if (!pgPool) return false;
  await pgPool.query('CREATE TABLE IF NOT EXISTS app_state (id text primary key, data jsonb not null, updated_at timestamptz not null default now())');
  return true;
}
async function readData() {
  if (await ensurePg()) {
    const result = await pgPool.query('SELECT data FROM app_state WHERE id = $1', ['main']);
    if (result.rows[0]) return normalizeData(result.rows[0].data);
  }
  try { return normalizeData(JSON.parse(fs.readFileSync(dataFile, 'utf8'))); } catch (error) { return normalizeData({ users: [], rides: [], supportTickets: [], settings: defaultSettings }); }
}
async function writeData(data) {
  const clean = normalizeData(data || {});
  if (await ensurePg()) await pgPool.query('INSERT INTO app_state (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()', ['main', clean]);
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(clean, null, 2));
  return clean;
}
async function backupData() {
  const data = await readData();
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `taxi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
function authFromReq(req) { const header = req.headers.authorization || ''; return verifyToken(header.startsWith('Bearer ') ? header.slice(7) : ''); }
function sendJson(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2000000) reject(new Error('Request body too large')); });
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}
async function requireUser(req, res) {
  const token = authFromReq(req);
  if (!token) { sendJson(res, 401, { error: 'Sign in required' }); return null; }
  const data = await readData();
  const user = data.users.find(candidate => candidate.id === token.userId);
  if (!user) { sendJson(res, 401, { error: 'User not found' }); return null; }
  return { user, data };
}
async function handleApi(req, res) {
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (url.pathname === '/api/auth/signin' && req.method === 'POST') {
    const body = await readBody(req);
    const data = await readData();
    const phone = normalizePhone(body.phone);
    const user = data.users.find(candidate => candidate.role === body.role && candidate.phone === phone);
    if (!user || !verifyPassword(body.password, user.passwordHash)) return sendJson(res, 401, { error: 'Invalid phone or password' });
    return sendJson(res, 200, { token: signToken(user), user: userPublic(user), state: sanitizeData(data) });
  }
  if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
    const body = await readBody(req);
    if (!['passenger', 'driver'].includes(body.role)) return sendJson(res, 400, { error: 'Invalid account type' });
    const phone = normalizePhone(body.phone);
    const data = await readData();
    if (data.users.some(user => user.role === body.role && user.phone === phone)) return sendJson(res, 409, { error: 'Account already exists' });
    const user = { id: uid('user'), role: body.role, name: String(body.name || '').trim(), phone, passwordHash: hashPassword(body.password), vehicle: String(body.vehicle || '').trim(), online: false, createdAt: nowLabel() };
    data.users.push(user);
    await writeData(data);
    return sendJson(res, 201, { token: signToken(user), user: userPublic(user), state: sanitizeData(data) });
  }
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const auth = await requireUser(req, res); if (!auth) return;
    return sendJson(res, 200, sanitizeData(auth.data));
  }
  if (url.pathname === '/api/state' && req.method === 'PUT') {
    const auth = await requireUser(req, res); if (!auth) return;
    const incoming = await readBody(req);
    const byId = new Map(auth.data.users.map(user => [user.id, user]));
    const mergedUsers = (incoming.users || []).map(publicUser => Object.assign({}, byId.get(publicUser.id) || {}, publicUser));
    auth.data.users = mergedUsers.length ? mergedUsers : auth.data.users;
    auth.data.rides = Array.isArray(incoming.rides) ? incoming.rides : auth.data.rides;
    auth.data.supportTickets = Array.isArray(incoming.supportTickets) ? incoming.supportTickets : auth.data.supportTickets;
    auth.data.settings = auth.user.role === 'admin' ? Object.assign({}, defaultSettings, incoming.settings || auth.data.settings) : auth.data.settings;
    const saved = await writeData(auth.data);
    return sendJson(res, 200, sanitizeData(saved));
  }
  if (url.pathname === '/api/backup' && req.method === 'POST') {
    const auth = await requireUser(req, res); if (!auth) return;
    if (auth.user.role !== 'admin') return sendJson(res, 403, { error: 'Admin only' });
    const file = await backupData();
    return sendJson(res, 200, { ok: true, file });
  }
  return sendJson(res, 404, { error: 'Not found' });
}
function sendStatic(req, res) {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(root, requested);
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (error, fileData) => { if (error) { res.writeHead(404); res.end('Not found'); return; } res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' }); res.end(fileData); });
}
function localUrls() {
  const urls = ['http://127.0.0.1:' + port + '/'];
  for (const details of Object.values(os.networkInterfaces())) for (const item of details || []) if (item.family === 'IPv4' && !item.internal) urls.push('http://' + item.address + ':' + port + '/');
  return urls;
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') return sendJson(res, 200, { ok: true, storage: pgPool ? 'postgres' : 'file' });
    if (req.url.startsWith('/api/')) return handleApi(req, res);
    return sendStatic(req, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'Server error' });
  }
});
(async () => {
  await writeData(await readData());
  server.listen(port, host, () => {
    console.log('Taxi App running. Open one of these URLs:');
    localUrls().forEach(url => console.log('  ' + url));
  });
})();

