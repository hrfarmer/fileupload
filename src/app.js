import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import multer from 'multer';
import { FileStore } from './store.js';

const PREVIEWABLE = new Set([
  'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/ogg', 'video/quicktime', 'video/webm', 'application/pdf', 'text/plain'
]);

const MIME_EXTENSIONS = new Map([
  ['image/avif', '.avif'], ['image/gif', '.gif'], ['image/heic', '.heic'],
  ['image/heif', '.heif'], ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
  ['audio/aac', '.aac'], ['audio/flac', '.flac'], ['audio/mpeg', '.mp3'], ['audio/mp4', '.m4a'],
  ['audio/ogg', '.ogg'], ['audio/wav', '.wav'], ['audio/webm', '.webm'],
  ['video/mp4', '.mp4'], ['video/ogg', '.ogv'], ['video/quicktime', '.mov'], ['video/webm', '.webm'],
  ['application/json', '.json'], ['application/pdf', '.pdf'], ['text/plain', '.txt']
]);

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split('='))
    .filter(parts => parts.length === 2).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function safeFilename(value) {
  const cleaned = path.basename(value || 'file').replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim();
  return cleaned.slice(0, 180) || 'file';
}

function requestFilename(req, mimeType, id) {
  let filename = req.get('x-filename') || req.query.filename;
  const disposition = req.get('content-disposition') || '';
  if (!filename) {
    const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
    filename = encodedMatch?.[1] || plainMatch?.[1];
  }
  if (filename) {
    try { filename = decodeURIComponent(filename); } catch {}
  }
  return safeFilename(filename || `upload-${id}${MIME_EXTENSIONS.get(mimeType) || '.bin'}`);
}

