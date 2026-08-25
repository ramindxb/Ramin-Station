const keys = [...document.querySelectorAll('.physical-key')];
const status = document.querySelector('.status');
let statusTimer;
const keyClick = new Audio('assets/key-click.mp3');
keyClick.preload = 'auto';
keyClick.volume = 0.48;
const homeNativeBridge = window.webkit?.messageHandlers?.raminStation;

function playMechanicalClick() {
  keyClick.currentTime = 0;
  keyClick.play().catch(() => {});
}

function selectKey(key) {
  keys.forEach(item => item.classList.toggle('is-selected', item === key));
  const action = key.dataset.action.toUpperCase();
  status.textContent = `${action} SELECTED`;
  status.classList.add('is-visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('is-visible'), 850);
  playMechanicalClick();
  window.dispatchEvent(new CustomEvent('ramin-station:select', { detail: { action: key.dataset.action } }));
  setTimeout(() => {
    window.location.href = `${key.dataset.action}.html`;
  }, 180);
}

keys.forEach(key => key.addEventListener('click', () => selectKey(key)));

document.querySelectorAll('[data-window]').forEach(control => {
  control.addEventListener('click', event => {
    event.stopPropagation();
    playMechanicalClick();
    homeNativeBridge?.postMessage({id: Date.now(), action: 'windowControl', payload: {control: control.dataset.window}});
  });
});

document.querySelectorAll('a[href^="http"]').forEach(link => {
  link.addEventListener('click', event => {
    if (!homeNativeBridge) return;
    event.preventDefault();
    homeNativeBridge.postMessage({id: Date.now(), action: 'openExternal', payload: {url: link.href}});
  });
});
