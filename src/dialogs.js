// Small in-page replacements for window.prompt/alert/confirm. Some embedded
// browser contexts (webviews, some in-app browsers) silently no-op native
// dialogs instead of showing them — which made "Save as…" look completely
// broken (the prompt never appeared, so the deck was never named or saved).
// These build a plain DOM modal instead, so they work everywhere a normal
// page does.

let overlayEl = null;

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const box = document.createElement('div');
  box.className = 'dialog-box';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return { overlay, box };
}

function closeOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
}

export function showPrompt(message, defaultValue = '') {
  closeOverlay();
  return new Promise((resolve) => {
    const { overlay, box } = buildOverlay();
    overlayEl = overlay;

    const msg = document.createElement('div');
    msg.className = 'dialog-message';
    msg.textContent = message;
    box.appendChild(msg);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dialog-input';
    input.value = defaultValue;
    box.appendChild(input);

    const row = document.createElement('div');
    row.className = 'dialog-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-button small-button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary-button small-button';
    ok.textContent = 'OK';
    row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(row);

    const finish = (value) => { closeOverlay(); resolve(value); };
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value);
      if (e.key === 'Escape') finish(null);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });

    input.focus();
    input.select();
  });
}

export function showConfirm(message) {
  closeOverlay();
  return new Promise((resolve) => {
    const { overlay, box } = buildOverlay();
    overlayEl = overlay;

    const msg = document.createElement('div');
    msg.className = 'dialog-message';
    msg.style.whiteSpace = 'pre-wrap';
    msg.textContent = message;
    box.appendChild(msg);

    const row = document.createElement('div');
    row.className = 'dialog-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-button small-button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary-button small-button';
    ok.textContent = 'OK';
    row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(row);

    const finish = (value) => { closeOverlay(); resolve(value); };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    ok.focus();
  });
}

export function showAlert(message) {
  closeOverlay();
  return new Promise((resolve) => {
    const { overlay, box } = buildOverlay();
    overlayEl = overlay;

    const msg = document.createElement('div');
    msg.className = 'dialog-message';
    msg.style.whiteSpace = 'pre-wrap';
    msg.textContent = message;
    box.appendChild(msg);

    const row = document.createElement('div');
    row.className = 'dialog-buttons';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary-button small-button';
    ok.textContent = 'OK';
    row.appendChild(ok);
    box.appendChild(row);

    const finish = () => { closeOverlay(); resolve(); };
    ok.addEventListener('click', finish);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(); });
    ok.focus();
  });
}
