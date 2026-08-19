// Editor visual hospedado para os decks de palestra — adaptado do editor
// local em palestras/_editor/editor.js. O MODELO DE EDIÇÃO é idêntico
// (sourceDoc nunca executado, previewDoc é a cópia que o iframe mostra,
// pareamento por ordem de travessia entre os dois); só a camada de
// armazenamento muda: em vez de File System Access API numa pasta local,
// lê direto do site público (sem auth) e escreve via API autenticada, que
// por baixo comita no repo `palestras` (nunca escreve no S3 direto — ver
// notas de arquitetura do repo).

const cfg = window.SLIDES_EDITOR_CONFIG;
const { beginLogin, logout, ensureAuthenticated, authedFetch } = window.SlidesEditorAuth;

const INLINE_TAGS = new Set(['EM', 'STRONG', 'B', 'I', 'BR']);

const els = {
  btnBrowse: document.getElementById('btn-browse'),
  talkTitle: document.getElementById('talk-title'),
  modeTrigger: document.getElementById('mode-trigger'),
  modeOptions: document.getElementById('mode-options'),
  btnPublish: document.getElementById('btn-publish'),
  status: document.getElementById('status'),
  slideNav: document.getElementById('slide-nav'),
  preview: document.getElementById('preview'),
  zoomOut: document.getElementById('zoom-out'),
  zoomIn: document.getElementById('zoom-in'),
  zoomReset: document.getElementById('zoom-reset'),
  zoomLevel: document.getElementById('zoom-level'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnPresent: document.getElementById('btn-present'),
  btnLogout: document.getElementById('btn-logout'),
  presentOverlay: document.getElementById('present-overlay'),
  presentFrame: document.getElementById('present-frame'),
  previewLoading: document.getElementById('preview-loading'),
  gateOverlay: document.getElementById('gate-overlay'),
  gateLogin: document.getElementById('gate-login'),
  gateBrowse: document.getElementById('gate-browse'),
  btnLogin: document.getElementById('btn-login'),
  talkSearch: document.getElementById('talk-search'),
  talkList: document.getElementById('talk-list'),
  fileInput: document.getElementById('file-input'),
};

let currentSlug = null;
let sourceDoc = null;
let docPrefix = '';
let slidePairs = [];
let currentSlide = 0;
let dirty = false;
let talks = []; // [{label, slug}]
let zoomFactor = 1;

// ---------- Undo / redo (unchanged model from the local editor) ----------
const MAX_UNDO = 20;
const undoStack = [];
const redoStack = [];

function pushUndoSnapshot(imageRestore) {
  undoStack.push({ slideIndex: currentSlide, html: sourceDoc.documentElement.outerHTML, imageRestore: imageRestore || null });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  els.btnUndo.disabled = undoStack.length === 0;
  els.btnUndo.textContent = undoStack.length > 0 ? `↶ Desfazer (${undoStack.length})` : '↶ Desfazer';
  els.btnRedo.disabled = redoStack.length === 0;
  els.btnRedo.textContent = redoStack.length > 0 ? `↷ Refazer (${redoStack.length})` : '↷ Refazer';
}

async function timeTravel(fromStack, toStack) {
  const entry = fromStack.pop();
  if (!entry) return false;

  let inverseImageRestore = null;
  if (entry.imageRestore) {
    try {
      inverseImageRestore = { relPath: entry.imageRestore.relPath, bytes: await readFileAt(currentSlug, entry.imageRestore.relPath) };
    } catch (err) {
      console.warn('could not snapshot current image before time-travel', err);
    }
    try {
      await writeFileAt(currentSlug, entry.imageRestore.relPath, entry.imageRestore.bytes);
    } catch (err) {
      console.warn('could not restore image bytes', err);
    }
  }

  toStack.push({ slideIndex: currentSlide, html: sourceDoc.documentElement.outerHTML, imageRestore: inverseImageRestore });
  if (toStack.length > MAX_UNDO) toStack.shift();

  await applySnapshotDiff(entry.html, entry.slideIndex);
  markDirty();
  updateUndoRedoButtons();
  return true;
}

async function undo() {
  const did = await timeTravel(undoStack, redoStack);
  setStatus(did ? `desfeito — ${undoStack.length} passo(s) restante(s)` : 'nada pra desfazer', did ? 'ok' : '');
}
async function redo() {
  const did = await timeTravel(redoStack, undoStack);
  setStatus(did ? `refeito — ${redoStack.length} passo(s) restante(s)` : 'nada pra refazer', did ? 'ok' : '');
}
function handleUndoKeydown(e) {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  if (e.shiftKey) redo();
  else undo();
}

function computeFitScale() {
  const win = els.preview.contentWindow;
  if (!win) return 1;
  return Math.min(win.innerWidth / 1920, win.innerHeight / 1080);
}
function applyZoom() {
  const doc = els.preview.contentDocument;
  if (!doc) return;
  const scale = computeFitScale() * zoomFactor;
  doc.documentElement.style.setProperty('--slide-scale', scale);
  els.zoomLevel.textContent = `${Math.round(zoomFactor * 100)}%`;
}

let editModeValue = 'edit';
function isEditMode() {
  return editModeValue === 'edit';
}
function setMode(mode) {
  editModeValue = mode;
  els.modeOptions.querySelectorAll('.mode-option').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  els.modeOptions.hidden = true;
  if (slidePairs[currentSlide]) wireCurrentSlideFields();
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}
function markDirty() {
  dirty = true;
  els.btnPublish.disabled = false;
  setStatus('alterações não publicadas', '');
}

// ---------- Storage layer: public reads, authenticated writes ----------
// This is the only part that differs from the local editor's File System
// Access calls — everything above/below treats these two functions as an
// opaque storage boundary, same as before.

async function readFileAt(slug, relPath) {
  const res = await fetch(`${cfg.contentBase}/materiais/${slug}/${relPath}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`falha ao ler ${relPath} (${res.status})`);
  return res.blob();
}

async function writeFileAt(slug, relPath, fileOrBlob) {
  if (relPath === 'index.html') {
    const text = await fileOrBlob.text();
    const res = await authedFetch(`${cfg.apiUrl}/talks/${slug}/html`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: text,
    });
    if (!res.ok) throw new Error(await describeApiError(res));
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const filename = relPath.split('/').pop();
  const res = await authedFetch(`${cfg.apiUrl}/talks/${slug}/images/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: { 'content-type': fileOrBlob.type || 'application/octet-stream' },
    body: fileOrBlob,
  });
  if (!res.ok) throw new Error(await describeApiError(res));
}

