/* Docflow UI — intentionally framework-free so it can be served directly by FastAPI. */

const state = {
  documents: [],
  selectedId: null,
  checkedIds: new Set(),
  markdown: new Map(),
  uploadFiles: [],
  pollTimer: null,
  loading: false,
};

const el = {
  connectionStatus: document.querySelector('#connection-status'),
  documentsBody: document.querySelector('#documents-body'),
  tableLoading: document.querySelector('#table-loading'),
  tableEmpty: document.querySelector('#table-empty'),
  documentCount: document.querySelector('#document-count'),
  selectionSummary: document.querySelector('#selection-summary'),
  search: document.querySelector('#search-input'),
  selectAll: document.querySelector('#select-all'),
  bulkConvert: document.querySelector('#bulk-convert'),
  uploadButton: document.querySelector('#upload-button'),
  uploadDialog: document.querySelector('#upload-dialog'),
  uploadForm: document.querySelector('#upload-form'),
  closeUpload: document.querySelector('#close-upload'),
  fileInput: document.querySelector('#file-input'),
  dropZone: document.querySelector('#drop-zone'),
  uploadQueue: document.querySelector('#upload-queue'),
  startUpload: document.querySelector('#start-upload'),
  detailEmpty: document.querySelector('#detail-empty'),
  detailContent: document.querySelector('#detail-content'),
  detailFileIcon: document.querySelector('#detail-file-icon'),
  detailFileType: document.querySelector('#detail-file-type'),
  detailName: document.querySelector('#detail-name'),
  detailMeta: document.querySelector('#detail-meta'),
  detailState: document.querySelector('#detail-state'),
  detailStatus: document.querySelector('#detail-status'),
  convertButton: document.querySelector('#convert-button'),
  retryButton: document.querySelector('#retry-button'),
  closeDetail: document.querySelector('#close-detail'),
  failureMessage: document.querySelector('#failure-message'),
  conversionTime: document.querySelector('#conversion-time'),
  markdownPreview: document.querySelector('#markdown-preview'),
  copyMarkdown: document.querySelector('#copy-markdown'),
  downloadMarkdown: document.querySelector('#download-markdown'),
  activity: document.querySelector('#activity-list'),
  refresh: document.querySelector('#refresh-button'),
  toast: document.querySelector('#toast-region'),
};

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function bytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1);
  const rounded = amount / Math.pow(1024, index);
  return `${rounded >= 10 || index === 0 ? Math.round(rounded) : rounded.toFixed(1)} ${units[index]}`;
}

function relativeTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const steps = [
    [60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year'],
  ];
  let duration = seconds;
  for (const [limit, unit] of steps) {
    if (Math.abs(duration) < limit) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(duration), unit);
    }
    duration /= limit;
  }
  return date.toLocaleDateString();
}

function canonicalStatus(value) {
  const status = String(value || 'ready').toLowerCase();
  if (['complete', 'completed', 'success', 'succeeded', 'done'].includes(status)) return 'complete';
  if (['queued', 'pending', 'waiting'].includes(status)) return 'queued';
  if (['converting', 'processing', 'running', 'in_progress'].includes(status)) return 'converting';
  if (['failed', 'error', 'cancelled'].includes(status)) return 'failed';
  return 'ready';
}

function prettyStatus(status) {
  return ({ ready: 'Ready', queued: 'Queued', converting: 'Converting', complete: 'Complete', failed: 'Failed' })[status] || 'Ready';
}

function extensionFor(doc) {
  const candidate = doc.extension || doc.file_type || doc.type || doc.mime_type || doc.mimeType || '';
  const fromName = String(doc.name || doc.filename || '').split('.').pop();
  const ext = String(candidate).includes('/') ? String(candidate).split('/').pop() : candidate;
  return String(ext || fromName || 'file').toLowerCase().replace(/^\./, '').replace('vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx').replace('vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx').replace('vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
}

function fileClass(type) {
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'image'].includes(type)) return 'image';
  if (['pdf', 'pptx', 'docx', 'xlsx', 'csv'].includes(type)) return type;
  return '';
}

