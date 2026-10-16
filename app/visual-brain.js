const nativeBridge = window.webkit?.messageHandlers?.raminStation;
const keyClick = new Audio('assets/key-click.mp3');
keyClick.preload = 'auto';
keyClick.volume = 0.42;

const STORAGE_KEY = 'ramin-station.visual-brain.v1';
const DB_NAME = 'ramin-station-visual-brain';
const DB_STORE = 'media';
const categories = new Set(['motivation', 'instagram', 'youtube', 'music', 'saved']);
const motivationLimit = 5;

const state = {version: 2, items: []};
let activeCategory = 'all';
let searchQuery = '';
let nativeRequestID = 0;
let saveTimer;
let toastTimer;
let dragDepth = 0;
let contextItemID = '';
let activeVisualDownloadID = '';
let mediaDatabase;
let renderedObjectURLs = [];

const nativeRequests = new Map();
const motivationGrid = document.querySelector('[data-motivation-grid]');
const ideaGrid = document.querySelector('[data-idea-grid]');
const emptyLibrary = document.querySelector('[data-empty-library]');
const statusNode = document.querySelector('[data-brain-status]');
const toastNode = document.querySelector('[data-toast]');
const fileInput = document.querySelector('[data-file-input]');
const linkDialog = document.querySelector('[data-link-dialog]');
const linkForm = document.querySelector('[data-link-form]');
const cardMenu = document.querySelector('[data-card-menu]');
const dropOverlay = document.querySelector('[data-drop-overlay]');
const playableOption = document.querySelector('[data-auto-playable]');
const mediaViewer = document.querySelector('[data-media-viewer]');
const mediaViewerContent = document.querySelector('[data-media-viewer-content]');
let expandedMedia = null;
try { playableOption.checked = localStorage.getItem('ramin-station.auto-playable') !== 'off'; } catch {}
playableOption.addEventListener('change', () => {
  try { localStorage.setItem('ramin-station.auto-playable', playableOption.checked ? 'on' : 'off'); } catch {}
});

window.raminNativeResolve = (id, result) => {
  const request = nativeRequests.get(id);
  if (!request) return;
  nativeRequests.delete(id);
  result?.error ? request.reject(new Error(result.error)) : request.resolve(result);
};

window.raminNativeEvent = event => {
  if (!activeVisualDownloadID) return;
  const progress = Number.isFinite(event?.progress) ? event.progress : null;
  updateDownloadProgress(activeVisualDownloadID, progress, event?.message || 'Processing');
};

function nativeRequest(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!nativeBridge) {
      reject(new Error('Native bridge unavailable'));
      return;
    }
    const id = ++nativeRequestID;
    nativeRequests.set(id, {resolve, reject});
    nativeBridge.postMessage({id, action, payload});
  });
}

function clickSound() {
  keyClick.currentTime = 0;
  keyClick.play().catch(() => {});
}

function newID() {
  return crypto.randomUUID ? crypto.randomUUID() : `signal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(message) {
  statusNode.textContent = String(message || 'ready').toUpperCase();
}

function showToast(message) {
  toastNode.textContent = message;
  toastNode.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('is-visible'), 2200);
}

function cleanState() {
  return {
    version: 2,
    items: state.items.map(item => ({
      id: item.id,
      type: item.type,
      category: item.category,
      title: item.title,
      url: item.url || '',
      note: item.note || '',
      hashtags: item.hashtags || '',
      mime: item.mime || '',
      name: item.name || '',
      originalName: item.originalName || '',
      compatibility: item.compatibility || '',
      playbackWarning: item.playbackWarning || '',
      blobId: item.blobId || '',
      storageID: item.storageID || '',
      createdAt: item.createdAt || new Date().toISOString()
    }))
  };
}

async function persistNow(throwOnFailure = false) {
  const payload = cleanState();
  try {
    if (nativeBridge) {
      await nativeRequest('visualBrainSave', {state: payload});
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
    setStatus(`${state.items.length} signals saved`);
  } catch (error) {
    setStatus('save failed');
    showToast(error?.message || 'Could not save Visual Brain.');
    if (throwOnFailure) throw error;
  }
}

window.stationSaveBeforeUpdate = () => persistNow(true);

function scheduleSave() {
  clearTimeout(saveTimer);
  setStatus('saving memory');
  saveTimer = setTimeout(persistNow, 320);
}

function normalizeState(saved) {
  if (!saved || !Array.isArray(saved.items)) return;
  state.items = saved.items.filter(item => item && item.id).map(item => ({
    id: String(item.id),
    type: item.type === 'file' ? 'file' : 'link',
    category: categories.has(item.category) ? item.category : 'saved',
    title: String(item.title || item.name || 'Untitled signal'),
    url: String(item.url || ''),
    note: String(item.note || ''),
    hashtags: normalizeHashtags(item.hashtags || ''),
    mime: String(item.mime || ''),
    name: String(item.name || ''),
    originalName: String(item.originalName || ''),
    compatibility: String(item.compatibility || ''),
    playbackWarning: String(item.playbackWarning || ''),
    blobId: String(item.blobId || ''),
    storageID: String(item.storageID || ''),
    createdAt: String(item.createdAt || new Date().toISOString())
  }));
}

function normalizeHashtags(value) {
  const tags = String(value || '')
    .split(/[\s,]+/)
    .map(tag => tag.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean)
    .slice(0, 12);
  return [...new Set(tags)].map(tag => `#${tag}`).join(' ');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  }
  return btoa(binary);
}

