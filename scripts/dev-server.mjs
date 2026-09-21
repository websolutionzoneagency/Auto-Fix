// Local stand-in for Vercel: serves the static app AND mounts api/[...path].js under /api.
//   DATABASE_URL=... RANKOPS_API_TOKEN=... ENCRYPTION_KEY=... node scripts/dev-server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import handler from '../api/[...path].js';

const PORT = Number(process.env.PORT || 8080);
const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    req.query = { path: url.pathname.slice(5).split('/').filter(Boolean), ...Object.fromEntries(url.searchParams) };
    return handler(req, res);
  }
  let file = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(PORT, () => console.log(`RankOps dev server → http://localhost:${PORT}  (api mounted at /api)`));
