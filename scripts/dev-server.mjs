// Serveur de développement : sert public/ et l'API (/api/*) avec un stockage
// sur disque (.data/) qui imite Netlify Blobs. Lancer : npm run dev
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeHandler } from '../netlify/functions/lib/api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const dataDir = path.join(root, '.data');
const PORT = Number(process.env.PORT) || 8888;

function fileStore(name) {
  const dir = path.join(dataDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, encodeURIComponent(key));
  const read = (key) => (fs.existsSync(file(key)) ? fs.readFileSync(file(key), 'utf8') : null);
  const etagOf = (text) => crypto.createHash('md5').update(text).digest('hex');
  const write = (key, text, opts = {}) => {
    const cur = read(key);
    if (opts.onlyIfNew && cur !== null) return { modified: false };
    if (opts.onlyIfMatch && (cur === null || etagOf(cur) !== opts.onlyIfMatch)) return { modified: false };
    fs.writeFileSync(file(key), text);
    return { modified: true, etag: etagOf(text) };
  };
  return {
    async get(key, o = {}) { const t = read(key); return t === null ? null : o.type === 'json' ? JSON.parse(t) : t; },
    async getWithMetadata(key, o = {}) {
      const t = read(key);
      return t === null ? null : { data: o.type === 'json' ? JSON.parse(t) : t, etag: etagOf(t), metadata: {} };
    },
    async set(key, value, opts) { return write(key, String(value), opts); },
    async setJSON(key, value, opts) { return write(key, JSON.stringify(value), opts); },
    async delete(key) { if (fs.existsSync(file(key))) fs.unlinkSync(file(key)); },
  };
}

const api = makeHandler((opts) => fileStore(typeof opts === 'string' ? opts : opts.name));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, {
      method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const r = await api(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = path.normalize(path.join(pub, decodeURIComponent(url.pathname)));
  if (!p.startsWith(pub)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('Introuvable'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log(`Caisse : http://localhost:${PORT}`));