async function copyFileToManagedStorage(file, storageID) {
  if (!nativeBridge) return '';
  await nativeRequest('visualBrainImportStart', {
    storageID,
    name: file.name,
    mime: file.type || 'application/octet-stream'
  });
  const chunkSize = 1024 * 1024;
  try {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const data = arrayBufferToBase64(await file.slice(offset, offset + chunkSize).arrayBuffer());
      await nativeRequest('visualBrainImportChunk', {storageID, data});
      const progress = file.size ? Math.min(100, Math.round(((offset + chunkSize) / file.size) * 100)) : 100;
      setStatus(`copying ${file.name} ${progress}%`);
    }
    await nativeRequest('visualBrainImportFinish', {storageID});
    return storageID;
  } catch (error) {
    nativeRequest('visualBrainImportAbort', {storageID}).catch(() => {});
    throw error;
  }
}

function revealManagedFile(item) {
  if (!item?.storageID || !nativeBridge) {
    showToast('This file has no managed Finder copy yet.');
    return;
  }
  nativeRequest('visualBrainRevealFile', {storageID: item.storageID, name: item.name})
    .then(() => showToast('File revealed.'))
    .catch(error => showToast(error?.message || 'Could not reveal this file.'));
}

function updateDownloadProgress(itemID, value, message = '') {
  const card = document.querySelector(`[data-item-id="${CSS.escape(itemID)}"]`);
  if (!card) return;
  const control = card.querySelector('[data-card-download]');
  const progress = Math.max(0, Math.min(100, Number(value) || 0));
  if (!control) {
    const media = card.querySelector('.idea-card__media');
    if (media) media.dataset.playback = `PREPARING PLAYBACK ${Math.round(progress)}%`;
    setStatus(message || 'preparing playback');
    return;
  }
  control.classList.add('is-running');
  control.querySelector('[data-card-download-bar]').style.width = `${progress}%`;
  control.querySelector('[data-card-download-percent]').textContent = `${Math.round(progress)}%`;
  control.querySelector('button').disabled = true;
  if (message) control.title = message;
}

async function browserVisualBrainDownload(payload, itemID) {
  const response = await fetch('/api/visual-brain-download', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Background download failed.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let completed;
  while (true) {
    const {value, done} = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), {stream: !done});
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      if (Number.isFinite(event.progress)) updateDownloadProgress(itemID, event.progress, event.message);
      if (event.complete) completed = event.complete;
    }
    if (done) break;
  }
  if (pending.trim()) {
    const event = JSON.parse(pending);
    if (event.error) throw new Error(event.error);
    if (event.complete) completed = event.complete;
  }
  if (!completed) throw new Error('The download ended without a saved file.');
  return completed;
}

