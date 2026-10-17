const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIRECTORY = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIRECTORY, 'drafts.json');
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}', 'utf8');

function normalizeUsername(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function readDrafts() {
  const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Draft JSON must contain an object.');
  }
  return new Map(Object.entries(stored));
}

function writeDrafts(drafts) {
  const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(Object.fromEntries(drafts), null, 2), 'utf8');
  fs.renameSync(temporaryFile, DATA_FILE);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let byteLength = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (byteLength > MAX_REQUEST_BYTES) return;
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > MAX_REQUEST_BYTES) {
        const error = new Error('Request body exceeds the 20 MB limit.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function serveStaticFile(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(ROOT, `.${decodeURIComponent(requestedPath)}`);
  const relativePath = path.relative(ROOT, filePath);
  if (
    !filePath.startsWith(`${ROOT}${path.sep}`) ||
    relativePath === 'data' ||
    relativePath.startsWith(`data${path.sep}`)
  ) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const match = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);

  if (match) {
    let username;
    try {
      username = normalizeUsername(decodeURIComponent(match[1]));
    } catch {
      sendJson(response, 400, { error: 'Invalid username encoding.' });
      return;
    }
    if (!username || username.length > 100) {
      sendJson(response, 400, { error: 'Username must be between 1 and 100 characters.' });
      return;
    }

    try {
      const drafts = readDrafts();
      if (request.method === 'GET') {
        const draft = drafts.get(username);
        if (!draft) {
          sendJson(response, 404, { error: 'Draft not found.' });
          return;
        }
        sendJson(response, 200, { draft });
        return;
      }

      if (request.method === 'PUT') {
        const rawBody = await readRequestBody(request);
        let draft;
        try {
          draft = JSON.parse(rawBody);
        } catch {
          sendJson(response, 400, { error: 'Request body must be valid JSON.' });
          return;
        }
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
          sendJson(response, 400, { error: 'Draft must be a JSON object.' });
          return;
        }
        drafts.set(username, draft);
        writeDrafts(drafts);
        sendJson(response, 200, { saved: true });
        return;
      }

      if (request.method === 'DELETE') {
        drafts.delete(username);
        writeDrafts(drafts);
        response.writeHead(204);
        response.end();
        return;
      }

      sendJson(response, 405, { error: 'Method not allowed.' });
    } catch (error) {
      console.error('Draft storage request failed:', error);
      sendJson(response, error.statusCode || 500, {
        error: error.statusCode === 413 ? error.message : 'Draft storage is unavailable.'
      });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API endpoint not found.' });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405);
    response.end('Method not allowed');
    return;
  }

  try {
    serveStaticFile(request, response, url.pathname);
  } catch {
    response.writeHead(400);
    response.end('Invalid path');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FORMGUARD server listening on http://localhost:${PORT}`);
  console.log(`Drafts are stored in ${DATA_FILE}`);
});