function normalizeDocument(raw) {
  const output = raw || {};
  const markdown = output.markdown ?? output.markdown_content ?? output.content?.markdown;
  const status = canonicalStatus(output.status ?? output.conversion_status ?? (markdown ? 'complete' : 'ready'));
  const doc = {
    id: String(output.id ?? output.document_id ?? output.uuid ?? ''),
    name: output.name ?? output.filename ?? output.file_name ?? 'Untitled document',
    size: output.sizeBytes ?? output.size_bytes ?? output.size ?? output.byte_size ?? 0,
    mimeType: output.mime_type ?? output.mimeType ?? '',
    extension: output.extension ?? output.file_type ?? output.type ?? '',
    status,
    updatedAt: output.updated_at ?? output.updatedAt ?? output.created_at ?? output.createdAt,
    convertedAt: output.converted_at ?? output.convertedAt ?? output.completed_at ?? output.completedAt,
    conversionId: output.conversion_id ?? output.conversionId ?? output.latest_conversion_id ?? output.conversion?.id,
    error: typeof output.error === 'string' ? output.error : output.error?.message ?? output.error_message ?? '',
    raw: output,
  };
  if (markdown != null) state.markdown.set(doc.id, String(markdown));
  return doc;
}

function getSelected() {
  return state.documents.find((doc) => doc.id === state.selectedId) || null;
}

function visibleDocuments() {
  const query = el.search.value.trim().toLocaleLowerCase();
  if (!query) return state.documents;
  return state.documents.filter((doc) => [doc.name, extensionFor(doc), doc.status].join(' ').toLocaleLowerCase().includes(query));
}

async function readResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : payload.detail || payload.message || payload.error?.message || 'Request could not be completed.';
    throw new Error(detail);
  }
  return payload;
}