async function downloadLinkItem(item) {
  if (activeVisualDownloadID) {
    showToast('Finish the current download first.');
    return;
  }
  activeVisualDownloadID = item.id;
  const storageID = newID();
  updateDownloadProgress(item.id, 1, 'Preparing download');
  setStatus('background download started');
  try {
    const payload = {
      url: item.url,
      storageID,
      mediaType: item.category === 'music' ? 'audio' : 'video',
      quality: item.category === 'music' ? 'best' : '1080',
      cookies: 'auto',
      autoPlayable: playableOption.checked
    };
    const result = nativeBridge
      ? await nativeRequest('visualBrainDownload', payload)
      : await browserVisualBrainDownload(payload, item.id);
    item.type = 'file';
    item.name = result.name || `${item.title}.${item.category === 'music' ? 'mp3' : 'mp4'}`;
    item.mime = result.mime || (item.category === 'music' ? 'audio/mpeg' : 'video/mp4');
    item.storageID = result.storageID || storageID;
    item.blobId = '';
    item.originalName = result.originalName || item.name;
    item.compatibility = result.compatibility || '';
    item.playbackWarning = result.warning || '';
    item.sourceUrl = item.url;
    render();
    await persistNow();
    setStatus('download saved to library');
    showToast(result.warning || 'Download complete — the link is now a local file.');
  } catch (error) {
    const card = document.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
    const control = card?.querySelector('[data-card-download]');
    control?.classList.remove('is-running');
    const button = control?.querySelector('button');
    if (button) button.disabled = false;
    setStatus('download failed');
    showToast(error?.message || 'Background download failed.');
  } finally {
    activeVisualDownloadID = '';
  }
}

async function loadState() {
  try {
    if (nativeBridge) {
      const result = await nativeRequest('visualBrainLoad');
      normalizeState(result.state);
    } else {
      normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
    }
  } catch (error) {
    setStatus('fresh memory');
    showToast('Starting a fresh Visual Brain.');
  }
  render();
}

function openMediaDatabase() {
  if (mediaDatabase) return Promise.resolve(mediaDatabase);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => {
      mediaDatabase = request.result;
      resolve(mediaDatabase);
    };
    request.onerror = () => reject(request.error || new Error('Local media database failed.'));
  });
}

async function putMedia(id, file) {
  const database = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(file, id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Could not store media.'));
  });
}

async function getMedia(id) {
  if (!id) return null;
  const database = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not load media.'));
  });
}

async function deleteMedia(id) {
  if (!id) return;
  const database = await openMediaDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Could not remove media.'));
  });
}

function categoryForURL(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('soundcloud.com') || host.includes('spotify.com') || host.includes('bandcamp.com')) return 'music';
  } catch {}
  return activeCategory === 'all' ? 'saved' : activeCategory;
}

function serviceLabel(item) {
  if (item.type === 'file') {
    if (item.mime.startsWith('video/')) return 'VIDEO FILE';
    if (item.mime.startsWith('audio/')) return 'AUDIO FILE';
    if (item.mime.startsWith('image/')) return 'IMAGE FILE';
    return 'LOCAL FILE';
  }
  try {
    return new URL(item.url).hostname.replace(/^www\./, '').toUpperCase();
  } catch {
    return 'WEB LINK';
  }
}

function glyphFor(item) {
  if (item.type === 'link') return '↗';
  if (item.mime.startsWith('audio/')) return '♫';
  if (item.mime.startsWith('image/')) return '▧';
  return '▶';
}

function revokeRenderedURLs() {
  renderedObjectURLs.forEach(url => URL.revokeObjectURL(url));
  renderedObjectURLs = [];
}

async function hydrateMedia(container, item) {
  if (item.type !== 'file') return;
  try {
    container.title = item.playbackWarning || (item.originalName && item.originalName !== item.name ? `Playable copy • Original kept: ${item.originalName}` : '');
    let url;
    if (item.storageID) {
      url = nativeBridge
        ? (await nativeRequest('visualBrainMediaURL', {storageID: item.storageID, name: item.name})).url
        : `/api/visual-brain-media/${encodeURIComponent(item.storageID)}/${encodeURIComponent(item.name)}`;
    } else {
      const blob = await getMedia(item.blobId);
      if (!blob || !container.isConnected) return;
      url = URL.createObjectURL(blob);
      renderedObjectURLs.push(url);
    }
    if (!container.isConnected) return;
    container.replaceChildren();
    if (item.mime.startsWith('image/')) {
      const image = document.createElement('img');
      image.src = url;
      image.alt = item.title;
      container.append(image);
    } else if (item.mime.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url;
      video.muted = false;
      // Square pinned tiles use explicit play/expand keys, not oversized native chrome.
      video.controls = item.category !== 'motivation';
      video.playsInline = true;
      video.preload = 'metadata';
      container.append(video);
    } else if (item.mime.startsWith('audio/')) {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      audio.preload = 'metadata';
      container.append(audio);
    }
  } catch {
    container.title = 'The original local media is unavailable.';
  }
}

