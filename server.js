import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      // Adapt Node's raw req/res to the shape the handler expects
      const mockReq = { method: req.method, body };

      const pendingHeaders = {};
      let statusCode = 200;
      let sent = false;

      const mockRes = {
        setHeader: (k, v) => { pendingHeaders[k] = v; },
        status: (code) => { statusCode = code; return mockRes; },
        json: (data) => {
          if (!sent) {
            sent = true;
            res.writeHead(statusCode, { 'Content-Type': 'application/json', ...pendingHeaders });
            res.end(JSON.stringify(data));
          }
          return mockRes;
        },
        end: () => {
          if (!sent) {
            sent = true;
            res.writeHead(statusCode, pendingHeaders);
            res.end();
          }
          return mockRes;
        },
      };

      await handler(mockReq, mockRes);
    });
    return;
  }

  // Serve static files from public/
  const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}`);
});
