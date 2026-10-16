const shell = document.querySelector('.tool-shell');
const tool = shell.dataset.tool;
const statusNode = document.querySelector('[data-status]');
const runKey = document.querySelector('[data-run]');
const cancelKey = document.querySelector('[data-cancel]');
const input = document.querySelector('.text-input');
const terminal = document.querySelector('[data-terminal]');
const progressBar = document.querySelector('[data-progress-bar]');
const progressLabel = document.querySelector('[data-progress-label]');
const selections = {};
const keyClick = new Audio('assets/key-click.mp3');
keyClick.preload = 'auto';
keyClick.volume = 0.48;
const nativeBridge = window.webkit?.messageHandlers?.raminStation;
let nativeRequestID = 0;
const nativeRequests = new Map();
let jobRunning = false;
let selectedSourceKind = 'folder';
let cookieFilePath = '';
const playableOption = document.querySelector('[data-auto-playable]');
if (playableOption) {
  try { playableOption.checked = localStorage.getItem('ramin-station.auto-playable') !== 'off'; } catch {}
  playableOption.addEventListener('change', () => {
    try { localStorage.setItem('ramin-station.auto-playable', playableOption.checked ? 'on' : 'off'); } catch {}
  });
}

window.raminNativeResolve = (id, result) => {
  const request = nativeRequests.get(id);
  if (!request) return;
  nativeRequests.delete(id);
  result?.error ? request.reject(new Error(result.error)) : request.resolve(result);
};

window.raminNativeEvent = event => {
  if (event.message) appendLog(event.message);
  if (Number.isFinite(event.progress)) setProgress(event.progress);
};

function nativeRequest(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nativeRequestID;
    nativeRequests.set(id, {resolve, reject});
    nativeBridge.postMessage({id, action, payload});
  });
}

function clickSound() {
  keyClick.currentTime = 0;
  keyClick.play().catch(() => {});
}

function appendLog(message) {
  const line = document.createElement('p');
  const prompt = document.createElement('em');
  prompt.textContent = '›';
  line.append(prompt, ` ${String(message).replace(/\s+/g, ' ').trim()}`);
  terminal.append(line);
  while (terminal.children.length > 4) terminal.firstElementChild.remove();
  terminal.scrollTop = terminal.scrollHeight;
}

function setProgress(value) {
  const progress = Math.max(0, Math.min(100, Number(value) || 0));
  progressBar.style.width = `${progress}%`;
  progressLabel.textContent = `${Math.round(progress)}%`;
}

function setRunning(running) {
  jobRunning = running;
  runKey.disabled = running;
  cancelKey.disabled = !running;
}

function setStatus(message) {
  statusNode.textContent = message.toUpperCase();
}

function updateSummary() {
  const small = runKey.querySelector('small');
  if (tool === 'download') {
    const type = selections.mediaType || 'video';
    const quality = selections.quality || '1080';
    small.textContent = type === 'audio' ? `AUDIO • ${quality === 'best' ? 'BEST' : quality + ' KBPS'} • MP3` : `VIDEO • ${quality}P • MP4`;
  } else {
    const editReady = selections.processMode === 'decompress';
    const label = runKey.querySelector('[data-run-label]');
    if (label) label.textContent = editReady ? 'DECOMPRESS FOR EDIT' : (selectedSourceKind === 'file' ? 'COMPRESS FILE' : 'COMPRESS FOLDER');
    small.textContent = editReady
      ? `${selectedSourceKind.toUpperCase()} • PRORES PROXY • MOV`
      : `${selectedSourceKind.toUpperCase()} • ${(selections.quality || 'balanced').toUpperCase()} • HEVC`;
    document.querySelector('[data-quality-block]')?.classList.toggle('is-disabled', editReady);
    document.querySelectorAll('[data-choice-group="quality"] .choice').forEach(button => { button.disabled = editReady; });
    const outputText = document.querySelector('[data-output-text]');
    const outputCodec = document.querySelector('[data-output-codec]');
    if (outputText) outputText.textContent = editReady ? 'Source / Ramin Station Edit' : 'Source / Ramin Station HEVC';
    if (outputCodec) outputCodec.textContent = editReady ? 'PRORES • MOV' : 'HEVC • H.265';
    const terminalTitle = document.querySelector('[data-terminal-title]');
    if (terminalTitle) terminalTitle.textContent = editReady ? ' EDIT-READY TERMINAL' : ' HEVC TERMINAL';
  }
}