async function describeApiError(res) {
  try {
    const data = await res.json();
    return data.error || `erro ${res.status}`;
  } catch {
    return `erro ${res.status}`;
  }
}

// ---------- Field model (unchanged from the local editor) ----------

function isLeafTextEl(el) {
  if (el.tagName === 'IMG' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
  const kids = Array.from(el.children);
  const leafByChildren = kids.length === 0 || kids.every((c) => INLINE_TAGS.has(c.tagName));
  return leafByChildren && el.textContent.trim().length > 0;
}

function collectFields(slideEl) {
  const texts = [];
  const images = [];
  const emptySlots = [];
  (function walk(node) {
    for (const child of Array.from(node.children)) {
      if (child.tagName === 'IMG') {
        images.push(child);
        continue;
      }
      if (child.classList && child.classList.contains('slot') && child.classList.contains('empty')) {
        emptySlots.push(child);
        continue;
      }
      if (isLeafTextEl(child)) {
        texts.push(child);
        continue;
      }
      walk(child);
    }
  })(slideEl);
  return { texts, images, emptySlots };
}

function sanitizeInline(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  (function clean(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      if (!INLINE_TAGS.has(child.tagName)) {
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        continue;
      }
      for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
      clean(child);
    }
  })(tmp);
  return tmp.innerHTML.trim();
}

// ---------- Opening a talk ----------

async function openTalk(entry) {
  currentSlug = entry.slug;
  saveLastTalkSlug(entry.slug);
  closeGate();
  els.talkTitle.textContent = entry.label;
  setStatus('carregando…', '');
  els.previewLoading.hidden = false;

  try {
    const res = await fetch(`${cfg.contentBase}/materiais/${entry.slug}/index.html`, { cache: 'no-store' });
    if (!res.ok) {
      setStatus(`erro ao carregar: ${res.status}`, 'error');
      return;
    }
    const text = await res.text();

    const htmlStart = text.search(/<html[\s>]/i);
    docPrefix = htmlStart > 0 ? text.slice(0, htmlStart) : '';
    sourceDoc = new DOMParser().parseFromString(text, 'text/html');

    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoRedoButtons();

    zoomFactor = 1;
    await renderPreviewFromSource(0);

    dirty = false;
    els.btnPublish.disabled = true;
    els.modeTrigger.disabled = false;
    editModeValue = 'edit';
    els.modeOptions.querySelectorAll('.mode-option').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'edit'));
    els.zoomOut.disabled = false;
    els.zoomIn.disabled = false;
    els.zoomReset.disabled = false;
    els.btnPresent.disabled = false;
    setStatus('', '');
  } finally {
    els.previewLoading.hidden = true;
  }
}

