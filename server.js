// Local runner: node server.js  (Vercel uses api/index.js instead). Env: PORT, ADMIN_PASSWORD, DATABASE_URL (optional).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handle } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const PAGES = { '/': '/index.html', '/admin': '/admin.html', '/admin/': '/admin.html', '/form': '/form.html', '/form/': '/form.html' };
const API = /^\/(api|export|photo)\//;

function serveStatic(res, p) {
  let file;
  try { file = path.join(PUB, decodeURIComponent(PAGES[p] || p)); } catch { res.writeHead(400); return res.end(); }
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://local').pathname;
  if (API.test(p)) return handle(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(res, p);
}).listen(PORT, () => console.log(`Cultural Section running → http://localhost:${PORT}  (form: /form, admin: /admin)`));
