import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chatHandler from './api/chat.js';
import sessionsHandler from './api/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

function buildMockRes(res) {
  const pendingHeaders = {};
  let statusCode = 200;
  let sent = false;
  const mock = {
    setHeader: (k, v) => { pendingHeaders[k] = v; },
    status: (code) => { statusCode = code; return mock; },
    json: (data) => {
      if (!sent) {
        sent = true;
        res.writeHead(statusCode, { 'Content-Type': 'application/json', ...pendingHeaders });
        res.end(JSON.stringify(data));
      }
      return mock;
    },
    end: () => {
      if (!sent) {
        sent = true;
        res.writeHead(statusCode, pendingHeaders);
        res.end();
      }
      return mock;
    },
  };
  return mock;
}

async function dispatch(handler, req, res, body = {}) {
  const mockReq = { method: req.method, url: req.url, body };
  await handler(mockReq, buildMockRes(res));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // API routes with a body
  if (['POST', 'PATCH'].includes(req.method) && req.url.startsWith('/api/')) {
    let body;
    try { body = await parseBody(req); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    if (req.url === '/api/chat') return dispatch(chatHandler, req, res, body);
    if (req.url.startsWith('/api/sessions')) return dispatch(sessionsHandler, req, res, body);
  }

  // API routes without a body (GET, OPTIONS)
  if (req.url.startsWith('/api/sessions')) return dispatch(sessionsHandler, req, res, {});

  // Static files from public/
  const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