// Fetches every local <img> in parallel instead of one at a time — with
// ~20 images per deck, sequential awaits were most of what made opening a
// talk feel slow.
async function hydrateImages(doc) {
  const imgs = Array.from(doc.querySelectorAll('img')).filter((img) => {
    const src = img.getAttribute('src') || '';
    return src && !/^https?:/i.test(src);
  });
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src');
      try {
        const imgBlob = await readFileAt(currentSlug, src);
        img.dataset.srcPath = src; // the real relPath — src itself becomes a blob: URL below
        img.setAttribute('src', URL.createObjectURL(imgBlob));
      } catch (err) {
        console.warn('could not load image', src, err);
      }
    }),
  );
}

// Undo/redo used to call renderPreviewFromSource() — a full iframe
// reload that re-fetched every image in the deck just to revert one
// field. This patches only what actually differs between the current
// live preview and the target snapshot, directly in the existing (never
// reloaded) iframe document — so a text undo touches one node, not ~20
// images and a full navigation.
async function applySnapshotDiff(newHtmlString, targetSlideIndex) {
  const newSourceDoc = new DOMParser().parseFromString(newHtmlString, 'text/html');
  const newSlides = Array.from(newSourceDoc.querySelectorAll('.slide-viewport'));
  const previewDoc = els.preview.contentDocument;
  const previewSlides = Array.from(previewDoc.querySelectorAll('.slide-viewport'));

  if (newSlides.length !== previewSlides.length) {
    // Shouldn't happen (this editor never adds/removes slides) — fall
    // back to the safe full rebuild rather than risk a broken pairing.
    sourceDoc = newSourceDoc;
    await renderPreviewFromSource(targetSlideIndex);
    return;
  }

  for (let i = 0; i < newSlides.length; i++) {
    const newFields = collectFields(newSlides[i]);
    const previewFields = collectFields(previewSlides[i]);

    const structurallyChanged =
      newFields.images.length !== previewFields.images.length ||
      newFields.emptySlots.length !== previewFields.emptySlots.length;

    if (structurallyChanged) {
      // An image was added to/removed from an empty slot — rebuild just
      // this one slide's subtree rather than the whole document.
      const container = document.createElement('div');
      container.innerHTML = newSlides[i].innerHTML;
      await hydrateImages(container);
      previewSlides[i].innerHTML = container.innerHTML;
      continue;
    }

    newFields.texts.forEach((newEl, idx) => {
      const previewEl = previewFields.texts[idx];
      if (previewEl && previewEl.innerHTML !== newEl.innerHTML) {
        previewEl.innerHTML = newEl.innerHTML;
      }
    });

    for (const [idx, newImg] of newFields.images.entries()) {
      const previewImg = previewFields.images[idx];
      if (!previewImg) continue;
      const newPos = newImg.style.objectPosition || '';
      if (previewImg.style.objectPosition !== newPos) previewImg.style.objectPosition = newPos;

      const newSrc = newImg.getAttribute('src') || '';
      const currentSrcPath = previewImg.dataset.srcPath || previewImg.getAttribute('src') || '';
      if (currentSrcPath === newSrc) continue;
      if (/^https?:/i.test(newSrc)) {
        previewImg.removeAttribute('data-src-path');
        previewImg.src = newSrc;
        continue;
      }
      try {
        const imgBlob = await readFileAt(currentSlug, newSrc);
        previewImg.dataset.srcPath = newSrc;
        previewImg.src = URL.createObjectURL(imgBlob);
      } catch (err) {
        console.warn('could not load image for undo/redo', newSrc, err);
      }
    }
  }

  sourceDoc = newSourceDoc;
  slidePairs = newSlides.map((sourceSlide, i) => {
    const previewSlide = previewSlides[i];
    const heading = sourceSlide.querySelector('h1, h2, .eyebrow');
    const label = heading ? heading.textContent.trim().slice(0, 40) : `slide ${i + 1}`;
    return { sourceSlide, previewSlide, label };
  });
  renderSlideNav();
  goToSlide(targetSlideIndex);
}

