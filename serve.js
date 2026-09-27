// Minimal static server for local use: `npm start`, then open http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT) || 8080;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }
  const file = path.join(root, url.endsWith('/') ? url + 'index.html' : url);
  const hidden = path.relative(root, file).split(path.sep).some((part) => part.startsWith('.'));
  if (!file.startsWith(root + path.sep) || hidden) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log(`Habito running at http://localhost:${port}`));