function restoreExpandedMedia() {
  if (!expandedMedia) return;
  const {node, origin, controls, trigger} = expandedMedia;
  expandedMedia = null;
  if (origin.isConnected) {
    const wasPlaying = 'paused' in node && !node.paused;
    origin.append(node);
    if ('controls' in node) node.controls = controls;
    if (wasPlaying) node.play().catch(() => {});
  } else {
    node.pause?.();
    node.remove();
  }
  if (trigger.isConnected) trigger.focus({preventScroll: true});
}

function closeMediaViewer() {
  if (document.fullscreenElement === mediaViewer) document.exitFullscreen?.().catch(() => {});
  if (mediaViewer.open) mediaViewer.close();
  restoreExpandedMedia();
}

async function expandMedia(media, item, trigger) {
  await media._ready;
  const node = media.querySelector('video, audio, img');
  if (!node) { showToast('The local preview is not ready yet.'); return; }
  closeMediaViewer();
  expandedMedia = {node, origin: media, controls: node.controls, trigger};
  document.querySelector('[data-media-viewer-title]').textContent = item.title || 'Media preview';
  const wasPlaying = 'paused' in node && !node.paused;
  mediaViewerContent.replaceChildren(node);
  if ('controls' in node) node.controls = true;
  if (wasPlaying) node.play().catch(() => {});
  mediaViewer.showModal();
  // WKWebView versions without Fullscreen API still get a full-window, contained player.
  try { await mediaViewer.requestFullscreen?.(); } catch {}
}

document.querySelector('[data-close-media-viewer]').addEventListener('click', closeMediaViewer);
mediaViewer.addEventListener('cancel', event => { event.preventDefault(); closeMediaViewer(); });
mediaViewer.addEventListener('close', () => {
  // A queued close event from the previous view must not restore a newly opened one.
  if (!mediaViewer.open) restoreExpandedMedia();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && mediaViewer.open) closeMediaViewer();
});