function setConnection(online) {
  el.connectionStatus.classList.remove('online', 'offline');
  el.connectionStatus.classList.add(online ? 'online' : 'offline');
  el.connectionStatus.innerHTML = `<i></i> ${online ? 'Workflow ready' : 'Service unavailable'}`;
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<span>${kind === 'success' ? '✓' : kind === 'error' ? '!' : '•'}</span><div>${escapeHTML(message)}</div>`;
  el.toast.append(node);
  window.setTimeout(() => node.remove(), 4800);
}

function renderDocuments() {
  const docs = visibleDocuments();
  const selected = getSelected();
  el.documentsBody.innerHTML = '';
  el.documentCount.textContent = String(state.documents.length);
  el.tableLoading.classList.add('hidden');
  el.tableEmpty.classList.toggle('hidden', state.documents.length !== 0);

  for (const doc of docs) {
    const type = extensionFor(doc).toUpperCase().slice(0, 5) || 'FILE';
    const row = document.createElement('tr');
    row.className = selected?.id === doc.id ? 'is-selected' : '';
    row.dataset.id = doc.id;
    row.innerHTML = `
      <td><input class="row-checkbox" type="checkbox" data-id="${escapeHTML(doc.id)}" aria-label="Select ${escapeHTML(doc.name)}" ${state.checkedIds.has(doc.id) ? 'checked' : ''} /></td>
      <td><div class="doc-cell"><span class="file-icon ${fileClass(extensionFor(doc))}">${escapeHTML(type)}</span><div><div class="doc-name" title="${escapeHTML(doc.name)}">${escapeHTML(doc.name)}</div><div class="doc-size">${bytes(doc.size)}</div></div></div></td>
      <td><span class="file-type">${escapeHTML(type)}</span></td>
      <td><span class="status ${doc.status}">${prettyStatus(doc.status)}</span></td>
      <td><span class="updated">${escapeHTML(relativeTime(doc.updatedAt))}</span></td>
      <td><button class="row-action" data-action="convert" data-id="${escapeHTML(doc.id)}" type="button">${doc.status === 'complete' ? 'View' : doc.status === 'converting' || doc.status === 'queued' ? 'Working…' : doc.status === 'failed' ? 'Retry' : 'Convert'}</button></td>`;
    el.documentsBody.append(row);
  }

  const visibleChecked = docs.filter((doc) => state.checkedIds.has(doc.id));
  el.selectAll.checked = docs.length > 0 && visibleChecked.length === docs.length;
  el.selectAll.indeterminate = visibleChecked.length > 0 && visibleChecked.length < docs.length;
  el.bulkConvert.disabled = state.checkedIds.size === 0;
  el.bulkConvert.textContent = state.checkedIds.size ? `Convert selected (${state.checkedIds.size})` : 'Convert selected';

  if (state.checkedIds.size) {
    el.selectionSummary.textContent = `${state.checkedIds.size} document${state.checkedIds.size === 1 ? '' : 's'} selected for conversion.`;
  } else if (state.documents.length) {
    el.selectionSummary.textContent = 'Select rows to run more than one conversion.';
  } else {
    el.selectionSummary.textContent = 'Choose a document to inspect it.';
  }
}

function statusCopy(doc) {
  if (!doc) return '';
  if (doc.status === 'complete') return 'Markdown is ready to inspect or download.';
  if (doc.status === 'queued') return 'Waiting for a conversion worker.';
  if (doc.status === 'converting') return 'MarkItDown is extracting this document.';
  if (doc.status === 'failed') return 'The last conversion did not finish.';
  return 'This source is ready for conversion.';
}

function renderDetail() {
  const doc = getSelected();
  const hasDoc = Boolean(doc);
  el.detailEmpty.classList.toggle('hidden', hasDoc);
  el.detailContent.classList.toggle('hidden', !hasDoc);
  if (!doc) return;

  const type = extensionFor(doc).toUpperCase().slice(0, 5) || 'FILE';
  el.detailFileIcon.textContent = type;
  el.detailFileIcon.className = `file-icon large ${fileClass(extensionFor(doc))}`;
  el.detailFileType.textContent = `${type} SOURCE`;
  el.detailName.textContent = doc.name;
  el.detailName.title = doc.name;
  el.detailMeta.textContent = `${bytes(doc.size)} · Updated ${relativeTime(doc.updatedAt)}`;
  el.detailState.className = `conversion-state ${doc.status}`;
  el.detailStatus.textContent = statusCopy(doc);
  el.convertButton.classList.toggle('hidden', doc.status === 'failed');
  el.retryButton.classList.toggle('hidden', doc.status !== 'failed');
  el.convertButton.disabled = ['queued', 'converting', 'complete'].includes(doc.status);
  el.convertButton.textContent = doc.status === 'converting' ? 'Converting…' : doc.status === 'queued' ? 'Queued for conversion…' : doc.status === 'complete' ? 'Markdown ready' : 'Convert to Markdown';
  el.failureMessage.classList.toggle('hidden', doc.status !== 'failed' || !doc.error);
  el.failureMessage.textContent = doc.error || '';
  const markdown = state.markdown.get(doc.id);
  const isComplete = doc.status === 'complete' && typeof markdown === 'string';
  el.copyMarkdown.disabled = !isComplete;
  el.downloadMarkdown.disabled = !(doc.status === 'complete' && doc.conversionId);
  el.conversionTime.textContent = doc.convertedAt ? `Converted ${relativeTime(doc.convertedAt)}` : doc.status === 'converting' ? 'Conversion in progress' : 'Nothing converted yet';

  if (isComplete) {
    const pre = document.createElement('pre');
    pre.className = 'markdown-code';
    pre.textContent = markdown;
    el.markdownPreview.replaceChildren(pre);
  } else if (doc.status === 'converting' || doc.status === 'queued') {
    el.markdownPreview.innerHTML = '<div class="preview-placeholder"><span class="spinner" aria-hidden="true"></span><span>Preparing Markdown preview…</span></div>';
  } else {
    el.markdownPreview.innerHTML = '<div class="preview-placeholder">The extracted Markdown will be shown here.</div>';
  }
}

function renderActivity() {
  const recent = [...state.documents]
    .filter((doc) => doc.status !== 'ready')
    .sort((a, b) => new Date(b.convertedAt || b.updatedAt || 0) - new Date(a.convertedAt || a.updatedAt || 0))
    .slice(0, 3);
  if (!recent.length) {
    el.activity.innerHTML = '<p class="activity-empty">No conversions are running.</p>';
    return;
  }
  el.activity.innerHTML = recent.map((doc) => {
    const type = extensionFor(doc).toUpperCase().slice(0, 5) || 'FILE';
    const label = doc.status === 'complete' ? 'Markdown generated' : doc.status === 'failed' ? 'Needs your attention' : doc.status === 'queued' ? 'Waiting in queue' : 'Extracting content';
    return `<article class="activity-item"><span class="file-icon ${fileClass(extensionFor(doc))}">${escapeHTML(type)}</span><div class="activity-content"><div class="activity-top"><p class="activity-title" title="${escapeHTML(doc.name)}">${escapeHTML(doc.name)}</p><span class="activity-time">${escapeHTML(relativeTime(doc.convertedAt || doc.updatedAt))}</span></div><p><span class="status ${doc.status}">${escapeHTML(label)}</span></p></div></article>`;
  }).join('');
}

function render() {
  renderDocuments();
  renderDetail();
  renderActivity();
}

function mergeDocument(update) {
  const normalized = normalizeDocument(update);
  if (!normalized.id) return;
  const index = state.documents.findIndex((doc) => doc.id === normalized.id);
  if (index === -1) state.documents.unshift(normalized);
  else {
    const previous = state.documents[index];
    state.documents[index] = { ...previous, ...normalized, raw: { ...previous.raw, ...normalized.raw } };
  }
}

async function loadMarkdown(doc, quietly = false) {
  if (!doc || state.markdown.has(doc.id) || doc.status !== 'complete') return;
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(doc.id)}/markdown`, { headers: { Accept: 'application/json, text/markdown;q=0.9' } });
    const body = await readResponse(response);
    const markdown = typeof body === 'string' ? body : body.markdown ?? body.content ?? body.data?.markdown ?? '';
    state.markdown.set(doc.id, String(markdown));
    if (doc.id === state.selectedId) renderDetail();
  } catch (error) {
    if (!quietly) toast(`Could not load Markdown: ${error.message}`, 'error');
  }
}

