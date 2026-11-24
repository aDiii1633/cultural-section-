// Cultural Section — website + dedicated form page + admin panel. Node stdlib only.
// Run: node server.js   (env: PORT, ADMIN_PASSWORD for the first owner account)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_PASSWORD = 'cultural123';
const PUB = path.join(__dirname, 'public');
const UPLOADS = path.join(PUB, 'uploads');
const DB_FILE = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

// Permissions an admin account can hold. The UI offers role presets built from these.
const PERMS = ['forms', 'responses', 'connections', 'news', 'photos', 'users'];

// ---------- password hashing ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  const h = crypto.scryptSync(String(pw), user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
}

// ---------- storage ----------
// ponytail: whole-file JSON store rewritten on every change; move to SQLite if responses reach tens of thousands.
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : seed();
function save() {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}
function seed() {
  const q = (label, type, required, options = [], help = '') => ({ id: uid(), label, type, required, options, help });
  const form = {
    id: uid(), exportKey: crypto.randomBytes(16).toString('hex'), createdAt: now(), active: true,
    title: 'Join the Cultural Section',
    description: 'Cultural Section is the home of music, dance, drama, poetry and art on campus. We run open mics, rehearsals, fests and farewells — and we are always looking for new voices. This takes about 2 minutes.',
    thanks: 'Welcome aboard! The Cultural Section team will reach out to you soon.',
    sheetWebhook: '', sheetStatus: null,
    fields: [
      q('What is your full name?', 'text', true),
      q('Your email address', 'email', true, [], 'We will send club updates here.'),
      q('Your phone / WhatsApp number', 'tel', true),
      q('Which programme are you in?', 'radio', true, ['BBA', 'BSc-CSDA', 'MBA', 'M.Tech', 'Other']),
      q('Which year are you in?', 'radio', true, ['1st year', '2nd year', '3rd year', '4th year']),
      q('What do you want to do with us?', 'checkbox', true, ['Music / Singing', 'Instruments', 'Dance', 'Drama / Theatre', 'Poetry / Shayari', 'Anchoring', 'Art & Design', 'Photography / Video', 'Event management'], 'Pick as many as you like.'),
      q('How much stage experience do you have?', 'radio', true, ['Never performed yet', 'A few times', 'Regular performer']),
      q('Tell us about yourself or something you have performed', 'textarea', false, [], 'Links to videos or posts are welcome.'),
    ],
  };
  const photo = (file, caption) => ({ id: uid(), src: `img/${file}`, caption });
  return {
    users: [], forms: [form], responses: {},
    announcements: [{ id: uid(), title: 'Sayonara — Farewell Party 2K26', body: 'Thank you to every performer, volunteer and graduating student who made the farewell unforgettable.', date: today() }],
    photos: [
      photo('farewell-2k26.webp', 'Sayonara — Farewell Party 2K26'),
      photo('music-guitar.webp', 'Open mic — acoustic set'),
      photo('poetry-recital.webp', 'Poetry recital'),
      photo('award-1.webp', 'Recognition night'),
      photo('drama-rehearsal.webp', 'Drama script reading'),
      photo('award-2.webp', 'Token of appreciation'),
    ],
  };
}
// First run (or older data): make sure an owner account exists.
db.users ||= [];
if (!db.users.length) {
  db.users.push({ id: uid(), name: 'Owner', username: 'admin', ...hashPassword(process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD), perms: [...PERMS] });
  console.log('Created owner account "admin" (password from ADMIN_PASSWORD, or the default in README).');
}
save();

const sessions = new Map(); // token -> user id. ponytail: in-memory, everyone logs in again after a restart.

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const drop = (arr, id) => {
  const i = arr.findIndex(x => x.id === id);
  if (i < 0) throw new HttpError(404, 'Not found');
  return arr.splice(i, 1)[0];
};
const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readJson(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, 'Upload too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(new HttpError(400, 'Bad request')); }
    });
    req.on('error', reject);
  });
}