document.querySelectorAll('[data-choice-group]').forEach(group => {
  const name = group.dataset.choiceGroup;
  const active = group.querySelector('.is-active');
  selections[name] = active?.dataset.value;
  group.addEventListener('click', event => {
    const choice = event.target.closest('.choice');
    if (!choice || jobRunning) return;
    group.querySelectorAll('.choice').forEach(item => item.classList.toggle('is-active', item === choice));
    selections[name] = choice.dataset.value;
    if (tool === 'download' && name === 'mediaType') {
      const qualityButtons = [...document.querySelector('[data-choice-group="quality"]').children];
      const audio = choice.dataset.value === 'audio';
      const labels = audio ? [['best','BEST','SOURCE'],['256','256K','HIGH'],['128','128K','SMALL']] : [['1080','1080P','BEST'],['720','720P','SMALLER'],['480','480P','LIGHT']];
      qualityButtons.forEach((button, index) => {
        const [value, label, sub] = labels[index];
        button.dataset.value = value;
        button.innerHTML = `${label}<small>${sub}</small>`;
        button.classList.toggle('is-active', index === 0);
      });
      selections.quality = labels[0][0];
    }
    clickSound();
    updateSummary();
  });
});

async function readClipboardText() {
  if (nativeBridge) {
    const result = await nativeRequest('readClipboard');
    return result.text || '';
  }
  return navigator.clipboard.readText();
}

function useSelectedPath(path, kind) {
  if (!path) return;
  input.value = path;
  selectedSourceKind = kind;
  setStatus(`${kind} selected`);
  appendLog(`Source ${kind}: ${path}`);
  updateSummary();
}

document.querySelector('[data-paste]').addEventListener('click', async () => {
  try {
    if (tool === 'compress' && nativeBridge) {
      const result = await nativeRequest('chooseFolder');
      useSelectedPath(result.path, 'folder');
    } else {
      input.value = await readClipboardText();
      setStatus('pasted');
      appendLog(tool === 'download' ? 'URL pasted.' : 'Path pasted.');
    }
  } catch {
    input.focus();
    setStatus('paste manually');
  }
  clickSound();
});

document.querySelector('[data-choose-file]')?.addEventListener('click', async () => {
  try {
    const result = nativeBridge ? await nativeRequest('chooseFile', {kind: 'video'}) : null;
    if (result?.path) useSelectedPath(result.path, 'file');
  } catch (error) {
    setStatus(error?.message || 'file selection failed');
  }
  clickSound();
});

const cookieSource = document.querySelector('#cookie-source');
const cookieFileKey = document.querySelector('[data-cookie-file]');
cookieSource?.addEventListener('change', () => {
  cookieFileKey?.toggleAttribute('hidden', cookieSource.value !== 'cookiefile');
  if (cookieSource.value === 'cookiefile' && !cookieFilePath) cookieFileKey?.click();
});
cookieFileKey?.addEventListener('click', async () => {
  try {
    const result = nativeBridge ? await nativeRequest('chooseFile', {kind: 'cookies'}) : null;
    if (result?.path) {
      cookieFilePath = result.path;
      cookieFileKey.textContent = 'COOKIES.TXT READY';
      setStatus('cookie file selected');
      appendLog('Cookies.txt selected securely.');
    }
  } catch (error) {
    setStatus(error?.message || 'cookie file failed');
  }
  clickSound();
});