// Existing library downloads can be repaired too, without re-downloading the URL.
async function makePlayable(item, container) {
  if (activeVisualDownloadID) { showToast('Finish the current media job first.'); return false; }
  if (!item.storageID) { showToast('Add this file to the app folder first.'); return false; }
  activeVisualDownloadID = item.id;
  updateDownloadProgress(item.id, 90, 'Checking playback');
  try {
    const payload = {storageID: item.storageID, name: item.name};
    let result;
    if (nativeBridge) result = await nativeRequest('visualBrainMakePlayable', payload);
    else {
      const response = await fetch('/api/visual-brain-playable', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Playback check failed.');
    }
    item.originalName = item.originalName || result.originalName || item.name;
    item.name = result.name || item.name;
    item.compatibility = result.compatibility || '';
    item.playbackWarning = result.warning || '';
    if (item.name.endsWith('.mp4')) item.mime = 'video/mp4';
    else if (item.name.endsWith('.m4a')) item.mime = 'audio/mp4';
    await persistNow();
    if (container?.isConnected) await hydrateMedia(container, item);
    else render();
    showToast(result.warning || 'Ready to play. Original kept.');
    return !result.warning;
  } catch (error) {
    showToast(error.message || 'Could not create a playable copy. Original kept.');
    return false;
  } finally {
    activeVisualDownloadID = '';
    if (container) delete container.dataset.playback;
  }
}

function createCard(item) {
  const card = document.createElement('article');
  card.className = 'idea-card';
  card.dataset.itemId = item.id;
  card.draggable = true;

  const media = document.createElement('div');
  media.className = 'idea-card__media';
  const glyph = document.createElement('span');
  glyph.className = 'media-glyph';
  glyph.textContent = glyphFor(item);
  const service = document.createElement('small');
  service.textContent = serviceLabel(item);
  glyph.append(service);
  media.append(glyph);

  const meta = document.createElement('div');
  meta.className = 'idea-card__meta';
  const tag = document.createElement('span');
  tag.className = 'idea-card__tag';
  tag.textContent = item.category.toUpperCase();
  const open = document.createElement('button');
  open.className = 'idea-card__open';
  open.type = 'button';
  open.textContent = item.type === 'link' ? '↗' : '▶';
  open.title = item.type === 'link' ? 'Open link' : 'Preview media';
  const tools = document.createElement('div');
  tools.className = 'idea-card__tools';
  const reveal = document.createElement('button');
  reveal.className = 'idea-card__reveal';
  reveal.type = 'button';
  reveal.title = 'Reveal in Finder';
  reveal.setAttribute('aria-label', 'Reveal file in Finder');
  reveal.hidden = item.type !== 'file' || !item.storageID || !nativeBridge;
  reveal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M8 14h8m-3-3 3 3-3 3"/></svg>';
  const fullscreen = document.createElement('button');
  fullscreen.className = 'idea-card__fullscreen';
  fullscreen.type = 'button';
  fullscreen.title = 'Full screen preview';
  fullscreen.setAttribute('aria-label', `Full screen preview: ${item.title}`);
  fullscreen.hidden = item.type !== 'file' || !/^(video|audio|image)\//.test(item.mime);
  fullscreen.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>';
  tools.append(open, fullscreen, reveal);
  meta.append(tag, tools);

  const title = document.createElement('input');
  title.className = 'idea-card__title';
  title.value = item.title;
  title.setAttribute('aria-label', 'Signal title');

  const note = document.createElement('textarea');
  note.className = 'idea-card__note';
  note.value = item.note;
  note.placeholder = 'Why did you save this?';
  note.setAttribute('aria-label', 'Signal note');

  const hashtags = document.createElement('input');
  hashtags.className = 'idea-card__hashtags';
  hashtags.type = 'text';
  hashtags.value = item.hashtags || '';
  hashtags.placeholder = '#client #campaign';
  hashtags.setAttribute('aria-label', 'Client hashtags');

  let downloadControl;
  if (item.type === 'link') {
    downloadControl = document.createElement('div');
    downloadControl.className = 'idea-card__download';
    downloadControl.dataset.cardDownload = '';
    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.textContent = '↓ DOWNLOAD';
    downloadButton.title = 'Download in the background';
    const progressTrack = document.createElement('span');
    progressTrack.className = 'idea-card__download-track';
    const progressBar = document.createElement('i');
    progressBar.dataset.cardDownloadBar = '';
    progressTrack.append(progressBar);
    const percent = document.createElement('small');
    percent.dataset.cardDownloadPercent = '';
    percent.textContent = '0%';
    downloadControl.append(downloadButton, progressTrack, percent);
    downloadButton.addEventListener('click', event => {
      event.stopPropagation();
      clickSound();
      downloadLinkItem(item);
    });
  }

  title.addEventListener('input', () => {
    item.title = title.value.slice(0, 180);
    scheduleSave();
  });
  note.addEventListener('input', () => {
    item.note = note.value.slice(0, 1200);
    scheduleSave();
  });
  hashtags.addEventListener('change', () => {
    item.hashtags = normalizeHashtags(hashtags.value);
    hashtags.value = item.hashtags;
    scheduleSave();
  });
  hashtags.addEventListener('input', () => {
    item.hashtags = hashtags.value.slice(0, 240);
    scheduleSave();
  });
  [title, note, hashtags, open, fullscreen, reveal, downloadControl?.querySelector('button')].filter(Boolean).forEach(node => {
    node.addEventListener('mousedown', event => event.stopPropagation());
    node.addEventListener('dragstart', event => event.preventDefault());
  });
  fullscreen.addEventListener('click', event => {
    event.stopPropagation();
    clickSound();
    expandMedia(media, item, fullscreen).catch(() => showToast('Could not open the media preview.'));
  });

  open.addEventListener('click', async event => {
    event.stopPropagation();
    clickSound();
    if (item.type === 'link') {
      if (nativeBridge) nativeRequest('openExternal', {url: item.url}).catch(error => showToast(error.message));
      else window.open(item.url, '_blank', 'noopener');
      return;
    }
    await media._ready;
    let mediaNode = media.querySelector('video, audio');
    if (mediaNode) {
      if (mediaNode.paused) {
        try { await mediaNode.play(); }
        catch {
          if (playableOption.checked && await makePlayable(item, media)) {
            mediaNode = media.querySelector('video, audio');
            await mediaNode?.play().catch(() => showToast('The preview could not start. Try opening the file from Finder.'));
          } else if (!playableOption.checked) showToast('Enable Auto playable copy, or right-click → Make playable copy.');
        }
      } else mediaNode.pause();
      open.textContent = mediaNode.paused ? '▶' : 'Ⅱ';
    }
  });
  reveal.addEventListener('click', event => {
    event.stopPropagation();
    clickSound();
    revealManagedFile(item);
  });

  card.addEventListener('contextmenu', event => {
    event.preventDefault();
    showCardMenu(event.clientX, event.clientY, item.id);
  });
  card.addEventListener('dragstart', event => {
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-ramin-signal', item.id);
  });
  card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
  card.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-ramin-signal')) return;
    event.preventDefault();
  });
  card.addEventListener('drop', event => {
    const movingID = event.dataTransfer.getData('application/x-ramin-signal');
    if (!movingID || movingID === item.id) return;
    event.preventDefault();
    event.stopPropagation();
    moveBefore(movingID, item.id, item.category);
  });

  card.append(media, meta, title, note, hashtags);
  if (downloadControl) card.append(downloadControl);
  media._ready = hydrateMedia(media, item);
  media._ready.then(() => {
    const player = media.querySelector('video, audio');
    if (!player) return;
    const syncPlayKey = () => {
      open.textContent = player.paused ? '▶' : 'Ⅱ';
      open.title = player.paused ? 'Play media' : 'Pause media';
      open.setAttribute('aria-label', `${player.paused ? 'Play' : 'Pause'}: ${item.title}`);
    };
    ['play', 'pause', 'ended'].forEach(name => player.addEventListener(name, syncPlayKey));
    syncPlayKey();
  });
  return card;
}

