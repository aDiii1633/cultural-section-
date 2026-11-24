// Storage layer. Same interface for both backends:
//   local dev  -> data/db.json + public/uploads   (no setup)
//   Vercel     -> Postgres (Neon) via DATABASE_URL / POSTGRES_URL
// Responses live apart from the main document so two people submitting at the same moment never overwrite each other.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function fileStore() {
  const DB_FILE = path.join(ROOT, 'data', 'db.json');
  const UPLOADS = path.join(ROOT, 'public', 'uploads');
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  let data = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : null;
  const write = () => {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  };
  const res = id => (data.responses[id] ||= []);
  return {
    kind: 'file',
    async getDb(seed) { if (!data) { data = { ...seed(), responses: {} }; write(); } return data; },
    async saveDb() { write(); },
    async listResponses(formId) { return res(formId); },
    async counts() { return Object.fromEntries(Object.entries(data.responses).map(([k, v]) => [k, v.length])); },
    async addResponse(formId, row) { res(formId).push(row); write(); },
    async delResponse(formId, id) { const a = res(formId), i = a.findIndex(r => r.id === id); if (i < 0) return false; a.splice(i, 1); write(); return true; },
    async delFormResponses(formId) { delete data.responses[formId]; write(); },
    async putPhoto(id, mime, buf) {
      const file = `${id}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
      fs.writeFileSync(path.join(UPLOADS, file), buf);
      return `uploads/${file}`;
    },
    async getPhoto() { return null; }, // served as a static file locally
    async delPhoto(photo) { if (photo.src.startsWith('uploads/')) fs.rmSync(path.join(ROOT, 'public', photo.src), { force: true }); },
  };
}

function pgStore(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  let ready = null;
  const create = async () => {
    await sql`create table if not exists kv (k text primary key, v jsonb not null)`;
    await sql`create table if not exists responses (id text primary key, form_id text not null, at text not null, data jsonb not null)`;
    await sql`create index if not exists responses_form on responses (form_id)`;
    await sql`create table if not exists photos (id text primary key, mime text not null, b64 text not null)`;
  };
  // Two cold instances can run "create table if not exists" at the same moment and one gets a duplicate-key error
  // (Postgres catalog race). Just retry: the other instance has finished by then.
  const init = () => (ready ||= (async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await create(); }
      catch (e) { if (attempt >= 4) throw e; await new Promise(r => setTimeout(r, 200 * (attempt + 1))); }
    }
  })().catch(e => { ready = null; throw e; }));
  return {
    kind: 'postgres',
    async getDb(seed) {
      await init();
      let r = await sql`select v from kv where k = 'db'`;
      if (!r.length) {
        await sql`insert into kv (k, v) values ('db', ${JSON.stringify(seed())}::jsonb) on conflict (k) do nothing`;
        r = await sql`select v from kv where k = 'db'`;
      }
      return r[0].v;
    },
    async saveDb(db) {
      await sql`insert into kv (k, v) values ('db', ${JSON.stringify(db)}::jsonb) on conflict (k) do update set v = excluded.v`;
    },
    async listResponses(formId) {
      await init();
      return sql`select id, at, data from responses where form_id = ${formId} order by at`;
    },
    async counts() {
      await init();
      const rows = await sql`select form_id, count(*)::int as n from responses group by form_id`;
      return Object.fromEntries(rows.map(r => [r.form_id, r.n]));
    },
    async addResponse(formId, row) {
      await init();
      await sql`insert into responses (id, form_id, at, data) values (${row.id}, ${formId}, ${row.at}, ${JSON.stringify(row.data)}::jsonb)`;
    },
    async delResponse(formId, id) {
      await init();
      const r = await sql`delete from responses where id = ${id} and form_id = ${formId} returning id`;
      return r.length > 0;
    },
    async delFormResponses(formId) { await init(); await sql`delete from responses where form_id = ${formId}`; },
    async putPhoto(id, mime, buf) {
      await init();
      await sql`insert into photos (id, mime, b64) values (${id}, ${mime}, ${buf.toString('base64')})`;
      return `/photo/${id}`;
    },
    async getPhoto(id) {
      await init();
      const r = await sql`select mime, b64 from photos where id = ${id}`;
      return r.length ? { mime: r[0].mime, buf: Buffer.from(r[0].b64, 'base64') } : null;
    },
    async delPhoto(photo) {
      const m = /^\/photo\/([a-f0-9]{12})$/.exec(photo.src);
      if (m) { await init(); await sql`delete from photos where id = ${m[1]}`; }
    },
  };
}

// On Vercel the disk is read-only, so a database is mandatory. Say so clearly instead of crashing.
function missingDb() {
  const fail = async () => { const e = new Error('Database not connected. In Vercel: Storage → Create → Neon (Postgres) → connect it to this project, then redeploy.'); e.status = 503; throw e; };
  return new Proxy({ kind: 'none' }, { get: (t, k) => (k in t ? t[k] : fail) });
}

let store;
function getStore() {
  if (store) return store;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  store = url ? pgStore(url) : process.env.VERCEL ? missingDb() : fileStore();
  return store;
}

module.exports = { getStore };
