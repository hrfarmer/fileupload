const filesElement = document.querySelector('#files');
const countElement = document.querySelector('#count');
const input = document.querySelector('#fileInput');
const dropzone = document.querySelector('#dropzone');
const toastElement = document.querySelector('#toast');
const modal = document.querySelector('#settingsModal');
let toastTimer;

function toast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 2200);
}

function bytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = -1;
  do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

async function loadFiles() {
  const { files } = await api('/api/files');
  countElement.textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  if (!files.length) {
    filesElement.innerHTML = '<div class="empty">No files yet. Upload something above.</div>';
    return;
  }
  filesElement.innerHTML = files.map(file => `
    <div class="file-row" data-id="${file.id}">
      <div class="file-name"><a href="${file.url}" target="_blank" rel="noopener">${escapeHtml(file.name)}</a><small>${escapeHtml(file.type)}</small></div>
      <div class="cell">${bytes(file.size)}</div>
      <div class="cell">${new Date(file.createdAt).toLocaleString()}</div>
      <div class="row-actions">
        <button class="icon-button copy" data-url="${file.url}" title="Copy link">Copy</button>
        <button class="icon-button danger delete" title="Delete">Delete</button>
      </div>
    </div>`).join('');
}

async function uploadFiles(files) {
  for (const file of files) {
    document.querySelector('#uploadHint').textContent = `Uploading ${file.name}…`;
    const body = new FormData();
    body.append('file', file);
    const result = await api('/api/upload', { method: 'POST', body });
    await navigator.clipboard.writeText(result.url).catch(() => {});
    toast(`Uploaded ${file.name} · link copied`);
  }
  document.querySelector('#uploadHint').textContent = 'Each upload gets its own shareable link.';
  await loadFiles();
}

input.addEventListener('change', () => uploadFiles([...input.files]).catch(error => toast(error.message)));
for (const eventName of ['dragenter', 'dragover']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', event => uploadFiles([...event.dataTransfer.files]).catch(error => toast(error.message)));

filesElement.addEventListener('click', async event => {
  const row = event.target.closest('.file-row');
  if (event.target.closest('.copy')) {
    await navigator.clipboard.writeText(event.target.closest('.copy').dataset.url);
    toast('Link copied');
  }
  if (event.target.closest('.delete') && confirm('Permanently delete this file?')) {
    try { await api(`/api/files/${row.dataset.id}`, { method: 'DELETE' }); await loadFiles(); toast('File deleted'); }
    catch (error) { toast(error.message); }
  }
});

document.querySelector('#settingsButton').addEventListener('click', async () => {
  try {
    const settings = await api('/api/settings');
    document.querySelector('#storagePath').value = settings.storagePath;
    modal.showModal();
  } catch (error) { toast(error.message); }
});
document.querySelector('#closeSettings').addEventListener('click', () => modal.close());
document.querySelector('#saveStorage').addEventListener('click', async () => {
  try {
    await api('/api/settings/storage', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storagePath: document.querySelector('#storagePath').value }) });
    toast('Storage path saved');
  } catch (error) { toast(error.message); }
});
document.querySelector('#rotateKey').addEventListener('click', async () => {
  if (!confirm('Rotate the API key? Every existing session and client will lose access.')) return;
  try {
    const result = await api('/api/settings/rotate-key', { method: 'POST' });
    const box = document.querySelector('#newKey');
    box.textContent = result.apiKey;
    box.style.display = 'block';
    await navigator.clipboard.writeText(result.apiKey).catch(() => {});
    toast('New key copied — save it now');
  } catch (error) { toast(error.message); }
});

loadFiles().catch(error => toast(error.message));