async function loadDocuments({ quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    el.tableLoading.classList.remove('hidden');
  }
  try {
    const response = await fetch('/api/documents', { cache: 'no-store', headers: { Accept: 'application/json' } });
    const body = await readResponse(response);
    const entries = Array.isArray(body) ? body : body.documents ?? body.data ?? body.items ?? [];
    state.documents = entries.map(normalizeDocument).filter((doc) => doc.id);
    for (const id of [...state.checkedIds]) if (!state.documents.some((doc) => doc.id === id)) state.checkedIds.delete(id);
    if (state.selectedId && !state.documents.some((doc) => doc.id === state.selectedId)) state.selectedId = null;
    setConnection(true);
    render();
    const selected = getSelected();
    if (selected?.status === 'complete') await loadMarkdown(selected, true);
  } catch (error) {
    setConnection(false);
    if (!quiet) {
      el.tableLoading.classList.add('hidden');
      toast(`Could not reach the workflow service: ${error.message}`, 'error');
    }
  } finally {
    state.loading = false;
  }
}

async function selectDocument(id) {
  state.selectedId = id;
  render();
  const doc = getSelected();
  if (doc?.status === 'complete') await loadMarkdown(doc);
}

function extractionUpdate(body, fallback) {
  if (!body || typeof body === 'string') return fallback;
  return body.document ?? body.data?.document ?? body;
}

