import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';

const KEY = 'test-api-key-with-enough-length';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fileupload-test-'));
  const { app } = await createApp({ dataDir, initialApiKey: KEY, publicUrl: 'https://files.example.test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, dataDir };
}

test('health endpoint is public and file list is protected', async t => {
  const { baseUrl } = await fixture(t);
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(`${baseUrl}/api/files`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/files`, { headers: { 'x-api-key': KEY } })).status, 200);
});

test('uploads, lists, previews, and deletes a file', async t => {
  const { baseUrl } = await fixture(t);
  const form = new FormData();
  form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'hello world.txt');
  const upload = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: { 'x-api-key': KEY }, body: form });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.match(uploaded.url, /^https:\/\/files\.example\.test\/f\//);
  assert.equal(uploaded.name, 'hello world.txt');

  const list = await fetch(`${baseUrl}/api/files`, { headers: { authorization: `Bearer ${KEY}` } });
  const body = await list.json();
  assert.equal(body.files.length, 1);

  const preview = await fetch(uploaded.url.replace('https://files.example.test', baseUrl));
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
  assert.equal(await preview.text(), 'hello world');

  const removed = await fetch(`${baseUrl}/api/files/${uploaded.id}`, { method: 'DELETE', headers: { 'x-api-key': KEY } });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(uploaded.url.replace('https://files.example.test', baseUrl))).status, 404);
});

test('dashboard login and API key rotation invalidate old access', async t => {
  const { baseUrl } = await fixture(t);
  const login = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ apiKey: KEY })
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${baseUrl}/api/files`, { headers: { cookie } })).status, 200);

  const rotatedResponse = await fetch(`${baseUrl}/api/settings/rotate-key`, { method: 'POST', headers: { cookie } });
  assert.equal(rotatedResponse.status, 200);
  const { apiKey } = await rotatedResponse.json();
  assert.match(apiKey, /^fu_/);
  assert.equal((await fetch(`${baseUrl}/api/files`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/files`, { headers: { 'x-api-key': KEY } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/files`, { headers: { 'x-api-key': apiKey } })).status, 200);
});

test('storage path changes affect future uploads', async t => {
  const { baseUrl, dataDir } = await fixture(t);
  const storagePath = path.join(dataDir, 'alternate');
  const update = await fetch(`${baseUrl}/api/settings/storage`, {
    method: 'PUT',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ storagePath })
  });
  assert.equal(update.status, 200);

  const form = new FormData();
  form.append('file', new Blob(['stored elsewhere']), 'alternate.txt');
  const upload = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { 'x-api-key': KEY }, body: form });
  assert.equal(upload.status, 201);
  assert.equal((await fs.readdir(storagePath)).length, 1);
});