async function renderPreviewFromSource(targetSlideIndex) {
  const parser = new DOMParser();
  const previewDoc = parser.parseFromString(sourceDoc.documentElement.outerHTML, 'text/html');
  previewDoc.querySelectorAll('script').forEach((s) => s.remove());
  const overrideStyle = previewDoc.createElement('style');
  overrideStyle.id = '__editor_preview_override';
  overrideStyle.textContent = `
    .reveal,.reveal-left,.reveal-right,.reveal-scale,.reveal-blur,.step{
      opacity:1 !important; transform:none !important; filter:none !important;
    }
    .slide-viewport{display:none !important;}
    .slide-viewport.__editor-active{display:block !important;}
    .nav-dots,.keyboard-hint,.chassis-credit,.chassis-cursor{display:none !important;}
    body.chassis-cursor-active, body.chassis-cursor-active *{cursor:auto !important;}
    html.__editor-edit-mode [data-editor-editable="true"]:hover{outline:2px dashed #ff6a21; outline-offset:2px; cursor:pointer !important;}
    html.__editor-edit-mode [data-editor-editable="true"][contenteditable="true"]:focus{outline:2px solid #ff6a21; outline-offset:2px; cursor:text !important;}
    .editor-drag-over{
      outline:4px dashed #ff6a21 !important;
      outline-offset:-4px;
      background:rgba(255,106,33,0.18) !important;
      filter:brightness(1.05);
    }
  `;
  previewDoc.head.appendChild(overrideStyle);

  await hydrateImages(previewDoc);

  const blob = new Blob([docPrefix + previewDoc.documentElement.outerHTML], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  await new Promise((resolve) => {
    els.preview.onload = resolve;
    els.preview.src = url;
  });

  const previewDocLive = els.preview.contentDocument;
  previewDocLive.addEventListener('dragover', (e) => e.preventDefault());
  previewDocLive.addEventListener('drop', (e) => e.preventDefault());
  previewDocLive.addEventListener('keydown', handleUndoKeydown);

  buildSlidePairs();
  renderSlideNav();
  goToSlide(targetSlideIndex);
  applyZoom();
}

// ---------- Present mode (unchanged) ----------

async function enterPresentMode() {
  if (!sourceDoc || !currentSlug || !slidePairs[currentSlide]) return;

  const presentDoc = new DOMParser().parseFromString(sourceDoc.documentElement.outerHTML, 'text/html');
  await hydrateImages(presentDoc);

  const targetId = slidePairs[currentSlide].sourceSlide.id || `slide-${currentSlide + 1}`;
  const blob = new Blob([docPrefix + presentDoc.documentElement.outerHTML], { type: 'text/html' });
  els.presentOverlay.hidden = false;

  await new Promise((resolve) => {
    els.presentFrame.onload = resolve;
    els.presentFrame.src = `${URL.createObjectURL(blob)}#${targetId}`;
  });

  try {
    await els.presentOverlay.requestFullscreen();
  } catch (err) {
    console.warn('fullscreen request failed', err);
    setStatus('não deu pra entrar em tela cheia, mas a apresentação abriu — F11 no navegador também funciona', '');
  }

  const nudge = () => els.presentFrame.contentWindow?.dispatchEvent(new Event('resize'));
  requestAnimationFrame(() => requestAnimationFrame(nudge));
  setTimeout(nudge, 300);
}

function exitPresentMode() {
  els.presentOverlay.hidden = true;
  els.presentFrame.src = 'about:blank';
  if (document.fullscreenElement) document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !els.presentOverlay.hidden) exitPresentMode();
});

function buildSlidePairs() {
  const sourceSlides = Array.from(sourceDoc.querySelectorAll('.slide-viewport'));
  const previewSlides = Array.from(els.preview.contentDocument.querySelectorAll('.slide-viewport'));
  if (sourceSlides.length !== previewSlides.length) {
    console.warn('slide count mismatch between source and preview — editor may be unreliable for this deck');
  }
  slidePairs = sourceSlides.map((sourceSlide, i) => {
    const previewSlide = previewSlides[i];
    previewSlide.classList.toggle('__editor-active', i === 0);
    const heading = sourceSlide.querySelector('h1, h2, .eyebrow');
    const label = heading ? heading.textContent.trim().slice(0, 40) : `slide ${i + 1}`;
    return { sourceSlide, previewSlide, label };
  });
}

