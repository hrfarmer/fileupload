import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const scrypt = (value, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(value, salt, 64, (error, key) => error ? reject(error) : resolve(key));
});

async function hashKey(value) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(value, salt);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyKey(value, encoded) {
  if (!value || !encoded || !encoded.includes(':')) return false;
  const [saltHex, hashHex] = encoded.split(':');
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(value, Buffer.from(saltHex, 'hex'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function atomicJsonWrite(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

export class FileStore {
  constructor({ dataDir, initialApiKey, defaultStoragePath }) {
    this.dataDir = path.resolve(dataDir);
    this.settingsPath = path.join(this.dataDir, 'settings.json');
    this.filesPath = path.join(this.dataDir, 'files.json');
    this.initialApiKey = initialApiKey;
    this.defaultStoragePath = path.resolve(defaultStoragePath);
    this.settings = null;
    this.files = [];
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      this.settings = JSON.parse(await fs.readFile(this.settingsPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!this.initialApiKey || this.initialApiKey.length < 16) {
        throw new Error('INITIAL_API_KEY must be at least 16 characters on first start');
      }
      this.settings = {
        apiKeyHash: await hashKey(this.initialApiKey),
        apiGeneration: 1,
        sessionSecret: crypto.randomBytes(32).toString('hex'),
        storagePath: this.defaultStoragePath
      };
      await atomicJsonWrite(this.settingsPath, this.settings);
    }

    try {
      this.files = JSON.parse(await fs.readFile(this.filesPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.files = [];
      await atomicJsonWrite(this.filesPath, this.files);
    }

    await this.ensureStoragePath(this.settings.storagePath);
  }

  async ensureStoragePath(storagePath) {
    if (!path.isAbsolute(storagePath)) throw new Error('Storage path must be absolute');
    await fs.mkdir(storagePath, { recursive: true });
    await fs.access(storagePath, fs.constants.R_OK | fs.constants.W_OK);
  }

  queueWrite(operation) {
    const queued = this.writeQueue.then(operation);
    this.writeQueue = queued.catch(() => {});
    return queued;
  }

  verifyApiKey(value) {
    return verifyKey(value, this.settings.apiKeyHash);
  }

  createSession() {
    const payload = `${this.settings.apiGeneration}.${Date.now() + (7 * 24 * 60 * 60 * 1000)}`;
    const signature = crypto.createHmac('sha256', this.settings.sessionSecret).update(payload).digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${signature}`;
  }

  verifySession(token) {
    if (!token || !token.includes('.')) return false;
    const [payloadEncoded, signature] = token.split('.');
    try {
      const payload = Buffer.from(payloadEncoded, 'base64url').toString();
      const [generation, expires] = payload.split('.').map(Number);
      const expected = crypto.createHmac('sha256', this.settings.sessionSecret).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      return generation === this.settings.apiGeneration && expires > Date.now() &&
        expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  listFiles() {
    return [...this.files].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getFile(id) {
    return this.files.find(file => file.id === id);
  }

  async addFile(file) {
    await this.queueWrite(async () => {
      this.files.push(file);
      await atomicJsonWrite(this.filesPath, this.files);
    });
  }

  async deleteFile(id) {
    return this.queueWrite(async () => {
      const index = this.files.findIndex(file => file.id === id);
      if (index === -1) return null;
      const [file] = this.files.splice(index, 1);
      try {
        await fs.unlink(file.path);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.files.splice(index, 0, file);
          throw error;
        }
      }
      await atomicJsonWrite(this.filesPath, this.files);
      return file;
    });
  }

  async updateStoragePath(storagePath) {
    const resolved = path.resolve(storagePath);
    await this.ensureStoragePath(resolved);
    await this.queueWrite(async () => {
      this.settings.storagePath = resolved;
      await atomicJsonWrite(this.settingsPath, this.settings);
    });
    return resolved;
  }

  async rotateApiKey() {
    const apiKey = `fu_${crypto.randomBytes(32).toString('base64url')}`;
    await this.queueWrite(async () => {
      this.settings.apiKeyHash = await hashKey(apiKey);
      this.settings.apiGeneration += 1;
      await atomicJsonWrite(this.settingsPath, this.settings);
    });
    return apiKey;
  }
}