async function convertDocument(id) {
  const doc = state.documents.find((entry) => entry.id === id);
  if (!doc || ['queued', 'converting'].includes(doc.status)) return;
  doc.status = 'queued';
  doc.error = '';
  render();
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}/convert`, { method: 'POST', headers: { Accept: 'application/json' } });
    const body = await readResponse(response);
    const update = extractionUpdate(body, doc);
    mergeDocument({ ...doc, ...update, conversion_id: update?.conversion_id ?? update?.conversion?.id ?? body?.conversion_id ?? body?.conversion?.id ?? doc.conversionId, status: update?.status ?? body?.status ?? 'queued' });
    toast(`Conversion started for ${doc.name}.`, 'success');
    render();
    ensurePolling();
  } catch (error) {
    doc.status = 'failed';
    doc.error = error.message;
    render();
    toast(`Could not start conversion: ${error.message}`, 'error');
  }
}

async function convertChecked() {
  const candidates = [...state.checkedIds].filter((id) => ['ready', 'failed'].includes(state.documents.find((doc) => doc.id === id)?.status));
  if (!candidates.length) return;
  for (const id of candidates) await convertDocument(id);
}

function ensurePolling() {
  const active = state.documents.some((doc) => ['queued', 'converting'].includes(doc.status));
  if (active && !state.pollTimer) {
    state.pollTimer = window.setInterval(() => loadDocuments({ quiet: true }), 2200);
  } else if (!active && state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function openUpload() {
  state.uploadFiles = [];
  el.fileInput.value = '';
  renderUploadQueue();
  if (typeof el.uploadDialog.showModal === 'function') el.uploadDialog.showModal();
  else el.uploadDialog.setAttribute('open', '');
}

function closeUpload() {
  if (typeof el.uploadDialog.close === 'function') el.uploadDialog.close();
  else el.uploadDialog.removeAttribute('open');
}

function setUploadFiles(files) {
  state.uploadFiles = Array.from(files || []);
  renderUploadQueue();
}

function renderUploadQueue() {
  const files = state.uploadFiles;
  el.startUpload.disabled = !files.length;
  el.startUpload.textContent = files.length > 1 ? `Upload ${files.length} documents` : 'Upload document';
  el.uploadQueue.classList.toggle('hidden', !files.length);
  el.uploadQueue.innerHTML = files.map((file) => `<div class="queue-file"><span class="queue-file-name">${escapeHTML(file.name)}</span><span class="queue-file-size">${bytes(file.size)}</span></div>`).join('');
}

async function uploadFiles(event) {
  event.preventDefault();
  if (!state.uploadFiles.length) return;
  el.startUpload.disabled = true;
  el.startUpload.textContent = 'Uploading…';
  let succeeded = 0;
  let failure = null;
  for (const file of state.uploadFiles) {
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const response = await fetch('/api/documents', { method: 'POST', body: form, headers: { Accept: 'application/json' } });
      const body = await readResponse(response);
      const candidate = body.document ?? body.data ?? body;
      if (candidate?.id || candidate?.document_id) mergeDocument(candidate);
      succeeded += 1;
    } catch (error) {
      failure = error;
    }
  }
  await loadDocuments({ quiet: true });
  ensurePolling();
  if (succeeded) toast(`${succeeded} document${succeeded === 1 ? '' : 's'} added to the docs table.`, 'success');
  if (failure) toast(`Some files could not be uploaded: ${failure.message}`, 'error');
  if (!failure) closeUpload();
  el.startUpload.disabled = false;
  renderUploadQueue();
}

async function copyMarkdown() {
  const doc = getSelected();
  const markdown = doc ? state.markdown.get(doc.id) : '';
  if (!markdown) return;
  try {
    await navigator.clipboard.writeText(markdown);
    toast('Markdown copied to your clipboard.', 'success');
  } catch {
    const area = document.createElement('textarea');
    area.value = markdown;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('Markdown copied to your clipboard.', 'success');
  }
}

function downloadMarkdown() {
  const doc = getSelected();
  if (!doc?.conversionId) {
    toast('The server has not supplied a downloadable conversion yet.', 'error');
    return;
  }
  const link = document.createElement('a');
  link.href = `/api/conversions/${encodeURIComponent(doc.conversionId)}/download`;
  link.download = `${doc.name.replace(/\.[^.]+$/, '') || 'document'}.md`;
  document.body.append(link);
  link.click();
  link.remove();
}

function bindEvents() {
  el.search.addEventListener('input', renderDocuments);
  el.documentsBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const checkbox = event.target.closest('.row-checkbox');
    const action = event.target.closest('[data-action="convert"]');
    if (checkbox) {
      if (checkbox.checked) state.checkedIds.add(id);
      else state.checkedIds.delete(id);
      renderDocuments();
      return;
    }
    if (action) {
      if (action.textContent === 'View') selectDocument(id);
      else convertDocument(id);
      return;
    }
    selectDocument(id);
  });
  el.selectAll.addEventListener('change', () => {
    for (const doc of visibleDocuments()) {
      if (el.selectAll.checked) state.checkedIds.add(doc.id);
      else state.checkedIds.delete(doc.id);
    }
    renderDocuments();
  });
  el.bulkConvert.addEventListener('click', convertChecked);
  el.convertButton.addEventListener('click', () => getSelected() && convertDocument(getSelected().id));
  el.retryButton.addEventListener('click', () => getSelected() && convertDocument(getSelected().id));
  el.closeDetail.addEventListener('click', () => { state.selectedId = null; render(); });
  el.copyMarkdown.addEventListener('click', copyMarkdown);
  el.downloadMarkdown.addEventListener('click', downloadMarkdown);
  el.refresh.addEventListener('click', () => loadDocuments());
  el.uploadButton.addEventListener('click', openUpload);
  document.querySelectorAll('.empty-upload').forEach((button) => button.addEventListener('click', openUpload));
  el.closeUpload.addEventListener('click', closeUpload);
  el.fileInput.addEventListener('change', () => setUploadFiles(el.fileInput.files));
  el.uploadForm.addEventListener('submit', uploadFiles);
  for (const eventName of ['dragenter', 'dragover']) el.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); el.dropZone.classList.add('dragging'); });
  for (const eventName of ['dragleave', 'drop']) el.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); el.dropZone.classList.remove('dragging'); });
  el.dropZone.addEventListener('drop', (event) => setUploadFiles(event.dataTransfer?.files));
  window.addEventListener('focus', () => loadDocuments({ quiet: true }));
}

async function init() {
  bindEvents();
  await loadDocuments();
  ensurePolling();
}

init();