function renderSlideNav() {
  els.slideNav.innerHTML = '';
  slidePairs.forEach((pair, i) => {
    const btn = document.createElement('button');
    btn.innerHTML = `<span class="n">${String(i + 1).padStart(2, '0')}</span>${pair.label || '(vazio)'}`;
    btn.addEventListener('click', () => goToSlide(i));
    els.slideNav.appendChild(btn);
  });
}

function goToSlide(i) {
  if (!slidePairs[i]) return;
  slidePairs.forEach((pair, idx) => pair.previewSlide.classList.toggle('__editor-active', idx === i));
  Array.from(els.slideNav.children).forEach((btn, idx) => btn.classList.toggle('active', idx === i));
  currentSlide = i;
  wireCurrentSlideFields();
}

// ---------- Wiring edit interactions for the visible slide (unchanged) ----------

function wireCurrentSlideFields() {
  const pair = slidePairs[currentSlide];
  if (!pair) return;
  els.preview.contentDocument.documentElement.classList.toggle('__editor-edit-mode', isEditMode());
  const sourceFields = collectFields(pair.sourceSlide);
  const previewFields = collectFields(pair.previewSlide);

  previewFields.texts.forEach((previewEl, i) => {
    const sourceEl = sourceFields.texts[i];
    if (!sourceEl) return;
    previewEl.dataset.editorEditable = 'true';
    previewEl.contentEditable = isEditMode() ? 'true' : 'false';
    previewEl.onblur = () => {
      const clean = sanitizeInline(previewEl.innerHTML);
      if (clean !== previewEl.innerHTML) previewEl.innerHTML = clean;
      if (sourceEl.innerHTML !== clean) {
        pushUndoSnapshot();
        sourceEl.innerHTML = clean;
        markDirty();
      }
    };
  });

  previewFields.images.forEach((previewImg, i) => {
    const sourceImg = sourceFields.images[i];
    if (!sourceImg) return;
    previewImg.dataset.editorEditable = 'true';
    wireImageInteractions(previewImg, sourceImg);
    wireDropTarget(previewImg, (file) => swapImage(previewImg, sourceImg, file));
  });

  previewFields.emptySlots.forEach((previewSlot, i) => {
    const sourceSlot = sourceFields.emptySlots[i];
    if (!sourceSlot) return;
    previewSlot.dataset.editorEditable = 'true';
    previewSlot.onclick = () => {
      if (!isEditMode()) return;
      fillEmptySlot(previewSlot, sourceSlot);
    };
    wireDropTarget(previewSlot, (file) => fillEmptySlot(previewSlot, sourceSlot, file));
  });
}

function wireDropTarget(el, onFile) {
  el.addEventListener('dragenter', (e) => {
    if (!isEditMode()) return;
    e.preventDefault();
    el.classList.add('editor-drag-over');
  });
  el.addEventListener('dragover', (e) => {
    if (!isEditMode()) return;
    e.preventDefault();
  });
  el.addEventListener('dragleave', () => el.classList.remove('editor-drag-over'));
  el.addEventListener('drop', (e) => {
    if (!isEditMode()) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('editor-drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) onFile(file);
  });
}

function wireImageInteractions(previewImg, sourceImg) {
  let moved = false;
  let dragStart = null;
  let startPos = null;
  let rect = null;

  function onMouseMove(e) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    const nextX = clampPct(startPos.x - (dx / rect.width) * 100);
    const nextY = clampPct(startPos.y - (dy / rect.height) * 100);
    const pos = `${nextX.toFixed(1)}% ${nextY.toFixed(1)}%`;
    previewImg.style.objectPosition = pos;
    sourceImg.style.objectPosition = pos;
  }

  function onMouseUp() {
    previewImg.ownerDocument.removeEventListener('mousemove', onMouseMove);
    if (moved) {
      sourceImg.style.objectPosition = previewImg.style.objectPosition;
      markDirty();
    } else {
      undoStack.pop();
      updateUndoRedoButtons();
    }
  }

  previewImg.onmousedown = (e) => {
    if (!isEditMode()) return;
    moved = false;
    dragStart = { x: e.clientX, y: e.clientY };
    startPos = parseObjectPosition(previewImg.style.objectPosition);
    rect = previewImg.getBoundingClientRect();
    e.preventDefault();
    pushUndoSnapshot();
    const doc = previewImg.ownerDocument;
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('mouseup', onMouseUp, { once: true });
  };

  previewImg.onclick = async () => {
    if (!isEditMode() || moved) return;
    await swapImage(previewImg, sourceImg);
  };
}

