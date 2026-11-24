// Cultural Section API. One handler used by both server.js (localhost) and api/index.js (Vercel).
const crypto = require('node:crypto');
const { getStore } = require('./store');

const DEFAULT_PASSWORD = 'cultural123';
const PERMS = ['forms', 'responses', 'connections', 'news', 'photos', 'users'];
const TOKEN_HOURS = 12;

const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

// ---------- passwords + login tokens ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw), user.salt, 64), Buffer.from(user.hash, 'hex'));
}
const mac = (db, body) => crypto.createHmac('sha256', db.secret).update(body).digest('base64url');
// Stateless token (works on serverless). Changing the password changes `p`, which logs old tokens out.
function signToken(db, user) {
  const body = Buffer.from(JSON.stringify({ u: user.id, e: Date.now() + TOKEN_HOURS * 36e5, p: user.hash.slice(0, 8) })).toString('base64url');
  return `${body}.${mac(db, body)}`;
}
function userFromToken(db, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEq(sig, mac(db, body))) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString());
    const user = db.users.find(u => u.id === t.u);
    return user && t.e > Date.now() && t.p === user.hash.slice(0, 8) ? user : null;
  } catch { return null; }
}

// ---------- seed + migrations ----------
// Face-friendly crop position for each starter photo (object-position).
const PHOTO_POS = {
  'farewell-2k26.webp': '50% 50%', 'music-guitar.webp': '50% 30%', 'poetry-recital.webp': '40% 28%',
  'award-1.webp': '50% 24%', 'drama-rehearsal.webp': '40% 35%', 'award-2.webp': '50% 30%',
};
const owner = () => ({ id: uid(), name: 'Owner', username: 'admin', ...hashPassword(process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD), perms: [...PERMS] });
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
  const photo = (file, caption) => ({ id: uid(), src: `img/${file}`, caption, pos: PHOTO_POS[file] });
  return {
    secret: crypto.randomBytes(32).toString('hex'),
    users: [owner()],
    forms: [form],
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
// ADMIN_USER / ADMIN_PASSWORD (env) control the main owner login. Change them and redeploy and the login follows.
// A fingerprint of the env pair is stored, so a password changed inside the admin panel is kept until the env pair changes.
function syncEnvOwner(db) {
  const pass = (process.env.ADMIN_PASSWORD || '').trim();
  if (!pass) return false;
  const name = (process.env.ADMIN_USER || 'admin').trim().toLowerCase() || 'admin';
  const sig = crypto.createHash('sha256').update(name + '\n' + pass).digest('hex');
  let u = db.users.find(x => x.envOwner) || db.users.find(x => x.perms.includes('users')) || db.users[0];
  if (u.envOwner && u.envSig === sig) return false;
  if (db.users.some(x => x !== u && x.username === name)) return false; // name belongs to another team member; leave it alone
  Object.assign(u, { username: name, envOwner: true, envSig: sig, perms: [...PERMS], ...hashPassword(pass) });
  return true;
}
// Bring older data up to date. Returns true if anything changed.
function normalize(db) {
  let changed = false;
  if (!db.secret) { db.secret = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (!db.users?.length) { db.users = [owner()]; changed = true; }
  if (syncEnvOwner(db)) changed = true;
  for (const p of db.photos || []) {
    if (!p.pos) { p.pos = PHOTO_POS[p.src.split('/').pop()] || '50% 30%'; changed = true; }
  }
  return changed;
}

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());
const drop = (arr, id) => {
  const i = arr.findIndex(x => x.id === id);
  if (i < 0) throw new HttpError(404, 'Not found');
  return arr.splice(i, 1)[0];
};
const POS_RE = /^\d{1,3}% \d{1,3}%$/;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readJson(req, limit = 1e5) {
  // Vercel pre-parses JSON bodies into req.body; plain Node needs the stream read.
  if (req.body !== undefined) {
    const b = req.body;
    if (JSON.stringify(b ?? '').length > limit) throw new HttpError(413, 'Upload too large');
    try { return Promise.resolve(typeof b === 'string' ? JSON.parse(b || '{}') : b || {}); } catch { throw new HttpError(400, 'Bad request'); }
  }
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
const toCsv = (form, responses) =>
  '﻿' + [headersOf(form), ...responses.map(r => rowOf(form, r))]
    .map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');

// Push rows to a Google Apps Script web app. Awaited (serverless stops work after the response is sent).
async function pushToSheet(ctx, form, rows) {
  if (!form.sheetWebhook) return null;
  let status;
  try {
    const res = await fetch(form.sheetWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form: form.title, headers: headersOf(form), rows: rows.map(r => rowOf(form, r)) }),
      signal: AbortSignal.timeout(8000),
    });
    const text = (await res.text()).trim();
    if (!res.ok || text !== 'ok') throw new Error('Script did not reply "ok" — check it is deployed with access "Anyone"');
    status = { ok: true, at: now(), msg: rows.length ? `Sent ${rows.length} row(s)` : 'Connected — header row sent' };
  } catch (e) {
    status = { ok: false, at: now(), msg: e.name === 'TimeoutError' ? 'Google did not answer in time' : e.message };
  }
  form.sheetStatus = status;
  await ctx.store.saveDb(ctx.db);
  return status;
}

