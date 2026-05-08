import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.DOWNLOAD_TEST_HARNESS_PORT || 48612);
const HOST = process.env.DOWNLOAD_TEST_HARNESS_HOST || '127.0.0.1';
const SESSION_COOKIE = 'trinityHarnessSession';
const activeSessions = new Map();

const MIME_BY_EXT = {
  '.bin': 'application/octet-stream',
  '.zip': 'application/zip',
  '.iso': 'application/x-iso9660-image',
  '.txt': 'text/plain; charset=utf-8',
};

function html(body) {
  return `<!doctype html>${body}`;
}

function now() {
  return Date.now();
}

function cleanupSessions() {
  const cutoff = now() - 30 * 60 * 1000;
  for (const [sessionId, expiresAt] of activeSessions.entries()) {
    if (expiresAt < cutoff) {
      activeSessions.delete(sessionId);
    }
  }
}

function getCookieMap(req) {
  const header = req.headers.cookie || '';
  const entries = header
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const idx = chunk.indexOf('=');
      return idx === -1 ? [chunk, ''] : [chunk.slice(0, idx), decodeURIComponent(chunk.slice(idx + 1))];
    });

  return new Map(entries);
}

function fileNameFor(kind, sizeMb, ext = '.bin') {
  return `trinity-${kind}-${sizeMb}mb${ext}`;
}

function contentTypeFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function parseSizeMb(searchParams, fallbackMb) {
  const raw = Number(searchParams.get('sizeMb') || fallbackMb);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallbackMb;
  }
  return Math.min(Math.max(Math.floor(raw), 1), 1024);
}

function resolveScenario(url) {
  const sizeMb = parseSizeMb(url.searchParams, 10);
  const ext = url.searchParams.get('ext') || '.bin';
  const fileName = url.searchParams.get('name') || fileNameFor('sample', sizeMb, ext.startsWith('.') ? ext : `.${ext}`);
  return {
    sizeMb,
    fileName,
    totalBytes: sizeMb * 1024 * 1024,
    contentType: contentTypeFor(fileName),
  };
}

function parseRangeHeader(rangeHeader, totalBytes) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }

  const [startRaw, endRaw] = rangeHeader.slice('bytes='.length).split('-', 2);
  let start = startRaw === '' ? null : Number(startRaw);
  let end = endRaw === '' ? null : Number(endRaw);

  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) {
    return { invalid: true };
  }

  if (start === null && end === null) {
    return { invalid: true };
  }

  if (start === null) {
    const suffixLength = end;
    if (suffixLength <= 0) {
      return { invalid: true };
    }
    start = Math.max(0, totalBytes - suffixLength);
    end = totalBytes - 1;
  } else {
    if (end === null || end >= totalBytes) {
      end = totalBytes - 1;
    }
  }

  if (start < 0 || end < start || start >= totalBytes) {
    return { invalid: true };
  }

  return { start, end };
}

function byteAt(position) {
  return (position * 31 + 17) & 0xff;
}

function writeDeterministicBytes(res, start, end) {
  const chunkSize = 64 * 1024;
  let cursor = start;

  function pump() {
    while (cursor <= end) {
      const remaining = end - cursor + 1;
      const size = Math.min(chunkSize, remaining);
      const buffer = Buffer.allocUnsafe(size);
      for (let i = 0; i < size; i += 1) {
        buffer[i] = byteAt(cursor + i);
      }
      cursor += size;
      if (!res.write(buffer)) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  }

  pump();
}

function serveGeneratedFile(req, res, scenario, options = {}) {
  const { totalBytes, fileName, contentType } = scenario;
  const dispositionType = options.inline ? 'inline' : 'attachment';
  const range = parseRangeHeader(req.headers.range, totalBytes);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Trinity-Harness-Scenario', options.scenarioName || 'generated');

  if (range?.invalid) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${totalBytes}`);
    res.end();
    return;
  }

  const isHead = req.method === 'HEAD';
  if (range) {
    const { start, end } = range;
    const contentLength = end - start + 1;
    res.statusCode = 206;
    res.setHeader('Content-Length', String(contentLength));
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalBytes}`);
    if (isHead) {
      res.end();
      return;
    }
    writeDeterministicBytes(res, start, end);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Length', String(totalBytes));
  if (isHead) {
    res.end();
    return;
  }

  writeDeterministicBytes(res, 0, totalBytes - 1);
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function serveStaticAsset(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';

  const body = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sessionIsValid(req) {
  const cookies = getCookieMap(req);
  const sessionId = cookies.get(SESSION_COOKIE);
  if (!sessionId) {
    return false;
  }
  const expiresAt = activeSessions.get(sessionId);
  return typeof expiresAt === 'number' && expiresAt > now();
}

function createSession() {
  const sessionId = randomUUID();
  activeSessions.set(sessionId, now() + 30 * 60 * 1000);
  return sessionId;
}

async function router(req, res) {
  cleanupSessions();
  const baseUrl = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const url = new URL(req.url || '/', baseUrl);

  if (req.method === 'GET' && url.pathname === '/') {
    await serveStaticAsset(res, path.join(__dirname, 'site', 'index.html'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/app.js') {
    await serveStaticAsset(res, path.join(__dirname, 'site', 'app.js'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/styles.css') {
    await serveStaticAsset(res, path.join(__dirname, 'site', 'styles.css'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      scenarios: ['direct', 'redirect', 'gated', 'js-triggered', 'resumable'],
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session/start') {
    const sessionId = createSession();
    sendJson(
      res,
      200,
      {
        ok: true,
        sessionId,
      },
      {
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`,
      },
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session/status') {
    sendJson(res, 200, {
      ok: true,
      sessionActive: sessionIsValid(req),
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/download/direct') {
    const scenario = resolveScenario(url);
    serveGeneratedFile(req, res, scenario, { scenarioName: 'direct-static-file' });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/download/resumable-large') {
    const scenario = resolveScenario(new URL(`${baseUrl}/download/resumable-large?sizeMb=256&name=trinity-resumable-256mb.bin`));
    serveGeneratedFile(req, res, scenario, { scenarioName: 'resumable-large-file' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/download/redirect') {
    const target = new URL('/download/direct', baseUrl);
    target.search = url.search;
    res.writeHead(302, {
      Location: target.toString(),
      'Cache-Control': 'no-store',
      'X-Trinity-Harness-Scenario': 'redirected-file',
    });
    res.end();
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/download/gated') {
    if (!sessionIsValid(req)) {
      sendJson(res, 403, {
        ok: false,
        error: 'Missing or expired test harness session cookie.',
      });
      return;
    }

    const scenario = resolveScenario(url);
    serveGeneratedFile(req, res, scenario, { scenarioName: 'browser-managed-gated-file' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/download/js-programmatic') {
    const scenario = resolveScenario(url);
    serveGeneratedFile(req, res, scenario, { scenarioName: 'js-programmatic-download' });
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}

const server = createServer((req, res) => {
  router(req, res).catch((error) => {
    const body = html(`<pre>${String(error?.stack || error)}</pre>`);
    res.writeHead(500, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Trinity download test harness running at http://${HOST}:${PORT}`);
});