function parseObjectPosition(value) {
  const m = /(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/.exec(value || '');
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 50, y: 50 };
}
function clampPct(n) {
  return Math.max(0, Math.min(100, n));
}

// Picking a replacement file now goes through a plain <input type=file> —
// works in any browser, not just Chromium (the local editor's
// showOpenFilePicker was File System Access API only).
function pickImageFile() {
  return new Promise((resolve) => {
    els.fileInput.value = '';
    els.fileInput.onchange = () => resolve(els.fileInput.files[0] || null);
    els.fileInput.click();
  });
}

async function swapImage(previewImg, sourceImg, droppedFile) {
  const file = droppedFile || (await pickImageFile());
  if (!file) return;
  const relPath = sourceImg.getAttribute('src');
  let previousBytes = null;
  try {
    previousBytes = await readFileAt(currentSlug, relPath);
  } catch (err) {
    console.warn('could not read previous image for undo', relPath, err);
  }
  pushUndoSnapshot(previousBytes ? { relPath, bytes: previousBytes } : null);
  setStatus('enviando imagem…', '');
  try {
    await writeFileAt(currentSlug, relPath, file);
  } catch (err) {
    setStatus('erro ao enviar imagem: ' + err.message, 'error');
    return;
  }
  previewImg.dataset.srcPath = relPath;
  previewImg.src = URL.createObjectURL(file);
  markDirty();
  setStatus(`imagem "${relPath}" atualizada — publique pra valer`, 'ok');
}

