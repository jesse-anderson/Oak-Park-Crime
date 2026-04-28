import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || process.env.PORT || 4173);
const host = '127.0.0.1';

const contentTypes = new Map([
  ['.bas', 'text/plain; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.duckdb', 'application/octet-stream'],
  ['.geojson', 'application/geo+json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.parquet', 'application/octet-stream'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm']
]);

function headersFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': contentTypes.get(ext) || 'application/octet-stream'
  };

  if (ext === '.html' || filePath.includes(`${path.sep}js${path.sep}duckdb${path.sep}`)) {
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
  }
  if (ext === '.html') {
    headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
  }

  if (ext === '.wasm') {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else if (filePath.includes(`${path.sep}js${path.sep}duckdb${path.sep}`) && ext === '.js') {
    headers['Cache-Control'] = 'public, max-age=86400';
  } else if (ext === '.duckdb') {
    headers['Cache-Control'] = 'public, max-age=39600';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }

  return headers;
}

function resolvePath(requestUrl) {
  const url = new URL(requestUrl, `http://${host}:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/crime_map.html';

  const filePath = path.resolve(root, `.${pathname}`);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
    return null;
  }
  return filePath;
}

const server = http.createServer((req, res) => {
  const filePath = resolvePath(req.url || '/');
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const headers = {
      ...headersFor(filePath),
      'Content-Length': stat.size
    };
    res.writeHead(200, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}/`);
});