function createMotivationSlot(index) {
  const slot = document.createElement('div');
  slot.className = 'motivation-slot';
  const content = document.createElement('span');
  const number = document.createElement('b');
  number.textContent = String(index + 1).padStart(2, '0');
  content.append(number, document.createTextNode('DROP A GO-TO VIDEO'));
  slot.append(content);
  return slot;
}

function render() {
  closeMediaViewer();
  revokeRenderedURLs();
  motivationGrid.replaceChildren();
  ideaGrid.replaceChildren();

  const motivation = state.items.filter(item => item.category === 'motivation').slice(0, motivationLimit);
  motivation.forEach(item => motivationGrid.append(createCard(item)));
  for (let index = motivation.length; index < motivationLimit; index += 1) motivationGrid.append(createMotivationSlot(index));

  const filtered = state.items.filter(item => {
    if (item.category === 'motivation') return false;
    if (activeCategory !== 'all' && item.category !== activeCategory) return false;
    if (!searchQuery) return true;
    const haystack = `${item.title} ${item.note} ${item.hashtags || ''} ${item.url} ${item.name}`.toLowerCase();
    return haystack.includes(searchQuery);
  });
  filtered.forEach(item => ideaGrid.append(createCard(item)));
  emptyLibrary.classList.toggle('is-visible', filtered.length === 0);
  setStatus(`${state.items.length} signals ready`);
}

function categoryForDrop(requested) {
  if (requested === 'active') return activeCategory === 'all' ? 'saved' : activeCategory;
  return categories.has(requested) ? requested : 'saved';
}

function canAddToMotivation(count = 1) {
  return state.items.filter(item => item.category === 'motivation').length + count <= motivationLimit;
}