function publicBaseUrl(req, configured) {
  return (configured || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function fileView(file, req, configuredUrl) {
  return {
    id: file.id,
    name: file.originalName,
    type: file.mimeType,
    size: file.size,
    createdAt: file.createdAt,
    url: `${publicBaseUrl(req, configuredUrl)}/a/${file.id}`
  };
}

export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || './data');
  const initialApiKey = options.initialApiKey || process.env.INITIAL_API_KEY;
  const publicUrl = options.publicUrl ?? process.env.PUBLIC_URL ?? '';
  const maxUploadBytes = Number(options.maxUploadBytes || process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);
  const store = new FileStore({ dataDir, initialApiKey, defaultStoragePath: path.join(dataDir, 'uploads') });
  await store.init();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const isUploadRequest = req => req.method === 'POST' && (req.path === '/api/upload' || req.path === '/upload');
  app.use(express.json({ limit: '32kb', type: req => !isUploadRequest(req) && req.is('application/json') }));
  app.use(express.urlencoded({ extended: false, limit: '32kb', type: req => !isUploadRequest(req) && req.is('application/x-www-form-urlencoded') }));
  app.use('/assets', express.static(new URL('./public', import.meta.url).pathname, { maxAge: '1h' }));

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, file, callback) { callback(null, store.settings.storagePath); },
      filename(req, file, callback) {
        req.uploadId = store.createFileId();
        callback(null, req.uploadId);
      }
    }),
    limits: { fileSize: maxUploadBytes, files: 1 }
  });

  const hasSession = req => store.verifySession(parseCookies(req.headers.cookie).fileupload_session);
  const suppliedKey = req => req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';

  async function authenticate(req, res, next) {
    if (hasSession(req) || await store.verifyApiKey(suppliedKey(req))) return next();
    res.status(401).json({ error: 'A valid API key is required.' });
  }

  function dashboardAuth(req, res, next) {
    if (hasSession(req)) return next();
    return res.redirect('/login');
  }

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/login', (req, res) => hasSession(req) ? res.redirect('/') : res.sendFile(new URL('./public/login.html', import.meta.url).pathname));
  app.post('/login', async (req, res) => {
    if (!await store.verifyApiKey(req.body.apiKey)) return res.redirect('/login?error=1');
    res.cookie('fileupload_session', store.createSession(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    res.clearCookie('fileupload_session', { path: '/' });
    res.redirect('/login');
  });
  app.get('/', dashboardAuth, (req, res) => res.sendFile(new URL('./public/index.html', import.meta.url).pathname));

  app.get('/api/files', authenticate, (req, res) => {
    res.json({ files: store.listFiles().map(file => fileView(file, req, publicUrl)) });
  });

  async function saveRecord(record, req, res, next) {
    try {
      await store.addFile(record);
      res.status(201).json(fileView(record, req, publicUrl));
    } catch (error) {
      await fs.unlink(record.path).catch(() => {});
      next(error);
    }
  }

  async function acceptUpload(req, res, next) {
    if (req.file) {
      return saveRecord({
        id: req.uploadId,
        originalName: safeFilename(req.file.originalname),
        mimeType: req.file.mimetype || 'application/octet-stream',
        size: req.file.size,
        path: path.resolve(req.file.path),
        createdAt: new Date().toISOString()
      }, req, res, next);
    }

    if (req.is('multipart/form-data')) {
      return res.status(400).json({ error: 'Send one file in the multipart field named "file".' });
    }

    const declaredSize = Number(req.get('content-length') || 0);
    if (declaredSize > maxUploadBytes) {
      return res.status(413).json({ error: `File exceeds the ${maxUploadBytes}-byte limit.` });
    }

    const id = store.createFileId();
    const filePath = path.resolve(store.settings.storagePath, id);
    const mimeType = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    let size = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxUploadBytes) {
          const error = new Error('Upload size limit exceeded');
          error.code = 'LIMIT_FILE_SIZE';
          return callback(error);
        }
        callback(null, chunk);
      }
    });

    try {
      await pipeline(req, limiter, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
      if (size === 0) {
        await fs.unlink(filePath).catch(() => {});
        return res.status(400).json({ error: 'Send a file as the request body or as multipart field "file".' });
      }
      return saveRecord({
        id,
        originalName: requestFilename(req, mimeType, id),
        mimeType,
        size,
        path: filePath,
        createdAt: new Date().toISOString()
      }, req, res, next);
    } catch (error) {
      await fs.unlink(filePath).catch(() => {});
      next(error);
    }
  }

  const handleUpload = [authenticate, upload.single('file'), acceptUpload];
  app.post('/api/upload', ...handleUpload);
  app.post('/upload', ...handleUpload);

  app.delete('/api/files/:id', authenticate, async (req, res, next) => {
    try {
      const removed = await store.deleteFile(req.params.id);
      if (!removed) return res.status(404).json({ error: 'File not found.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.get('/api/settings', authenticate, (req, res) => res.json({
    storagePath: store.settings.storagePath,
    publicUrl: publicBaseUrl(req, publicUrl),
    maxUploadBytes
  }));

  app.put('/api/settings/storage', authenticate, async (req, res, next) => {
    if (typeof req.body.storagePath !== 'string' || !path.isAbsolute(req.body.storagePath)) {
      return res.status(400).json({ error: 'storagePath must be an absolute path.' });
    }
    try {
      const storagePath = await store.updateStoragePath(req.body.storagePath);
      res.json({ storagePath });
    } catch (error) { next(error); }
  });

  app.post('/api/settings/rotate-key', authenticate, async (req, res, next) => {
    try {
      const apiKey = await store.rotateApiKey();
      res.json({ apiKey, message: 'Save this key now. It will not be shown again.' });
    } catch (error) { next(error); }
  });

  app.get('/a/:id', async (req, res, next) => {
    const file = store.getFile(req.params.id);
    if (!file) return res.status(404).sendFile(new URL('./public/not-found.html', import.meta.url).pathname);
    try {
      await fs.access(file.path, fs.constants.R_OK);
      const disposition = PREVIEWABLE.has(file.mimeType) ? 'inline' : 'attachment';
      res.set({
        'Content-Type': file.mimeType,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600'
      });
      res.sendFile(file.path);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).sendFile(new URL('./public/not-found.html', import.meta.url).pathname);
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File exceeds the ${maxUploadBytes}-byte limit.` });
    }
    console.error(error);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return { app, store };
}