// ---------- permissions + users ----------
const need = (user, perm) => { if (!user.perms.includes(perm)) throw new HttpError(403, 'Your role does not allow this'); };
const safeUser = u => ({ id: u.id, name: u.name, username: u.username, perms: u.perms });
const publicForm = ({ exportKey, sheetWebhook, sheetStatus, ...f }) => f;

function cleanUser(db, b, old) {
  const name = str(b.name, 80);
  const username = str(b.username, 40).toLowerCase();
  if (!name) throw new HttpError(400, 'Name is required');
  if (!/^[a-z0-9._@+-]{3,40}$/.test(username)) throw new HttpError(400, 'Username: 3–40 letters, numbers, dot, dash, underscore or @');
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

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname, m = req.method;
  const store = getStore();
  const db = await store.getDb(seed);
  if (normalize(db)) await store.saveDb(db);
  const ctx = { db, store };
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
    const row = { id: uid(), at: now(), data: cleanSubmission(form, await readJson(req, 2e5)) };
    await store.addResponse(form.id, row);
    await pushToSheet(ctx, form, [row]); // never blocks the saved response: errors only update the status
    return json(res, 200, { ok: true });
  }

  // Uploaded photo (database-backed deployments)
  if ((match = p.match(/^\/photo\/([a-f0-9]{12})$/)) && m === 'GET') {
    const photo = await store.getPhoto(match[1]);
    if (!photo) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': photo.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.end(photo.buf);
  }

  // Live CSV link — Excel (Data → From Web) and Google Sheets (=IMPORTDATA).
  if ((match = p.match(/^\/export\/([a-f0-9]{12})\.csv$/)) && m === 'GET') {
    const form = db.forms.find(f => f.id === match[1]);
    if (!form || !safeEq(url.searchParams.get('key') || '', form.exportKey)) throw new HttpError(404, 'Not found');
    const name = form.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'responses';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'no-store' });
    return res.end(toCsv(form, await store.listResponses(form.id)));
  }

  if (p === '/api/admin/login' && m === 'POST') {
    const { username, password } = await readJson(req);
    const user = db.users.find(u => u.username === str(username, 60).toLowerCase());
    if (!user || !checkPassword(user, password || '')) {
      await new Promise(r => setTimeout(r, 800)); // slow down guessing
      throw new HttpError(401, 'Wrong username or password');
    }
    return json(res, 200, { token: signToken(db, user) });
  }

  if (p.startsWith('/api/admin/')) {
    const user = userFromToken(db, (req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!user) throw new HttpError(401, 'Please log in again');
    return admin(req, res, p, m, user, ctx);
  }
  throw new HttpError(404, 'Not found');
}