async function addFiles(fileList, requestedCategory) {
  const files = [...fileList].filter(file => /^(video|audio|image)\//.test(file.type));
  if (!files.length) {
    showToast('Drop a video, image, or audio file.');
    return;
  }
  let category = categoryForDrop(requestedCategory);
  if (category === 'motivation' && !canAddToMotivation(files.length)) {
    showToast(`Motivation holds ${motivationLimit} videos. Remove one first.`);
    return;
  }
  setStatus('storing local media');
  for (const file of files) {
    const id = newID();
    try {
      await putMedia(id, file);
      let storageID = '';
      if (nativeBridge) {
        try {
          storageID = await copyFileToManagedStorage(file, id);
        } catch (error) {
          showToast(`${file.name}: preview saved, but app-folder copy failed.`);
        }
      }
      state.items.unshift({
        id,
        type: 'file',
        category,
        title: file.name.replace(/\.[^.]+$/, '') || 'Untitled media',
        url: '',
        note: '',
        hashtags: '',
        mime: file.type,
        name: file.name,
        blobId: id,
        storageID,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      showToast(`${file.name}: ${error?.message || 'could not be stored'}`);
    }
  }
  render();
  scheduleSave();
  showToast(`${files.length} signal${files.length === 1 ? '' : 's'} stored locally.`);
}

function addLink(urlValue, titleValue, noteValue, hashtagValue, requestedCategory) {
  let url;
  try {
    url = new URL(urlValue);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    showToast('Enter a complete http or https link.');
    return false;
  }
  let category = requestedCategory || categoryForURL(url.href);
  if (!categories.has(category)) category = categoryForURL(url.href);
  if (category === 'motivation' && !canAddToMotivation()) {
    showToast(`Motivation holds ${motivationLimit} videos. Remove one first.`);
    return false;
  }
  state.items.unshift({
    id: newID(),
    type: 'link',
    category,
    title: String(titleValue || url.hostname.replace(/^www\./, '')).slice(0, 180),
    url: url.href,
    note: String(noteValue || '').slice(0, 1200),
    hashtags: normalizeHashtags(hashtagValue),
    mime: '',
    name: '',
    blobId: '',
    storageID: '',
    createdAt: new Date().toISOString()
  });
  render();
  scheduleSave();
  showToast('Link saved to Visual Brain.');
  return true;
}

function moveBefore(movingID, targetID, category) {
  const movingIndex = state.items.findIndex(item => item.id === movingID);
  const targetIndex = state.items.findIndex(item => item.id === targetID);
  if (movingIndex < 0 || targetIndex < 0) return;
  if (category === 'motivation' && state.items[movingIndex].category !== 'motivation' && !canAddToMotivation()) {
    showToast(`Motivation holds ${motivationLimit} videos. Remove one first.`);
    return;
  }
  const [moving] = state.items.splice(movingIndex, 1);
  moving.category = category;
  const updatedTarget = state.items.findIndex(item => item.id === targetID);
  state.items.splice(updatedTarget, 0, moving);
  render();
  scheduleSave();
}

function moveToCategory(id, category) {
  const item = state.items.find(entry => entry.id === id);
  if (!item || !categories.has(category)) return;
  if (category === 'motivation' && item.category !== 'motivation' && !canAddToMotivation()) {
    showToast(`Motivation holds ${motivationLimit} videos. Remove one first.`);
    return;
  }
  item.category = category;
  render();
  scheduleSave();
  showToast(`Moved to ${category}.`);
}

async function removeItem(id) {
  if (id === activeVisualDownloadID) { showToast('Finish the media job before deleting this signal.'); return; }
  const index = state.items.findIndex(item => item.id === id);
  if (index < 0) return;
  const [removed] = state.items.splice(index, 1);
  if (removed.blobId) deleteMedia(removed.blobId).catch(() => {});
  if (removed.storageID && nativeBridge) nativeRequest('visualBrainDeleteFile', {storageID: removed.storageID}).catch(() => {});
  render();
  scheduleSave();
  showToast('Signal deleted.');
}

function showCardMenu(x, y, id) {
  contextItemID = id;
  const item = state.items.find(entry => entry.id === id);
  const canReveal = Boolean(item?.storageID && nativeBridge);
  cardMenu.querySelector('[data-menu-action="reveal"]').hidden = !canReveal;
  cardMenu.querySelector('[data-menu-action="playable"]').hidden = item?.type !== 'file' || !item.storageID || !/^(video|audio)\//.test(item.mime);
  cardMenu.querySelector('[data-reveal-divider]').hidden = !canReveal;
  cardMenu.classList.add('is-visible');
  const width = 210;
  const height = cardMenu.offsetHeight || 300;
  cardMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  cardMenu.style.top = `${Math.max(28, Math.min(y, innerHeight - height - 8))}px`;
}

function hideCardMenu() {
  cardMenu.classList.remove('is-visible');
  contextItemID = '';
}

document.querySelector('[data-add-files]').addEventListener('click', () => {
  clickSound();
  fileInput.click();
});
fileInput.addEventListener('change', async () => {
  await addFiles(fileInput.files, activeCategory === 'all' ? 'saved' : activeCategory);
  fileInput.value = '';
});

document.querySelector('[data-add-link]').addEventListener('click', () => {
  clickSound();
  document.querySelector('[data-link-category]').value = activeCategory === 'all' ? 'saved' : activeCategory;
  linkDialog.showModal();
  document.querySelector('[data-link-url]').focus();
});
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => linkDialog.close()));
linkForm.addEventListener('submit', event => {
  event.preventDefault();
  const success = addLink(
    document.querySelector('[data-link-url]').value.trim(),
    document.querySelector('[data-link-title]').value.trim(),
    document.querySelector('[data-link-note]').value.trim(),
    document.querySelector('[data-link-hashtags]').value.trim(),
    document.querySelector('[data-link-category]').value
  );
  if (success) {
    linkForm.reset();
    linkDialog.close();
  }
});

document.querySelector('[data-category-tabs]').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  activeCategory = button.dataset.category;
  document.querySelectorAll('[data-category]').forEach(node => node.classList.toggle('is-active', node === button));
  clickSound();
  render();
});
document.querySelector('[data-search]').addEventListener('input', event => {
  searchQuery = event.target.value.trim().toLowerCase();
  render();
});