input.addEventListener('keydown', async event => {
  if (!nativeBridge || event.key.toLowerCase() !== 'v' || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  try {
    input.value = await readClipboardText();
    setStatus('pasted');
    appendLog(tool === 'download' ? 'URL pasted with keyboard shortcut.' : 'Path pasted with keyboard shortcut.');
  } catch {
    setStatus('clipboard unavailable');
  }
});

async function checkDependencies(install = false) {
  setStatus(install ? 'installing tools' : 'checking tools');
  try {
    let data;
    if (nativeBridge) {
      data = await nativeRequest(install ? 'install' : 'dependencies', {tools: tool === 'download' ? ['ffmpeg','ytdlp','deno'] : ['ffmpeg']});
    } else {
      const endpoint = install ? '/api/install' : '/api/dependencies';
      const response = await fetch(endpoint, {
        method: install ? 'POST' : 'GET',
        headers: install ? {'Content-Type':'application/json'} : undefined,
        body: install ? JSON.stringify({tools: tool === 'download' ? ['ffmpeg','ytdlp','deno'] : ['ffmpeg']}) : undefined
      });
      data = await response.json();
    }
    const dependencyNodes = [...document.querySelectorAll('[data-dependency]')];
    dependencyNodes.forEach(item => {
      const result = data[item.dataset.dependency];
      item.classList.toggle('is-ready', result?.ready);
      item.classList.toggle('is-missing', !result?.ready);
      item.querySelector('small').textContent = result?.ready ? (result.version || 'ready') : 'missing';
    });
    const ready = dependencyNodes.every(item => data[item.dataset.dependency]?.ready);
    setStatus(ready ? 'system ready' : 'tools missing');
    if (ready) appendLog('System tools ready.');
  } catch (error) {
    document.querySelectorAll('[data-dependency]').forEach(item => {
      item.classList.add('is-ready');
      item.querySelector('small').textContent = 'prototype';
    });
    setStatus('preview mode');
    appendLog(error?.message || 'Preview mode — native service is offline.');
  }
}

document.querySelector('[data-setup]').addEventListener('click', () => {
  clickSound();
  checkDependencies(true);
});

runKey.addEventListener('click', async () => {
  if (jobRunning) return;
  clickSound();
  runKey.classList.add('is-pressed');
  setTimeout(() => runKey.classList.remove('is-pressed'), 150);
  if (!input.value.trim()) {
    setStatus(tool === 'download' ? 'paste a url first' : 'choose a file or folder first');
    input.focus();
    return;
  }
  terminal.replaceChildren();
  setProgress(0);
  const editReady = tool === 'compress' && selections.processMode === 'decompress';
  appendLog(tool === 'download' ? 'Starting yt-dlp…' : editReady ? 'Starting edit-ready ProRes transcode…' : 'Starting FFmpeg HEVC queue…');
  setRunning(true);
  setStatus(tool === 'download' ? 'download started' : editReady ? 'edit transcode started' : 'compression started');
  try {
    const payload = tool === 'download'
      ? {url: input.value.trim(), mediaType: selections.mediaType, quality: selections.quality, cookies: cookieSource?.value || 'auto', cookieFile: cookieFilePath, autoPlayable: playableOption?.checked !== false}
      : {source: input.value.trim(), sourceKind: selectedSourceKind, inputType: selections.inputType, quality: selections.quality, processMode: selections.processMode || 'compress'};
    let data;
    if (nativeBridge) {
      data = await nativeRequest(tool, payload);
    } else {
      const response = await fetch(`/api/${tool}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      if (response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let pending = '';
        const consume = line => {
          if (!line.trim()) return;
          const event = JSON.parse(line);
          if (event.error) throw new Error(event.error);
          if (event.message) appendLog(event.message);
          if (Number.isFinite(event.progress)) setProgress(event.progress);
          if (event.complete) data = event.complete;
        };
        while (true) {
          const {value,done} = await reader.read();
          pending += decoder.decode(value || new Uint8Array(),{stream:!done});
          const lines = pending.split('\n'); pending = lines.pop() || ''; lines.forEach(consume);
          if (done) break;
        }
        if (pending) consume(pending);
        if (!data) throw new Error('The job ended without a saved file.');
      } else data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Job failed.');
    }
    setStatus(data.message || 'complete');
    setProgress(100);
    appendLog(data.message || 'Job complete.');
    if (data.warning) appendLog(data.warning);
    if (data.name) appendLog(`File: ${data.name}`);
  } catch (error) {
    const message = error?.message || 'Job stopped.';
    setStatus(message.length > 72 ? 'job failed — see terminal' : message);
    appendLog(message);
  } finally {
    setRunning(false);
  }
});

cancelKey.addEventListener('click', async () => {
  if (!jobRunning) return;
  clickSound();
  setStatus('cancelling');
  appendLog('Cancel requested…');
  try {
    if (nativeBridge) await nativeRequest('cancel');
    else await fetch('/api/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    setStatus('cancelled');
  } catch (error) {
    setStatus(error?.message || 'cancel failed');
  }
});

document.querySelectorAll('[data-window]').forEach(control => {
  control.addEventListener('click', () => {
    clickSound();
    if (nativeBridge) nativeRequest('windowControl', {control: control.dataset.window}).catch(() => {});
  });
});

document.querySelectorAll('a[href^="http"]').forEach(link => {
  link.addEventListener('click', event => {
    if (!nativeBridge) return;
    event.preventDefault();
    nativeRequest('openExternal', {url: link.href}).catch(() => {});
  });
});

checkDependencies();
updateSummary();