// ---------- forms ----------
const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'date', 'textarea', 'select', 'radio', 'checkbox'];
const CHOICE_TYPES = ['select', 'radio', 'checkbox'];

function cleanForm(b, old = {}) {
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Form needs a title');
  const fields = (Array.isArray(b.fields) ? b.fields : []).slice(0, 60).map(f => {
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const label = str(f.label, 300);
    if (!label) throw new HttpError(400, 'Every question needs a label');
    const raw = Array.isArray(f.options) ? f.options : String(f.options || '').split(',');
    const options = CHOICE_TYPES.includes(type) ? [...new Set(raw.map(o => str(o, 200)).filter(Boolean))] : [];
    if ((type === 'select' || type === 'radio') && !options.length) throw new HttpError(400, `"${label}" needs options`);
    return { id: /^[a-f0-9]{12}$/.test(f.id) ? f.id : uid(), label, type, required: !!f.required, options, help: str(f.help, 300) };
  });
  if (!fields.length) throw new HttpError(400, 'Add at least one question');
  return {
    id: old.id || uid(),
    exportKey: old.exportKey || crypto.randomBytes(16).toString('hex'),
    createdAt: old.createdAt || now(),
    sheetWebhook: old.sheetWebhook || '', sheetStatus: old.sheetStatus || null,
    title, description: str(b.description, 3000), thanks: str(b.thanks, 500), active: b.active !== false, fields,
  };
}

function cleanSubmission(form, data = {}) {
  const out = {};
  for (const f of form.fields) {
    let v = data[f.id];
    if (f.type === 'checkbox') {
      v = f.options.length
        ? (Array.isArray(v) ? v.map(String).filter(o => f.options.includes(o)).join(', ') : '')
        : (v === true ? 'Yes' : '');
    } else v = str(v);
    if (f.required && !v) throw new HttpError(400, `"${f.label}" is required`);
    if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, `"${f.label}" must be a valid email`);
    if (v && f.type === 'number' && !Number.isFinite(Number(v))) throw new HttpError(400, `"${f.label}" must be a number`);
    if (v && (f.type === 'select' || f.type === 'radio') && !f.options.includes(v)) throw new HttpError(400, `Pick a valid option for "${f.label}"`);
    out[f.id] = v;
  }
  return out;
}

// Spreadsheet-safe cell: stop formula injection, but leave plain numbers/phones like +91 98765 alone.
const sheetCell = v => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s) ? "'" + s : s;
};
const headersOf = form => ['Submitted at', ...form.fields.map(f => f.label)];
const rowOf = (form, r) => [r.at.replace('T', ' ').slice(0, 19), ...form.fields.map(f => r.data[f.id] ?? '')].map(sheetCell);

function toCsv(form) {
  const rows = [headersOf(form), ...(db.responses[form.id] || []).map(r => rowOf(form, r))];
  return '﻿' + rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
}

// Push rows to a Google Apps Script web app (see admin → Connections for the script).
async function pushToSheet(formId, responses) {
  const form = db.forms.find(f => f.id === formId);
  if (!form?.sheetWebhook) return null;
  let status;
  try {
    const res = await fetch(form.sheetWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form: form.title, headers: headersOf(form), rows: responses.map(r => rowOf(form, r)) }),
      signal: AbortSignal.timeout(20000),
    });
    const text = (await res.text()).trim();
    if (!res.ok || text !== 'ok') throw new Error('Script did not reply "ok" — check it is deployed with access "Anyone"');
    status = { ok: true, at: now(), msg: responses.length ? `Sent ${responses.length} row(s)` : 'Connected — header row sent' };
  } catch (e) {
    status = { ok: false, at: now(), msg: e.name === 'TimeoutError' ? 'Google did not answer in time' : e.message };
  }
  const live = db.forms.find(f => f.id === formId);
  if (live) { live.sheetStatus = status; save(); }
  return status;
}