async function admin(req, res, p, m, user, ctx) {
  const { db, store } = ctx;
  let match;
  const ok = () => json(res, 200, { ok: true });
  const save = () => store.saveDb(db);

  if (p === '/api/admin/logout' && m === 'POST') return ok(); // token is dropped by the browser; it also expires on its own

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
      counts: await store.counts(),
    });
  }

  if (p === '/api/admin/me/password' && m === 'POST') {
    const b = await readJson(req);
    if (!checkPassword(user, b.current || '')) throw new HttpError(400, 'Current password is wrong');
    if (String(b.password || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    Object.assign(user, hashPassword(String(b.password)));
    await save();
    return json(res, 200, { ok: true, token: signToken(db, user) }); // fresh token: old ones stop working
  }

  // --- announcements ---
  if (p === '/api/admin/announcements' && m === 'POST') {
    need(user, 'news');
    const b = await readJson(req);
    const title = str(b.title, 200);
    if (!title) throw new HttpError(400, 'Announcement needs a title');
    db.announcements.unshift({ id: uid(), title, body: str(b.body, 4000), date: /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : today() });
    await save(); return ok();
  }
  if ((match = p.match(/^\/api\/admin\/announcements\/([a-f0-9]{12})$/))) {
    need(user, 'news');
    const a = db.announcements.find(x => x.id === match[1]);
    if (!a) throw new HttpError(404, 'Not found');
    if (m === 'PUT') {
      const b = await readJson(req);
      a.title = str(b.title, 200) || a.title; a.body = str(b.body, 4000);
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.date)) a.date = b.date;
      await save(); return ok();
    }
    if (m === 'DELETE') { drop(db.announcements, a.id); await save(); return ok(); }
  }

  // --- photos ---
  if (p === '/api/admin/photos' && m === 'POST') {
    need(user, 'photos');
    // Vercel allows ~4.5 MB request bodies; the admin page shrinks photos well below that first.
    const b = await readJson(req, 4.2e6);
    const img = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl || '');
    if (!img) throw new HttpError(400, 'Only PNG, JPG, WEBP or GIF images');
    const id = uid(), mime = `image/${img[1]}`;
    const src = await store.putPhoto(id, mime, Buffer.from(img[2], 'base64'));
    db.photos.unshift({ id, src, caption: str(b.caption, 200), pos: POS_RE.test(b.pos) ? b.pos : '50% 30%' });
    await save(); return ok();
  }
  if ((match = p.match(/^\/api\/admin\/photos\/([a-f0-9]{12})$/))) {
    need(user, 'photos');
    const i = db.photos.findIndex(x => x.id === match[1]);
    if (i < 0) throw new HttpError(404, 'Not found');
    if (m === 'PUT') {
      const b = await readJson(req);
      if ('caption' in b) db.photos[i].caption = str(b.caption, 200);
      if (POS_RE.test(b.pos)) db.photos[i].pos = b.pos;
      if (b.toFront) db.photos.unshift(...db.photos.splice(i, 1));
      await save(); return ok();
    }
    if (m === 'DELETE') {
      const [photo] = db.photos.splice(i, 1);
      await save(); await store.delPhoto(photo); return ok();
    }
  }

  // --- forms ---
  if (p === '/api/admin/forms' && m === 'POST') {
    need(user, 'forms');
    const form = cleanForm(await readJson(req));
    db.forms.unshift(form); await save();
    return json(res, 200, { id: form.id });
  }
  if ((match = p.match(/^\/api\/admin\/forms\/([a-f0-9]{12})$/))) {
    need(user, 'forms');
    const i = db.forms.findIndex(f => f.id === match[1]);
    if (i < 0) throw new HttpError(404, 'Form not found');
    if (m === 'PUT') { db.forms[i] = cleanForm(await readJson(req), db.forms[i]); await save(); return ok(); }
    if (m === 'DELETE') { db.forms.splice(i, 1); await save(); await store.delFormResponses(match[1]); return ok(); }
  }
  if ((match = p.match(/^\/api\/admin\/forms\/([a-f0-9]{12})\/responses$/)) && m === 'GET') {
    need(user, 'responses');
    const form = db.forms.find(f => f.id === match[1]);
    if (!form) throw new HttpError(404, 'Form not found');
    return json(res, 200, { form: { ...publicForm(form), exportKey: form.exportKey }, responses: await store.listResponses(form.id) });
  }
  if ((match = p.match(/^\/api\/admin\/forms\/([a-f0-9]{12})\/responses\/([a-f0-9]{12})$/)) && m === 'DELETE') {
    need(user, 'responses');
    if (!(await store.delResponse(match[1], match[2]))) throw new HttpError(404, 'Not found');
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
      form.sheetWebhook = link; form.sheetStatus = null; await save();
      return json(res, 200, link ? await pushToSheet(ctx, form, []) : { ok: true, msg: 'Disconnected' });
    }
    if (action === 'sheet-test') return json(res, 200, await pushToSheet(ctx, form, []) || { ok: false, msg: 'Not connected' });
    if (action === 'sheet-sync') return json(res, 200, await pushToSheet(ctx, form, await store.listResponses(form.id)) || { ok: false, msg: 'Not connected' });
    if (action === 'rotate-key') { form.exportKey = crypto.randomBytes(16).toString('hex'); await save(); return ok(); }
  }

  // --- team & roles ---
  const owners = () => db.users.filter(u => u.perms.includes('users'));
  if (p === '/api/admin/users' && m === 'GET') { need(user, 'users'); return json(res, 200, db.users.map(safeUser)); }
  if (p === '/api/admin/users' && m === 'POST') {
    need(user, 'users');
    db.users.push(cleanUser(db, await readJson(req))); await save(); return ok();
  }
  if ((match = p.match(/^\/api\/admin\/users\/([a-f0-9]{12})$/))) {
    need(user, 'users');
    const i = db.users.findIndex(u => u.id === match[1]);
    if (i < 0) throw new HttpError(404, 'User not found');
    const target = db.users[i];
    const lastOwner = target.perms.includes('users') && owners().length === 1;
    if (m === 'PUT') {
      const updated = cleanUser(db, await readJson(req), target);
      if (lastOwner && !updated.perms.includes('users')) throw new HttpError(400, 'Keep at least one person who can manage the team');
      db.users[i] = updated; await save(); return ok();
    }
    if (m === 'DELETE') { // their token stops working because the user no longer exists
      if (target.id === user.id) throw new HttpError(400, 'You cannot delete your own account');
      if (lastOwner) throw new HttpError(400, 'Keep at least one person who can manage the team');
      db.users.splice(i, 1); await save(); return ok();
    }
  }
  throw new HttpError(404, 'Not found');
}

async function handle(req, res) {
  try { await route(req, res); }
  catch (e) {
    if (e instanceof HttpError || e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
}

module.exports = { handle };
