// A tiny local static server that behaves like the hosts Riftborn deploys to, so builds can be
// checked under their real headers before they ship. Local only; nothing here is deployed.
//
//   node scripts/serve-cf.mjs _cf/live [--port 8791]           Cloudflare Pages: applies _headers
//                                                              and _redirects, 404.html, clean URLs
//   node scripts/serve-cf.mjs _cf/dev --port 8792
//   node scripts/serve-cf.mjs _cf/feedback --port 8793          the feedback inbox (feedback.riftborn.us)
//   node scripts/serve-cf.mjs _site --github [--port 8790]     GitHub Pages project site under
//                                                              /riftborn/ (no custom headers)
//
// Open two different hosts (e.g. http://127.0.0.1:8790/riftborn/ and http://localhost:8791/) to
// get two browser origins, like chancrisp.github.io and riftborn.us.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchHeaders, matchRedirect, parseHeaders, parseRedirects } from './pages-headers.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.wasm': 'application/wasm'
};
const HIDDEN = new Set(['_headers', '_redirects']);

const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/**
 * createPagesServer({ root, mode: 'cloudflare' | 'github', prefix: '/riftborn/' }) -> http.Server
 * Files are read per request, so the output can be rebuilt while the server runs.
 */
export function createPagesServer({ root, mode = 'cloudflare', prefix = '/riftborn/' }) {
  const base = path.resolve(root);
  const inside = file => file === base || file.startsWith(base + path.sep);
  const fileFor = rel => {
    const file = path.resolve(base, '.' + rel);
    return inside(file) ? file : null;
  };
  const rules = () => (mode === 'cloudflare' && isFile(path.join(base, '_headers')) ? parseHeaders(fs.readFileSync(path.join(base, '_headers'), 'utf8')) : []);
  const redirects = () => (mode === 'cloudflare' && isFile(path.join(base, '_redirects')) ? parseRedirects(fs.readFileSync(path.join(base, '_redirects'), 'utf8')) : []);

  function send(res, status, pathname, file, extra = {}) {
    const headers = { ...extra };
    if (mode === 'cloudflare') {
      for (const { name, value } of matchHeaders(rules(), pathname).values()) headers[name] = value;
      if (!Object.keys(headers).some(name => name.toLowerCase() === 'cache-control')) headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
    } else {
      headers['Cache-Control'] = 'max-age=600';
    }
    if (!file) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(status === 404 ? 'Not found' : '');
      return;
    }
    res.writeHead(status, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', ...headers });
    res.end(fs.readFileSync(file));
  }
  const redirect = (res, pathname, location, status) => send(res, status, pathname, null, { Location: location });

  function cloudflare(req, res, pathname, search) {
    const moved = matchRedirect(redirects(), pathname);
    if (moved) return redirect(res, pathname, moved.location + (moved.location.includes('?') ? '' : search), moved.status);
    const name = pathname.split('/').pop();
    if (HIDDEN.has(name) && !pathname.slice(1).includes('/')) return notFound(res, pathname);
    // Clean URLs: /x/index.html -> /x/, /x.html -> /x, /x -> /x/ when x/index.html exists.
    if (pathname.endsWith('/index.html')) return redirect(res, pathname, pathname.slice(0, -'index.html'.length) + search, 308);
    if (pathname.endsWith('.html') && isFile(fileFor(pathname))) return redirect(res, pathname, pathname.slice(0, -'.html'.length) + search, 308);
    if (pathname.endsWith('/')) {
      const index = fileFor(pathname + 'index.html');
      if (index && isFile(index)) return send(res, 200, pathname, index);
      return notFound(res, pathname);
    }
    const file = fileFor(pathname);
    if (file && isFile(file)) return send(res, 200, pathname, file);
    const dirIndex = fileFor(pathname + '/index.html');
    if (dirIndex && isFile(dirIndex)) return redirect(res, pathname, pathname + '/' + search, 308);
    const html = fileFor(pathname + '.html');
    if (html && isFile(html)) return send(res, 200, pathname, html);
    return notFound(res, pathname);
  }

  function notFound(res, pathname) {
    // Pages serves the nearest 404.html; with none at the top it treats the site as a single-page app.
    let dir = path.posix.dirname(pathname.endsWith('/') ? pathname + 'x' : pathname);
    for (;;) {
      const page = fileFor(path.posix.join(dir, '404.html'));
      if (page && isFile(page)) return send(res, 404, pathname, page);
      if (dir === '/' || dir === '.') break;
      dir = path.posix.dirname(dir);
    }
    if (mode === 'cloudflare' && isFile(path.join(base, 'index.html'))) return send(res, 200, pathname, path.join(base, 'index.html'));
    return send(res, 404, pathname, null);
  }

  function github(req, res, pathname, search) {
    const top = prefix.replace(/\/$/, '');
    if (pathname === top) return redirect(res, pathname, prefix + search, 301);
    if (!pathname.startsWith(prefix)) return send(res, 404, pathname, null);
    const rel = '/' + pathname.slice(prefix.length);
    const file = fileFor(rel);
    if (rel.endsWith('/')) {
      const index = fileFor(rel + 'index.html');
      if (index && isFile(index)) return send(res, 200, pathname, index);
    } else if (file && isFile(file)) {
      return send(res, 200, pathname, file);
    } else {
      const index = fileFor(rel + '/index.html');
      if (index && isFile(index)) return redirect(res, pathname, pathname + '/' + search, 301);
    }
    const page = fileFor('/404.html');
    return page && isFile(page) ? send(res, 404, pathname, page) : send(res, 404, pathname, null);
  }

  return http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '/', null, { Allow: 'GET, HEAD' });
      const url = new URL(req.url, 'http://local');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, '/', null); }
      if (pathname.includes('\0')) return send(res, 400, '/', null);
      return mode === 'github' ? github(req, res, pathname, url.search) : cloudflare(req, res, pathname, url.search);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server error: ' + error.message);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
  const github = args.includes('--github');
  if (github) args.splice(args.indexOf('--github'), 1);
  const port = Number(flag('--port') || (github ? 8790 : 8791));
  const host = flag('--host') || '127.0.0.1';
  const prefix = flag('--prefix') || '/riftborn/';
  const root = args[0];
  if (!root || !fs.existsSync(root)) {
    console.error('Usage: node scripts/serve-cf.mjs <output folder> [--github] [--port N] [--host 127.0.0.1] [--prefix /riftborn/]');
    process.exit(1);
  }
  createPagesServer({ root, mode: github ? 'github' : 'cloudflare', prefix }).listen(port, host, () => {
    const shown = host === '127.0.0.1' ? `127.0.0.1:${port} (or localhost:${port}, a different origin)` : `${host}:${port}`;
    console.log(`Serving ${root} as ${github ? 'GitHub Pages at ' + prefix : 'Cloudflare Pages (with _headers)'} on http://${shown}`);
  });
}