// ---------- routes ----------
const publicForm = ({ exportKey, sheetWebhook, sheetStatus, ...f }) => f;

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname, m = req.method;
  let match;

  if (p === '/api/site' && m === 'GET') {
    return json(res, 200, {
      announcements: db.announcements, photos: db.photos,
      forms: db.forms.filter(f => f.active).map(f => ({ ...publicForm(f), fields: undefined, questions: f.fields.length })),
    });
  }
  if ((match = p.match(/^\/api\/forms\/([a-f0-9]{12})$/)) && m === 'GET') {
    const form = db.forms.find(f => f.id === match[1] && f.active);
    if (!form) throw new HttpError(404, 'This form is closed or does not exist');
    return json(res, 200, publicForm(form));
  }
  if ((match = p.match(/^\/api\/forms\/([a-f0-9]{12})\/submit$/)) && m === 'POST') {
    const form = db.forms.find(f => f.id === match[1] && f.active);
    if (!form) throw new HttpError(404, 'This form is closed');
    const data = cleanSubmission(form, await readJson(req, 2e5));
    const row = { id: uid(), at: now(), data };
    (db.responses[form.id] ||= []).push(row);
    save();
    pushToSheet(form.id, [row]); // fire and forget; status shows in admin → Connections
    return json(res, 200, { ok: true });
  }

  // Live CSV link — Excel (Data → From Web) and Google Sheets (=IMPORTDATA).
  if ((match = p.match(/^\/export\/([a-f0-9]{12})\.csv$/)) && m === 'GET') {
    const form = db.forms.find(f => f.id === match[1]);
    if (!form || !safeEq(url.searchParams.get('key') || '', form.exportKey)) throw new HttpError(404, 'Not found');
    const name = form.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'responses';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'no-store' });
    return res.end(toCsv(form));
  }

  if (p === '/api/admin/login' && m === 'POST') {
    const { username, password } = await readJson(req);
    const user = db.users.find(u => u.username === str(username, 60).toLowerCase());
    if (!user || !checkPassword(user, password || '')) {
      await new Promise(r => setTimeout(r, 800)); // slow down guessing
      throw new HttpError(401, 'Wrong username or password');
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, user.id);
    return json(res, 200, { token });
  }

  if (p.startsWith('/api/admin/')) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = db.users.find(u => u.id === sessions.get(token));
    if (!user) throw new HttpError(401, 'Please log in again');
    return admin(req, res, p, m, user, token);
  }

  if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  return serveStatic(res, p);
}

function need(user, perm) {
  if (!user.perms.includes(perm)) throw new HttpError(403, 'Your role does not allow this');
}
const safeUser = u => ({ id: u.id, name: u.name, username: u.username, perms: u.perms });
const owners = () => db.users.filter(u => u.perms.includes('users'));