cardMenu.addEventListener('click', event => {
  const action = event.target.closest('[data-menu-action]')?.dataset.menuAction;
  const id = contextItemID;
  hideCardMenu();
  if (!action || !id) return;
  clickSound();
  if (action === 'reveal') revealManagedFile(state.items.find(item => item.id === id));
  else if (action === 'playable') {
    const item = state.items.find(item => item.id === id);
    if (item) makePlayable(item, document.querySelector(`[data-item-id="${CSS.escape(id)}"] .idea-card__media`));
  }
  else if (action === 'delete') removeItem(id);
  else moveToCategory(id, action);
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('[data-card-menu]')) hideCardMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') hideCardMenu();
});

document.querySelectorAll('[data-drop-category]').forEach(zone => {
  zone.addEventListener('dragover', event => {
    event.preventDefault();
    zone.classList.add('is-drop-target');
  });
  zone.addEventListener('dragleave', event => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-drop-target');
  });
  zone.addEventListener('drop', async event => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('is-drop-target');
    dropOverlay.classList.remove('is-visible');
    dragDepth = 0;
    const category = categoryForDrop(zone.dataset.dropCategory);
    const movingID = event.dataTransfer.getData('application/x-ramin-signal');
    if (movingID) {
      moveToCategory(movingID, category);
      return;
    }
    if (event.dataTransfer.files?.length) {
      await addFiles(event.dataTransfer.files, category);
      return;
    }
    const url = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (url) addLink(url.trim(), '', '', '', category);
  });
});

document.addEventListener('dragenter', event => {
  if (event.dataTransfer.types.includes('application/x-ramin-signal')) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.add('is-visible');
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('is-visible');
});
document.addEventListener('drop', () => {
  dragDepth = 0;
  dropOverlay.classList.remove('is-visible');
});

document.querySelectorAll('[data-window]').forEach(control => {
  control.addEventListener('click', event => {
    event.stopPropagation();
    clickSound();
    nativeBridge?.postMessage({id: Date.now(), action: 'windowControl', payload: {control: control.dataset.window}});
  });
});

document.querySelectorAll('a[href^="http"]').forEach(link => {
  link.addEventListener('click', event => {
    if (!nativeBridge) return;
    event.preventDefault();
    nativeBridge.postMessage({id: Date.now(), action: 'openExternal', payload: {url: link.href}});
  });
});

window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  persistNow();
  revokeRenderedURLs();
});

loadState();