async function fillEmptySlot(previewSlot, sourceSlot, droppedFile) {
  const file = droppedFile || (await pickImageFile());
  if (!file) return;
  const ext = file.name.slice(file.name.lastIndexOf('.'));
  const relPath = `images/${slugify(file.name.replace(ext, ''))}${ext}`;
  setStatus('enviando imagem…', '');
  try {
    await writeFileAt(currentSlug, relPath, file);
  } catch (err) {
    setStatus('erro ao enviar imagem: ' + err.message, 'error');
    return;
  }

  pushUndoSnapshot();
  for (const [slot, doc] of [[sourceSlot, sourceDoc], [previewSlot, els.preview.contentDocument]]) {
    const img = doc.createElement('img');
    if (slot === previewSlot) img.dataset.srcPath = relPath;
    img.setAttribute('src', slot === sourceSlot ? relPath : URL.createObjectURL(file));
    img.setAttribute('alt', '');
    slot.querySelectorAll('.hint').forEach((h) => h.remove());
    slot.classList.remove('empty');
    slot.appendChild(img);
  }
  markDirty();
  setStatus(`imagem nova enviada em ${relPath} — publique pra valer`, 'ok');
  wireCurrentSlideFields();
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents after NFD normalization
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------- Publish ----------

async function publishTalk() {
  try {
    setStatus('publicando…', '');
    els.btnPublish.disabled = true;
    const html = docPrefix + sourceDoc.documentElement.outerHTML;
    const result = await writeFileAt(currentSlug, 'index.html', new Blob([html], { type: 'text/html' }));
    dirty = false;
    setStatus(result?.warning ? result.warning : 'publicado — já no ar', 'ok');
  } catch (err) {
    console.error(err);
    els.btnPublish.disabled = false;
    setStatus('erro ao publicar: ' + err.message, 'error');
  }
}

// ---------- Talk list / search (replaces the folder picker) ----------

const LAST_TALK_KEY = 'slides-editor:lastTalkSlug';
function saveLastTalkSlug(slug) {
  try {
    localStorage.setItem(LAST_TALK_KEY, slug);
  } catch {}
}
function loadLastTalkSlug() {
  try {
    return localStorage.getItem(LAST_TALK_KEY);
  } catch {
    return null;
  }
}

async function fetchTalkList() {
  const res = await fetch(`${cfg.contentBase}/materiais/talks.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`talks.json: ${res.status}`);
  const raw = await res.json();
  const out = [];
  for (const t of raw) {
    const m = /^\/materiais\/([^/]+)\/$/.exec(t.href || '');
    if (m) out.push({ label: t.title, slug: m[1], date: t.date });
  }
  return out;
}

function renderTalkList(filterText) {
  const q = (filterText || '').trim().toLowerCase();
  const filtered = q ? talks.filter((t) => t.label.toLowerCase().includes(q)) : talks;
  els.talkList.innerHTML = '';
  if (filtered.length === 0) {
    els.talkList.innerHTML = '<div class="talk-list-empty">nenhuma palestra encontrada</div>';
    return;
  }
  for (const t of filtered) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'talk-list-item';
    item.innerHTML = `<span class="talk-list-title">${escapeHtml(t.label)}</span><span class="talk-list-date">${escapeHtml(t.date || '')}</span>`;
    item.addEventListener('click', () => {
      if (dirty && !confirm('Tem edição não publicada. Trocar de palestra mesmo assim?')) return;
      openTalk(t);
    });
    els.talkList.appendChild(item);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openGateBrowse() {
  els.gateOverlay.hidden = false;
  els.gateLogin.hidden = true;
  els.gateBrowse.hidden = false;
  els.talkSearch.value = '';
  renderTalkList('');
  els.talkSearch.focus();
}
function closeGate() {
  els.gateOverlay.hidden = true;
}

async function showBrowseScreen(autoOpenLast) {
  setStatus('procurando palestras…', '');
  try {
    talks = await fetchTalkList();
  } catch (err) {
    setStatus('erro ao listar palestras: ' + err.message, 'error');
    talks = [];
  }
  openGateBrowse();
  setStatus('', '');

  if (autoOpenLast) {
    const lastSlug = loadLastTalkSlug();
    const found = talks.find((t) => t.slug === lastSlug);
    if (found) await openTalk(found);
  }
}

// ---------- Wiring top-level UI ----------

els.btnBrowse.addEventListener('click', () => {
  if (dirty && !confirm('Tem edição não publicada. Trocar de palestra mesmo assim?')) return;
  openGateBrowse();
});
els.talkSearch.addEventListener('input', () => renderTalkList(els.talkSearch.value));

els.btnLogin.addEventListener('click', beginLogin);
els.btnLogout.addEventListener('click', logout);

els.slideNav.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const next = e.key === 'ArrowDown' ? currentSlide + 1 : currentSlide - 1;
  if (next < 0 || next >= slidePairs.length) return;
  goToSlide(next);
  els.slideNav.children[next]?.focus();
});

els.modeTrigger.addEventListener('click', () => {
  if (els.modeTrigger.disabled) return;
  els.modeOptions.hidden = !els.modeOptions.hidden;
});
els.modeOptions.querySelectorAll('.mode-option').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});
document.addEventListener('click', (e) => {
  if (!els.modeOptions.hidden && !e.target.closest('.mode-menu')) els.modeOptions.hidden = true;
});

els.zoomIn.addEventListener('click', () => {
  zoomFactor = Math.min(3, zoomFactor + 0.15);
  applyZoom();
});
els.zoomOut.addEventListener('click', () => {
  zoomFactor = Math.max(0.3, zoomFactor - 0.15);
  applyZoom();
});
els.zoomReset.addEventListener('click', () => {
  zoomFactor = 1;
  applyZoom();
});

els.btnUndo.addEventListener('click', undo);
els.btnRedo.addEventListener('click', redo);
window.addEventListener('keydown', handleUndoKeydown);

els.btnPresent.addEventListener('click', enterPresentMode);
els.btnPublish.addEventListener('click', publishTalk);

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- Boot ----------

(async function boot() {
  els.gateOverlay.hidden = false;
  els.gateLogin.hidden = true;
  els.gateBrowse.hidden = true;
  setStatus('verificando login…', '');
  let idToken = null;
  try {
    idToken = await ensureAuthenticated();
  } catch (err) {
    console.error(err);
  }
  if (!idToken) {
    els.gateLogin.hidden = false;
    setStatus('', '');
    return;
  }
  await showBrowseScreen(true);
})();