function cleanUser(b, old) {
  const name = str(b.name, 80);
  const username = str(b.username, 40).toLowerCase();
  if (!name) throw new HttpError(400, 'Name is required');
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username: 3–40 letters, numbers, dot, dash or underscore');
  if (db.users.some(u => u.username === username && u.id !== old?.id)) throw new HttpError(400, 'That username is taken');
  const perms = PERMS.filter(x => Array.isArray(b.perms) && b.perms.includes(x));
  if (!perms.length) throw new HttpError(400, 'Give at least one permission');
  const user = { ...(old || { id: uid() }), name, username, perms };
  if (b.password || !old) {
    if (String(b.password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    Object.assign(user, hashPassword(String(b.password)));
  }
  return user;
}

async function admin(req, res, p, m, user, token) {
  let match;
  const ok = () => json(res, 200, { ok: true });

  if (p === '/api/admin/logout' && m === 'POST') { sessions.delete(token); return ok(); }

  if (p === '/api/admin/state' && m === 'GET') {
    const canData = user.perms.includes('responses'), canConn = user.perms.includes('connections');
    return json(res, 200, {
      me: { ...safeUser(user), defaultPassword: checkPassword(user, DEFAULT_PASSWORD) },
      perms: PERMS,
      announcements: db.announcements, photos: db.photos,
      forms: db.forms.map(f => ({
        ...publicForm(f),
        exportKey: canData || canConn ? f.exportKey : undefined,
        sheetWebhook: canConn ? f.sheetWebhook : undefined,
        sheetStatus: canConn ? f.sheetStatus : undefined,
      })),
      counts: Object.fromEntries(db.forms.map(f => [f.id, (db.responses[f.id] || []).length])),
    });
  }

  if (p === '/api/admin/me/password' && m === 'POST') {
    const b = await readJson(req);
    if (!checkPassword(user, b.current || '')) throw new HttpError(400, 'Current password is wrong');
    if (String(b.password || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    Object.assign(user, hashPassword(String(b.password)));
    save(); return ok();
  }

  // --- announcements ---
  if (p === '/api/admin/announcements' && m === 'POST') {
    need(user, 'news');
    const b = await readJson(req);
    const title = str(b.title, 200);
    if (!title) throw new HttpError(400, 'Announcement needs a title');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : today();
    db.announcements.unshift({ id: uid(), title, body: str(b.body, 4000), date });
    save(); return ok();
  }
  if ((match = p.match(/^\/api\/admin\/announcements\/([a-f0-9]{12})$/))) {
    need(user, 'news');
    const a = db.announcements.find(x => x.id === match[1]);
    if (!a) throw new HttpError(404, 'Not found');
    if (m === 'PUT') {
      const b = await readJson(req);
      a.title = str(b.title, 200) || a.title; a.body = str(b.body, 4000);
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.date)) a.date = b.date;
      save(); return ok();
    }
    if (m === 'DELETE') { drop(db.announcements, a.id); save(); return ok(); }
  }

  // --- photos ---
  if (p === '/api/admin/photos' && m === 'POST') {
    need(user, 'photos');
    const b = await readJson(req, 12e6);
    const img = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl || '');
    if (!img) throw new HttpError(400, 'Only PNG, JPG, WEBP or GIF images');
    const id = uid(), file = `${id}.${img[1] === 'jpeg' ? 'jpg' : img[1]}`;
    fs.writeFileSync(path.join(UPLOADS, file), Buffer.from(img[2], 'base64'));
    db.photos.unshift({ id, src: `uploads/${file}`, caption: str(b.caption, 200) });
    save(); return ok();
  }
  if ((match = p.match(/^\/api\/admin\/photos\/([a-f0-9]{12})$/))) {
    need(user, 'photos');
    const i = db.photos.findIndex(x => x.id === match[1]);
    if (i < 0) throw new HttpError(404, 'Not found');
    if (m === 'PUT') { // caption edit or move to front
      const b = await readJson(req);
      if ('caption' in b) db.photos[i].caption = str(b.caption, 200);
      if (b.toFront) db.photos.unshift(...db.photos.splice(i, 1));
      save(); return ok();
    }
    if (m === 'DELETE') {
      const [photo] = db.photos.splice(i, 1); save();
      if (photo.src.startsWith('uploads/')) fs.rmSync(path.join(PUB, photo.src), { force: true });
      return ok();
    }
  }

  // --- forms ---
  if (p === '/api/admin/forms' && m === 'POST') {
    need(user, 'forms');
    const form = cleanForm(await readJson(req));
    db.forms.unshift(form); save();
    return json(res, 200, { id: form.id });
  }
  if ((match = p.match(/^\/api\/admin\/forms\/([a-f0-9]{12})$/))) {
    need(user, 'forms');
    const i = db.forms.findIndex(f => f.id === match[1]);
    if (i < 0) throw new HttpError(404, 'Form not found');
    if (m === 'PUT') { db.forms[i] = cleanForm(await readJson(req), db.forms[i]); save(); return ok(); }
    if (m === 'DELETE') { db.forms.splice(i, 1); delete db.responses[match[1]]; save(); return ok(); }
  }
  if ((match = p.match(/^\/api\/admin\/forms\/([a-f0-9]{12})\/responses$/)) && m === 'GET') {
    need(user, 'responses');
    const form = db.forms.find(f => f.id === match[1]);
    if (!form) throw new HttpError(404, 'Form not found');
    return json(res, 200, { form: { ...publicForm(form), exportKey: form.exportKey }, responses: db.responses[form.id] || [] });
  }
  if ((match = p.match(/^\/api\/admin\/forms\/([a-f0-9]{12})\/responses\/([a-f0-9]{12})$/)) && m === 'DELETE') {
    need(user, 'responses');
    drop(db.responses[match[1]] || [], match[2]); save();
    return ok();
  }

  // --- connections (Excel link + Google Sheets push) ---
  if ((match = p.match(/^\/api\/admin\/forms\/([a-f0-9]{12})\/(sheet|sheet-test|sheet-sync|rotate-key)$/)) && (m === 'PUT' || m === 'POST')) {
    need(user, 'connections');
    const form = db.forms.find(f => f.id === match[1]);
    if (!form) throw new HttpError(404, 'Form not found');
    const action = match[2];
    if (action === 'sheet') {
      const link = str((await readJson(req)).url, 500);
      if (link && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(link)) {
        throw new HttpError(400, 'Paste the Web App URL from Apps Script (starts with https://script.google.com/macros/s/ and ends with /exec)');
      }
      form.sheetWebhook = link; form.sheetStatus = null; save();
      return json(res, 200, link ? await pushToSheet(form.id, []) : { ok: true, msg: 'Disconnected' });
    }
    if (action === 'sheet-test') return json(res, 200, await pushToSheet(form.id, []) || { ok: false, msg: 'Not connected' });
    if (action === 'sheet-sync') return json(res, 200, await pushToSheet(form.id, db.responses[form.id] || []) || { ok: false, msg: 'Not connected' });
    if (action === 'rotate-key') { form.exportKey = crypto.randomBytes(16).toString('hex'); save(); return ok(); }
  }

  // --- team & roles ---
  if (p === '/api/admin/users' && m === 'GET') { need(user, 'users'); return json(res, 200, db.users.map(safeUser)); }
  if (p === '/api/admin/users' && m === 'POST') {
    need(user, 'users');
    db.users.push(cleanUser(await readJson(req))); save(); return ok();
  }
  if ((match = p.match(/^\/api\/admin\/users\/([a-f0-9]{12})$/))) {
    need(user, 'users');
    const i = db.users.findIndex(u => u.id === match[1]);
    if (i < 0) throw new HttpError(404, 'User not found');
    const target = db.users[i];
    const lastOwner = target.perms.includes('users') && owners().length === 1;
    if (m === 'PUT') {
      const updated = cleanUser(await readJson(req), target);
      if (lastOwner && !updated.perms.includes('users')) throw new HttpError(400, 'Keep at least one person who can manage the team');
      db.users[i] = updated; save(); return ok();
    }
    if (m === 'DELETE') {
      if (target.id === user.id) throw new HttpError(400, 'You cannot delete your own account');
      if (lastOwner) throw new HttpError(400, 'Keep at least one person who can manage the team');
      db.users.splice(i, 1);
      for (const [t, id] of sessions) if (id === target.id) sessions.delete(t);
      save(); return ok();
    }
  }
  throw new HttpError(404, 'Not found');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(res, p) {
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  if (p === '/form' || p === '/form/') p = '/form.html';
  let file;
  try { file = path.join(PUB, decodeURIComponent(p)); } catch { throw new HttpError(400, 'Bad path'); }
  if (!file.startsWith(PUB + path.sep)) throw new HttpError(404, 'Not found');
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.log(`Cultural Section running → http://localhost:${PORT}  (form: /form, admin: /admin)`));
