(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const pdfjs = window['pdfjs-dist/build/pdf'];
  pdfjs.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  /* ---------- constants ---------- */
  const COLORS = { black: [0, 0, 0], blue: [0.05, 0.2, 0.65] };
  const CSS_COLOR = { black: '#000', blue: '#0d33a6' };
  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const MAX_BYTES = 150 * 1024 * 1024, MAX_TOTAL = 300 * 1024 * 1024, MAX_PAGES = 500;
  const MIN_SIZE = 5, MAX_SIZE = 48;
  const SIG_FONTS = ['Homemade Apple', 'La Belle Aurore', 'Cedarville Cursive', 'Nothing You Could Do', 'Zeyada', 'Dawning of a New Day'];
  const SIG_MIN = 8, SIG_MAX = 100, SIG_K = 4;       // SIG_K = render scale for crisp signatures

  /* ---------- state ---------- */
  let sources = [], nextSrc = 1, fileName = 'form.pdf';   // sources: {id, name, bytes, doc, password}
  // Page sizes (w, h) and item positions are in the page's unrotated space (rotation 0, top-left origin, PDF units).
  // rot = how the page is shown (0/90/180/270, clockwise); items turn with their page. ang = page rotation when an
  // item was placed, so it reads upright then.
  let pages = [];                 // {n, el, canvas, textEl, annEl, layer, ghost, w, h, rot, page, src, idx, task, drawn, thumb…}
  let items = [];                 // {id, page, type, x, y, size, color, text, ang}
  let tool = 'text', color = 'black', size = 10, bold = false;
  let sig = null, signSize = 28, lastName = '';   // sig = {text, font} chosen in the dialog
  const sigCache = new Map();
  let scale = 1.25, fit = true;
  let selected = null, nextId = 1, history = [], dirty = false, curPage = 1;
  let loadToken = 0;

  const stage = $('stage'), pagesEl = $('pages'), thumbList = $('thumbList');
  const hasDoc = () => pages.length > 0;
  const isPdf = f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

  /* ---------- tiny helpers ---------- */
  let toastTimer;
  function toast(msg, warn = false) {
    const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', warn); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), warn ? 5000 : 2600);
  }
  const hint = t => { $('hint').textContent = t; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const markBox = it => it.size * 1.15;
  const dims = p => p.rot % 180 ? [p.h, p.w] : [p.w, p.h];          // displayed width, height (page units)
  // vector (vx, vy) in an item's own frame -> unrotated page space, for an item turned by `a` degrees
  function rotVec(vx, vy, a) {
    const q = ((a || 0) / 90) & 3, c = [1, 0, -1, 0][q], s = [0, 1, 0, -1][q];
    return [vx * c + vy * s, -vx * s + vy * c];
  }
  function toBase(p, cx, cy) {                 // screen point -> unrotated page space
    const r = p.el.getBoundingClientRect(), [W, H] = dims(p), X = (cx - r.left) / scale, Y = (cy - r.top) / scale;
    return p.rot === 90 ? [Y, W - X] : p.rot === 180 ? [W - X, H - Y] : p.rot === 270 ? [H - Y, X] : [X, Y];
  }
  const svgNS = 'http://www.w3.org/2000/svg';

  function markSVG(type, px, col) {
    const s = document.createElementNS(svgNS, 'svg');
    s.setAttribute('width', px); s.setAttribute('height', px); s.setAttribute('viewBox', '0 0 10 10');
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', type === 'check' ? 'M1.2 5.4 L4 8.2 L8.8 1.6' : 'M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5');
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', CSS_COLOR[col] || '#000');
    p.setAttribute('stroke-width', '1.25'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p); return s;
  }

  /* ---------- signatures (rendered to a tight transparent PNG so screen == PDF) ---------- */
  let fontsReady = null;
  function loadFonts() {
    if (!fontsReady) fontsReady = Promise.all(SIG_FONTS.map(f => document.fonts.load(`32px "${f}"`, 'Abc'))).catch(() => {});
    return fontsReady;
  }
  function sigImage(it) {
    const key = [it.text, it.font, it.size, it.color].join('|');
    let c = sigCache.get(key); if (c) return c;
    const S = it.size * SIG_K, cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    const font = `${S}px "${it.font}"`; ctx.font = font;
    const m = ctx.measureText(it.text), pad = Math.ceil(S * 0.12);
    const left = Math.ceil(m.actualBoundingBoxLeft), right = Math.ceil(m.actualBoundingBoxRight);
    const asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    cv.width = Math.max(left + right, 1) + pad * 2; cv.height = Math.max(asc + desc, 1) + pad * 2;
    ctx.font = font; ctx.fillStyle = CSS_COLOR[it.color] || '#000'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(it.text, pad + left, pad + asc);
    c = { url: cv.toDataURL('image/png'), w: cv.width / SIG_K, h: cv.height / SIG_K };
    if (sigCache.size > 80) sigCache.clear();
    sigCache.set(key, c); return c;
  }
  function sigEl(it, px) {                     // <img> for a signature at the given scale
    const c = sigImage(it), img = document.createElement('img');
    img.src = c.url; img.alt = ''; img.draggable = false;
    img.style.width = c.w * px + 'px'; img.style.height = c.h * px + 'px'; return img;
  }
  // top-left of an item's element, in CSS px
  // top-left of an item's element, in layer units (page units x U)
  function originOf(it) {
    if (it.type === 'sign') { const c = sigImage(it); return [(it.x - c.w / 2) * U, (it.y - c.h / 2) * U]; }
    if (it.type === 'mark' || it.type === 'check' || it.type === 'cross') { const b = markBox(it); return [(it.x - b / 2) * U, (it.y - b / 2) * U]; }
    return [it.x * U, it.y * U];
  }

  function pushHistory() {
    history.push(JSON.stringify(items)); if (history.length > 200) history.shift();
    $('undo').disabled = false; dirty = true;
  }

  /* ---------- tools / controls ---------- */
  const HINTS = {
    text: 'Click where the text should start, then type. Enter to finish.',
    sign: 'Click where your signature should go. Press S to change it.',
    check: 'Click the middle of a box to tick it.',
    cross: 'Click the middle of a box to put an X in it.',
    select: 'Select text to copy it (Ctrl+C), or drag items to move them. Double-click your text to edit.',
    redact: 'Drag a box over text to black it out. The text under it is deleted from the saved PDF. F = find & redact.'
  };
  function setTool(t) {                        // user-facing: the Sign tool opens the dialog first
    if (t === 'sign' && (!sig || tool === 'sign')) { openSignDialog(); return; }
    activateTool(t);
  }
  function activateTool(t) {
    tool = t; showSize(); document.body.classList.toggle('mode-select', t === 'select');
    document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    pages.forEach(p => { p.layer.className = 'layer tool-' + t; p.ghost.style.display = 'none'; });
    passL = null; removeEventListener('pointermove', unpass);
    hint(HINTS[t]);
    if (t === 'select') pump();                        // builds the selectable text of the pages in view
  }
  function setColor(c) {
    color = c;
    document.querySelectorAll('.sw').forEach(b => { const on = b.dataset.color === c; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  }
  const showSize = () => { $('sizeOut').textContent = tool === 'sign' ? signSize : size; };
  function setSize(s) { size = clamp(Math.round(s), MIN_SIZE, MAX_SIZE); showSize(); }
  function adjustSize(d) {
    const it = itemById(selected);
    if (it && it.type === 'redact') return;
    if (it && it.type === 'sign') { const s = clamp(it.size + d * 2, SIG_MIN, SIG_MAX); changeSelected({ size: s }); $('sizeOut').textContent = s; return; }
    if (!it && tool === 'sign') { signSize = clamp(signSize + d * 2, SIG_MIN, SIG_MAX); showSize(); return; }
    setSize(size + d); if (it) changeSelected({ size });
  }
  function setBold(b) { bold = !!b; $('boldBtn').setAttribute('aria-pressed', bold); }
  function syncControlsTo(it) {
    if (it.type === 'redact') return;
    setColor(it.color);
    if (it.type === 'sign') { $('sizeOut').textContent = it.size; return; }
    setSize(it.size); if (it.type === 'text') setBold(it.bold);
  }

  function changeSelected(patch) {
    const it = items.find(i => i.id === selected); if (!it) return;
    pushHistory(); Object.assign(it, patch); redraw(it.page);
  }

  /* ---------- opening & combining PDFs ---------- */
  async function readPdf(file) {                       // -> source {id,name,bytes,doc,password} or null (toasts why)
    if (file.size > MAX_BYTES) { toast(`${file.name}: too large (limit 150 MB).`, true); return null; }
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { toast('Could not read ' + file.name + '.', true); return null; }
    if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') { toast(file.name + ' does not look like a PDF file.', true); return null; }
    try {
      const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false });
      let password = '';
      task.onPassword = (update, reason) => {         // kept so the file can be decrypted when saving
        const pw = prompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD
          ? 'Wrong password. Try again:' : file.name + ' is password-protected. Enter its password:');
        if (pw === null) { task.destroy(); return; }
        update(password = pw);
      };
      const doc = await task.promise;
      return { id: nextSrc++, name: file.name || 'document.pdf', bytes, doc, password };
    } catch (e) {
      toast(e && e.name === 'PasswordException' ? file.name + ' is password-protected and cannot be opened.' : 'Could not open ' + file.name + '.', true);
      return null;
    }
  }
  async function modelsFor(src) {                      // one page model per page of the source (fetched in parallel)
    const all = await Promise.all(Array.from({ length: src.doc.numPages }, (_, i) => src.doc.getPage(i + 1)));
    return all.map((page, i) => {
      const vp = page.getViewport({ scale: 1, rotation: 0 }), rot = ((page.rotate % 360) + 360) % 360;
      return { n: 0, w: vp.width, h: vp.height, rot, page, src, idx: i, task: null, drawn: null };
    });
  }

  async function openPdf(file) {                       // replaces the current document
    if (!file) return;
    if (hasDoc() && dirty && !confirm('You have unsaved changes. Open a different PDF anyway?')) return;
    const token = ++loadToken;
    const src = await readPdf(file); if (!src) return;
    const models = await modelsFor(src);
    if (token !== loadToken) { src.doc.destroy(); return; }
    pages.forEach(dropPage);
    sources.forEach(s => s.doc.destroy()); sources = [src]; fileName = src.name;
    items = []; history = []; selected = null; nextId = 1; dirty = false; curPage = 1;
    $('undo').disabled = true; $('del').disabled = true;
    document.body.classList.add('loaded'); $('toolbar').hidden = false;
    ['save', 'saveWork', 'loadWorkBtn', 'addBtn2', 'findBtn'].forEach(i => { $(i).disabled = false; });
    pages = models; renumber(); rebuildDom(); updateFileLabel();
    stage.scrollTo(0, 0); activateTool('text');
    try {                                              // dynamic XFA forms show only a "please wait" page
      const { info } = await src.doc.getMetadata();
      if (info && info.IsXFAPresent && !(await fieldObjects(src))) toast('This is a dynamic XFA form and cannot be filled here. Use the form’s printable PDF version.', true);
      else if (await fieldObjects(src)) hint('This PDF has form fields: click a field (or press Tab) to fill it in.');
    } catch { /* ignore */ }
  }

  async function addPdfs(files, at = pages.length) {   // inserts the pages of one or more PDFs at position `at`
    files = [...files].filter(isPdf);
    if (!files.length) { toast('Please choose PDF files.', true); return; }
    if (!hasDoc()) { await openPdf(files[0]); files = files.slice(1); at = pages.length; if (!files.length) return; }
    let pos = clamp(at, 0, pages.length), added = 0;
    for (const f of files) {
      const total = sources.reduce((s, x) => s + x.bytes.length, 0) + f.size;
      if (total > MAX_TOTAL) { toast('The combined files are too large (limit 300 MB).', true); break; }
      const src = await readPdf(f); if (!src) continue;
      if (pages.length + src.doc.numPages > MAX_PAGES) { toast(`Too many pages (limit ${MAX_PAGES}).`, true); src.doc.destroy(); break; }
      const models = await modelsFor(src);
      sources.push(src);
      const list = pages.slice(); list.splice(pos, 0, ...models); restructure(list);
      pos += models.length; added += models.length;
    }
    if (added) toast(`Added ${added} page${added === 1 ? '' : 's'}. Save PDF to download the combined file.`);
  }

  const renumber = () => pages.forEach((p, i) => { p.n = i + 1; });
  // Apply a new page list (reordered / added / removed). Items follow their pages; items on removed pages go.
  function restructure(list) {
    const old = pages, pos = new Map(list.map((p, i) => [p, i + 1])), keep = new Set(list);
    items = items.map(it => ({ ...it, page: pos.get(old[it.page - 1]) })).filter(it => it.page);
    old.forEach(p => { if (!keep.has(p)) dropPage(p); });
    pages = list; renumber();
    sources = sources.filter(s => pages.some(p => p.src === s) || (s.doc.destroy(), false));
    selected = null; history = []; dirty = true; curPage = clamp(curPage, 1, pages.length);
    $('undo').disabled = true; $('del').disabled = true;
    rebuildDom(); updateFileLabel();
  }
  function moveTo(from, idx) {                         // idx = insertion slot (0..pages.length) in the current order
    if (idx === from || idx === from + 1) return;
    const list = pages.slice(), [m] = list.splice(from, 1); list.splice(idx > from ? idx - 1 : idx, 0, m);
    restructure(list);
  }
  function removePage(p) {
    if (pages.length === 1) { toast('A document needs at least one page.', true); return; }
    const n = items.filter(i => i.page === p.n).length;
    if (n && !confirm(`Remove page ${p.n}? Its ${n} item${n === 1 ? '' : 's'} will be removed too.`)) return;
    restructure(pages.filter(x => x !== p));
    toast(`Removed page ${p.n}.`);
  }
  function updateFileLabel() {
    const f = $('fileName'), first = sources[0] ? sources[0].name : 'No file open';
    if (sources[0]) fileName = sources[0].name;
    const extra = sources.length - 1;
    f.textContent = extra > 0 ? `${first} + ${extra} more` : first;
    f.title = sources.map(s => s.name).join('\n') || first; f.classList.toggle('has', sources.length > 0);
    document.title = (sources.length ? first + (extra > 0 ? ` + ${extra}` : '') + ' – ' : '') + 'Fill PDF';
  }

  // Page DOM: canvas (picture) < textLayer (Select tool) < annotationLayer (form fields) < layer (our items) < ghost.
  // Elements are made once per page and reused when pages are reordered.
  function buildPageDom(p) {
    const el = document.createElement('div'); el.className = 'page'; el._p = p;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 0;   // no pixels until drawn
    const textEl = document.createElement('div'); textEl.className = 'textLayer';
    const annEl = document.createElement('div'); annEl.className = 'annotationLayer';
    const layer = document.createElement('div'); layer.className = 'layer';
    const ghost = document.createElement('div'); ghost.className = 'ghost';
    const num = document.createElement('div'); num.className = 'num';
    el.append(canvas, textEl, annEl, layer, ghost, num);
    Object.assign(p, { el, canvas, textEl, annEl, layer, ghost, num, task: null, drawn: null, textRot: null, ann: null, annRot: null });
    attachLayer(p);
  }
  function dropPage(p) {                               // page leaves the document
    if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } }
    if (p.el) { pageIO && pageIO.unobserve(p.el); near.delete(p); }
    if (p.thumb) { thumbObserver && thumbObserver.unobserve(p.thumb); thumbWant.delete(p); }
  }
  function rebuildDom() {
    pages.forEach(p => { if (!p.el) buildPageDom(p); if (!p.thumb) addThumb(p); });
    pagesEl.replaceChildren(...pages.map(p => p.el));
    thumbList.replaceChildren(...pages.map(p => p.thumb));
    pages.forEach(p => {
      p.num.textContent = p.n; p.thumb.dataset.n = p.n; p.thumbNum.textContent = p.n;
      p.thumbGo.setAttribute('aria-label', 'Go to page ' + p.n); p.thumbDel.setAttribute('aria-label', 'Remove page ' + p.n);
      p.thumb.className = 'thumb s' + (sources.indexOf(p.src) % 6) + (p.n === curPage ? ' cur' : '');
      pageIO && pageIO.observe(p.el); thumbObserver && thumbObserver.observe(p.thumb);
    });
    lastCurThumb = null;
    computeScale(); layout(); redrawAll(); activateTool(tool); updatePageInfo();
  }

  /* ---------- layout & rendering ---------- */
  // Items live in a layer measured in page units x U (so tiny fonts are never clamped by the browser), which is
  // scaled and turned with one CSS transform. Zooming therefore only changes a few styles per page; the canvas
  // keeps its old (stretched) picture until the scheduler re-renders it.
  const U = 4;
  const MAX_PX = 16777216;                             // canvas pixel cap per page (same as pdf.js' viewer)
  function computeScale() {
    if (!fit || !pages.length) return;
    const avail = stage.clientWidth - (window.innerWidth <= 860 ? 16 : 44) - (stage.offsetWidth - stage.clientWidth);
    const widest = Math.max(...pages.map(p => dims(p)[0]));
    scale = clamp(avail / widest, 0.4, 1.5);
  }
  function placePage(p) {
    const [W, H] = dims(p).map(v => v * scale);
    p.el.style.width = W + 'px'; p.el.style.height = H + 'px';
    p.layer.style.width = p.w * U + 'px'; p.layer.style.height = p.h * U + 'px';
    p.layer.style.transform = { 0: '', 90: `translate(${W}px,0) rotate(90deg)`, 180: `translate(${W}px,${H}px) rotate(180deg)`, 270: `translate(0,${H}px) rotate(270deg)` }[p.rot] + ` scale(${scale / U})`;
  }
  function layout() {
    $('zoomFit').textContent = Math.round(scale * 100) + '%';
    $('zoomFit').title = fit ? 'Fit to width (on)' : 'Fit to width';
    pagesEl.style.setProperty('--scale-factor', scale);     // pdf.js text and form layers size themselves with it
    pagesEl.style.setProperty('--inv', U / scale);          // keeps outlines and handles a constant screen size
    pages.forEach(placePage);
    pump();
  }

  /* render scheduler: one page at a time, nearest to the middle of the view first; pages far away are freed */
  const near = new Set(), thumbWant = new Set();
  let busy = false;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  const keyOf = p => scale + '|' + p.rot + '|' + dpr();
  const pageIO = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const en of entries) {
      const p = en.target._p; if (!p) continue;
      if (en.isIntersecting) near.add(p); else { near.delete(p); evict(p); }
    }
    pump(); trackCurrent();
  }, { root: stage, rootMargin: '120% 0px' }) : null;
  function evict(p) {                                  // free the picture of a page that scrolled far away
    if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } p.task = null; }
    if (p.drawn) { p.canvas.width = p.canvas.height = 0; p.drawn = null; try { p.page.cleanup(); } catch { /* ignore */ } }
  }
  function nextJob() {
    const sr = stage.getBoundingClientRect(), mid = (sr.top + sr.bottom) / 2;
    let best = null, bestD = Infinity, kind = null;
    for (const p of near) {
      const want = p.drawn !== keyOf(p) ? 'draw' : p.annRot === null ? 'form' : p.ann && p.annRot !== p.rot ? 'form'
        : document.body.classList.contains('mode-select') && p.textRot !== p.rot + '|' + scale ? 'text' : null;
      if (!want) continue;
      const r = p.el.getBoundingClientRect(), d = r.bottom < mid ? mid - r.bottom : r.top > mid ? r.top - mid : 0;
      const dd = d + (want === 'draw' ? 0 : 1e5);      // all pictures before forms and text
      if (dd < bestD) { bestD = dd; best = p; kind = want; }
    }
    if (best) return [kind, best];
    for (const p of thumbWant) return ['thumb', p];
    return null;
  }
  let pumpRaf = 0;                                    // batch requests; measure only after the browser laid out
  function pump() { if (!pumpRaf) pumpRaf = requestAnimationFrame(() => { pumpRaf = 0; runPump(); }); }
  async function runPump() {
    if (busy || !pages.length) return;
    const job = nextJob(); if (!job) return;
    busy = true;
    const [kind, p] = job;
    try {
      if (kind === 'draw') await drawPage(p);
      else if (kind === 'form') await buildForm(p);
      else if (kind === 'text') await buildText(p);
      else await drawThumb(p);
    } catch (e) { if (!(e && e.name === 'RenderingCancelledException')) console.warn(e); }
    busy = false;
    runPump();
  }
  async function drawPage(p) {
    const key = keyOf(p), vp = p.page.getViewport({ scale, rotation: p.rot });
    const out = Math.min(dpr(), Math.sqrt(MAX_PX / (vp.width * vp.height)));
    const c = document.createElement('canvas');      // draw off-screen; the old picture stays up meanwhile
    c.width = Math.floor(vp.width * out); c.height = Math.floor(vp.height * out);
    const task = p.page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp,
      transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS });
    p.task = task;
    try { await task.promise; } finally { if (p.task === task) p.task = null; }
    if (!near.has(p) || keyOf(p) !== key) return;    // scrolled away or zoomed meanwhile
    p.canvas.width = p.canvas.height = 0; p.canvas.replaceWith(c); p.canvas = c; p.drawn = key;
    if (p.thumbRot !== p.rot) drawThumbFrom(p, c);
  }
  async function buildText(p) {                       // invisible, selectable text (Select tool only)
    p.textRot = p.rot + '|' + scale; p.textEl.textContent = '';
    try {
      await pdfjs.renderTextLayer({ textContentSource: p.page.streamTextContent(), container: p.textEl,
        viewport: p.page.getViewport({ scale, rotation: p.rot }), textDivs: [] }).promise;
    } catch { /* the page has no text */ }
  }

  /* ---------- form fields (pdf.js renders real inputs; values are written back by pdf.js on save) ---------- */
  const NO_LINKS = { externalLinkEnabled: false, isInPresentationMode: false, page: 0, rotation: 0, eventBus: null,
    getDestinationHash: () => '#', getAnchorUrl: () => '#', addLinkAttributes(a) { a.href = '#'; a.onclick = () => false; },
    goToDestination() {}, goToPage() {}, navigateTo() {}, executeNamedAction() {}, executeSetOCGState() {}, cachePageRef() {} };
  function fieldObjects(src) {
    if (!src.fields) src.fields = src.doc.getFieldObjects().catch(() => null);
    return src.fields;
  }
  async function buildForm(p) {
    if (p.ann) { p.annRot = p.rot; p.ann.update({ viewport: p.page.getViewport({ scale: 1, rotation: p.rot }).clone({ dontFlip: true }) }); return; }
    p.annRot = p.rot;
    if (!(await fieldObjects(p.src))) return;         // no form in this file
    const annots = (await p.page.getAnnotations({ intent: 'display' })).filter(a => a.subtype === 'Widget');
    if (!annots.length) return;
    const storage = p.src.doc.annotationStorage;
    if (!storage.onSetModified) storage.onSetModified = () => { dirty = true; };
    p.ann = new pdfjs.AnnotationLayer({ div: p.annEl, accessibilityManager: null, annotationCanvasMap: new Map(), page: p.page,
      viewport: p.page.getViewport({ scale: 1, rotation: p.rot }).clone({ dontFlip: true }) });
    await p.ann.render({ annotations: annots, linkService: NO_LINKS, renderForms: true, annotationStorage: storage,
      imageResourcesPath: '', downloadManager: null, enableScripting: false, hasJSActions: false, fieldObjects: await fieldObjects(p.src) });
  }
  const fieldAt = (x, y) => {                          // a form input under a screen point, if any
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.closest('.layer')) continue;
      const sec = el.closest('.annotationLayer section'); if (!sec) continue;
      return sec.querySelector('input, textarea, select') || null;
    }
    return null;
  };

  let curThumbRaf = 0, lastCurThumb = null;
  function trackCurrent() {                            // the page most in view (looks at nearby pages only)
    cancelAnimationFrame(curThumbRaf);
    curThumbRaf = requestAnimationFrame(() => {
      const sr = stage.getBoundingClientRect(); let best = null, bestVis = 0;
      for (const p of near) {
        const r = p.el.getBoundingClientRect(), vis = Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top);
        if (vis > bestVis) { bestVis = vis; best = p; }
      }
      if (best && best.n !== curPage) { curPage = best.n; updatePageInfo(); }
    });
  }
  function updatePageInfo() {
    $('pageinfo').textContent = hasDoc() ? `Page ${curPage} of ${pages.length}` : '';
    const t = pages[curPage - 1] && pages[curPage - 1].thumb;
    if (t === lastCurThumb) return;
    if (lastCurThumb) lastCurThumb.classList.remove('cur');
    if (t) { t.classList.add('cur'); t.scrollIntoView({ block: 'nearest' }); }
    lastCurThumb = t;
  }
  stage.addEventListener('scroll', () => { trackCurrent(); pump(); }, { passive: true });
  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (hasDoc() && fit) { computeScale(); layout(); } }, 150);
  });

  /* ---------- thumbnails / page list ---------- */
  const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const en of entries) {
      const p = en.target._p; if (!p) continue;
      if (en.isIntersecting && p.thumbRot !== p.rot) thumbWant.add(p); else thumbWant.delete(p);
    }
    pump();
  }, { root: $('thumbs'), rootMargin: '200px' }) : null;
  function sizeThumb(p) {
    const [tw, th] = dims(p), c = p.thumbCanvas;
    c.width = 110; c.height = Math.round(110 * th / tw); c.style.aspectRatio = `${tw} / ${th}`;
  }
  function drawThumbFrom(p, src) {                    // reuse the full page picture: no second render
    sizeThumb(p); p.thumbCanvas.getContext('2d').drawImage(src, 0, 0, p.thumbCanvas.width, p.thumbCanvas.height);
    p.thumbRot = p.rot; thumbWant.delete(p);
  }
  async function drawThumb(p) {
    thumbWant.delete(p); p.thumbRot = p.rot; sizeThumb(p);
    const vp = p.page.getViewport({ scale: 110 / dims(p)[0], rotation: p.rot });
    await p.page.render({ canvasContext: p.thumbCanvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
  }

  let dragSrc = null;                                  // page being reordered
  function addThumb(p) {
    const w = document.createElement('div'); w._p = p; w.draggable = true;
    w.title = `${p.src.name} · page ${p.idx + 1}`;
    const go = document.createElement('button'); go.type = 'button'; go.className = 'thumb-go'; go.setAttribute('aria-label', 'Go to page ' + p.n);
    const c = document.createElement('canvas'), s = document.createElement('span');
    go.append(c, s);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'thumb-del'; del.textContent = '×';
    del.title = 'Remove this page'; del.setAttribute('aria-label', 'Remove page ' + p.n);
    w.append(go, del);
    Object.assign(p, { thumb: w, thumbCanvas: c, thumbNum: s, thumbGo: go, thumbDel: del, thumbRot: null }); sizeThumb(p);
    go.onclick = () => { p.el.scrollIntoView({ block: 'start' }); };
    del.onclick = e => { e.stopPropagation(); removePage(p); };
    go.addEventListener('keydown', e => {              // keyboard reordering
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault(); const from = p.n - 1, to = from + (e.key === 'ArrowUp' ? -1 : 2);
      if (to < 0 || to > pages.length) return;
      moveTo(from, to);
      const nb = thumbList.children[clamp(e.key === 'ArrowUp' ? from - 1 : from + 1, 0, pages.length - 1)];
      nb && nb.querySelector('.thumb-go').focus();
    });
    w.addEventListener('dragstart', e => {
      dragSrc = p; w.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'page ' + p.n);
    });
    w.addEventListener('dragend', () => { dragSrc = null; w.classList.remove('dragging'); clearInsert(); });
  }

  function dropIndex(y) {
    const ts = [...thumbList.children]; let i = 0;
    for (; i < ts.length; i++) { const r = ts[i].getBoundingClientRect(); if (y < r.top + r.height / 2) break; }
    return i;
  }
  function clearInsert() {
    thumbList.classList.remove('ins-end'); $('thumbs').classList.remove('over');
    thumbList.querySelectorAll('.ins-before').forEach(t => t.classList.remove('ins-before'));
  }
  function showInsert(i) {
    clearInsert(); const ts = thumbList.children;
    if (i < ts.length) ts[i].classList.add('ins-before'); else thumbList.classList.add('ins-end');
  }
  const thumbsEl = $('thumbs');
  thumbsEl.addEventListener('dragover', e => {
    const files = hasFiles(e); if (!files && !dragSrc) return;
    e.preventDefault(); e.dataTransfer.dropEffect = dragSrc ? 'move' : 'copy';
    if (files) thumbsEl.classList.add('over');
    showInsert(dropIndex(e.clientY));
  });
  thumbsEl.addEventListener('dragleave', e => { if (!thumbsEl.contains(e.relatedTarget)) clearInsert(); });
  thumbsEl.addEventListener('drop', e => {
    const files = hasFiles(e); if (!files && !dragSrc) return;
    e.preventDefault(); e.stopPropagation();
    const idx = dropIndex(e.clientY); clearInsert();
    if (dragSrc) { const from = dragSrc.n - 1; dragSrc = null; moveTo(from, idx); }
    else { endFileDrag(); addPdfs(e.dataTransfer.files, idx); }
  });

  /* ---------- text fonts ---------- */
  // Text is saved with Helvetica when it can be (no font file needed). Other text uses an embedded, subset font:
  // Noto Sans (Latin, Greek, Cyrillic, Vietnamese) or Vazirmatn (Persian / Arabic, shaped by fontkit). Anything else
  // (e.g. Chinese, Hebrew, emoji) is drawn as a sharp image of the text, so it still looks the same as on screen.
  const WINANSI = /^[\n\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/;
  const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
  const VAZIR_OK = /^[\n\x20-\x7e\xa0-\xff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u200c-\u200f\u2010-\u2027\u2030-\u203a]*$/;
  const NOTO_OK = /^[\n\x20-\u052f\u1d00-\u1dbf\u1e00-\u1fff\u2000-\u20cf\u2100-\u218f\u2190-\u21ff\u2200-\u22ff\u2c60-\u2c7f\ua720-\ua7ff]*$/;
  const LH = 1.15;                                     // line height (screen and PDF)
  const FACE_CSS = { helv: 'Helvetica, Arial, sans-serif', noto: '"Noto Sans", sans-serif', vazir: 'Vazirmatn, sans-serif', img: 'Helvetica, Arial, sans-serif' };
  const textFace = t => WINANSI.test(t) ? 'helv' : ARABIC.test(t) && VAZIR_OK.test(t) ? 'vazir' : NOTO_OK.test(t) ? 'noto' : 'img';
  const isRtl = t => { const m = t.match(/[A-Za-z\u00c0-\u024f\u0370-\u052f]|[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/); return !!m && !/[A-Za-z\u00c0-\u024f\u0370-\u052f]/.test(m[0]); };
  const baselines = new Map();                         // face|weight -> baseline offset from the line top, in em
  function baselineOf(face, bold) {
    const k = face + bold; if (baselines.has(k)) return baselines.get(k);
    const d = document.createElement('div'), m = document.createElement('span');
    d.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font:${bold ? 700 : 400} 100px/${LH} ${FACE_CSS[face]}`;
    m.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline';
    d.append('Hg', m); document.body.appendChild(d);
    const b = m.offsetTop / 100; d.remove();
    baselines.set(k, b); return b;
  }
  const loadOnce = new Map();
  const once = (k, f) => { if (!loadOnce.has(k)) loadOnce.set(k, f().catch(e => { loadOnce.delete(k); throw e; })); return loadOnce.get(k); };
  const loadScript = src => once(src, () => new Promise((ok, bad) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = bad; document.head.appendChild(sc); }));
  const FONT_FILES = { noto: ['fonts/NotoSans-Regular.ttf', 'fonts/NotoSans-Bold.ttf'], vazir: ['fonts/Vazirmatn-Regular.ttf', 'fonts/Vazirmatn-Bold.ttf'] };
  const fontBytes = (face, bold) => { const u = FONT_FILES[face][bold ? 1 : 0]; return once(u, async () => new Uint8Array(await (await fetch(u)).arrayBuffer())); };
  // screen fonts for faces other than Helvetica are fetched only when such text appears
  const ensureCssFace = (face, bold) => face === 'noto' || face === 'vazir'
    ? once('css' + face + bold, () => document.fonts.load(`${bold ? 700 : 400} 20px ${FACE_CSS[face]}`)).then(() => baselines.delete(face + bold)) : Promise.resolve();

  /* bidi for Persian / Arabic lines (UAX #9, simplified: no explicit marks or mirrored brackets).
     Returns runs in visual order, left to right; each run keeps its logical text so fontkit can shape it. */
  const T_R = /[֐-ٟ٪-ۯۺ-ࣿיִ-﷿ﹰ-﻿]/, T_AN = /[٠-٩۰-۹]/,
    T_EN = /[0-9]/, T_L = /[A-Za-zÀ-ɏͰ-ԯ]/;
  function bidiRuns(line, rtl) {
    const ch = [...line], P = rtl ? 1 : 0;
    const t = ch.map(c => T_R.test(c) ? 'R' : T_AN.test(c) ? 'AN' : T_EN.test(c) ? 'EN' : T_L.test(c) ? 'L' : 'N');
    let strong = rtl ? 'R' : 'L';                      // W2 / W7: European digits take the colour of the last strong letter
    for (let i = 0; i < t.length; i++) {
      if (t[i] === 'R' || t[i] === 'L') strong = t[i];
      else if (t[i] === 'EN') t[i] = strong === 'R' ? 'AN' : 'L';
    }
    const asDir = x => x === 'L' ? 'L' : x === 'N' ? null : 'R';   // numbers count as R next to neutrals (N1)
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== 'N') continue;
      let a = i - 1; while (a >= 0 && t[a] === 'N') a--;
      let b = i + 1; while (b < t.length && t[b] === 'N') b++;
      const prev = a >= 0 ? asDir(t[a]) : (rtl ? 'R' : 'L'), next = b < t.length ? asDir(t[b]) : (rtl ? 'R' : 'L');
      for (let k = i; k < b; k++) t[k] = prev === next ? prev : (rtl ? 'R' : 'L');
      i = b - 1;
    }
    const lv = t.map(x => P === 0 ? (x === 'L' ? 0 : x === 'R' ? 1 : 2) : (x === 'L' || x === 'AN' ? 2 : 1));
    const runs = [];                                   // level runs, logical order
    ch.forEach((c, i) => { const r = runs[runs.length - 1]; if (r && r.lv === lv[i]) r.text += c; else runs.push({ lv: lv[i], text: c }); });
    const top = Math.max(0, ...lv), lowOdd = Math.min(...lv.filter(x => x % 2), 99);
    for (let L = top; L >= lowOdd && L > 0; L--) {     // L2: reverse every stretch at level L or above
      for (let i = 0; i < runs.length; ) {
        if (runs[i].lv < L) { i++; continue; }
        let j = i; while (j < runs.length && runs[j].lv >= L) j++;
        runs.splice(i, j - i, ...runs.slice(i, j).reverse()); i = j;
      }
    }
    return runs.map(r => ({ rtl: r.lv % 2 === 1, text: r.text }));
  }

  /* ---------- items ---------- */
  function redraw(n) {
    const p = pages[n - 1]; if (!p) return;
    p.layer.textContent = '';
    items.filter(i => i.page === n).forEach(it => addEl(p, it));
  }
  function redrawAll() {
    const by = new Map(); items.forEach(it => { if (!by.has(it.page)) by.set(it.page, []); by.get(it.page).push(it); });
    pages.forEach(p => { p.layer.textContent = ''; (by.get(p.n) || []).forEach(it => addEl(p, it)); });
  }
  function addEl(p, it) {
    const el = document.createElement('div');
    el.className = 'item ' + (it.type === 'text' ? 'text' : it.type === 'sign' ? 'sign' : it.type === 'redact' ? 'redact' : 'mark') + (it.bold ? ' bold' : '') + (it.id === selected ? ' sel' : '');
    el.dataset.id = it.id;
    if (it.type === 'text') {
      el.style.fontSize = it.size * U + 'px'; el.style.color = CSS_COLOR[it.color] || '#000';
      el.textContent = it.text; styleText(el, it.text, it.bold);
    } else if (it.type === 'sign') {
      el.appendChild(sigEl(it, U));
    } else if (it.type === 'redact') {
      el.style.width = it.w * U + 'px'; el.style.height = it.h * U + 'px'; el.title = 'Redaction';
      const h = document.createElement('span'); h.className = 'rh'; el.appendChild(h);
    } else {
      el.appendChild(markSVG(it.type, markBox(it) * U, it.color));
    }
    const [ox, oy] = originOf(it); el.style.left = ox + 'px'; el.style.top = oy + 'px';
    if (it.ang && it.type !== 'redact') { el.style.transform = `rotate(${-it.ang}deg)`; el.style.transformOrigin = it.type === 'text' ? '0 0' : '50% 50%'; }
    p.layer.appendChild(el); return el;
  }
  function styleText(el, text, bold) {                // font and direction follow the text, as in the saved PDF
    const face = textFace(text);
    el.style.fontFamily = face === 'helv' ? '' : FACE_CSS[face];
    el.dir = isRtl(text) ? 'rtl' : 'ltr';
    ensureCssFace(face, bold);
  }
  function select(id) {
    selected = id; $('del').disabled = id == null;
    document.querySelectorAll('.item').forEach(e => e.classList.toggle('sel', +e.dataset.id === id));
    const it = items.find(i => i.id === id); if (it) syncControlsTo(it);
  }
  const itemById = id => items.find(i => i.id === id);

  function editText(it, el, isNew) {
    el.contentEditable = 'true'; el.focus();
    const r = document.createRange(); r.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const before = it.text;
    el.addEventListener('blur', () => {
      el.contentEditable = 'false';
      const t = el.innerText.replace(/\n+$/, '');
      if (!t.trim()) {
        items = items.filter(i => i.id !== it.id); if (selected === it.id) select(null);
        if (isNew) history.pop();           // nothing was really added
        else if (before) pushHistory();
      } else if (t !== before) { if (!isNew) pushHistory(); it.text = t; dirty = true; }
      $('undo').disabled = !history.length;
      redraw(it.page);
    }, { once: true });
    el.addEventListener('keydown', e => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault(); it.bold = !it.bold; setBold(it.bold); el.classList.toggle('bold', it.bold); dirty = true; return;
      }
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); el.blur(); }
    });
    el.addEventListener('input', () => styleText(el, el.innerText, it.bold));
    el.addEventListener('paste', e => {          // paste as plain text
      e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').slice(0, 500));
    });
  }

  pagesEl.addEventListener('pointerdown', e => {
    if (tool === 'select' && !e.target.closest('.item') && selected != null) select(null);
  });

  /* ---------- pointer handling (one handler per page layer) ---------- */
  // Over a form field, the item layer lets the pointer through so the field gets clicks, text selection and the
  // right cursor. Our items stay clickable (they keep pointer-events). It switches back once the pointer leaves.
  const FIELD_TOOLS = new Set(['text', 'check', 'cross', 'sign']);
  let passL = null;
  function passThrough(L) {
    if (passL === L) return;
    if (passL) passL.classList.remove('pass');
    passL = L; L.classList.add('pass');
    addEventListener('pointermove', unpass, { passive: true });
  }
  function unpass(e) {
    if (e.target.closest && e.target.closest('.annotationLayer section')) return;
    if (passL) passL.classList.remove('pass');
    passL = null; removeEventListener('pointermove', unpass);
  }
  function attachLayer(p) {
    const L = p.layer;
    L.addEventListener('pointermove', e => {
      if (p.ann && FIELD_TOOLS.has(tool) && e.target === L && fieldAt(e.clientX, e.clientY)) { passThrough(L); p.ghost.style.display = 'none'; return; }
      const ghostTool = tool === 'check' || tool === 'cross' || (tool === 'sign' && sig);
      if (e.pointerType !== 'mouse' || !ghostTool || e.target.closest('.item')) { p.ghost.style.display = 'none'; return; }
      const key = [tool, scale, size, signSize, color, sig && sig.text, sig && sig.font].join('|');
      if (p.ghost.dataset.key !== key) {               // rebuild the preview only when it changes
        p.ghost.textContent = ''; p.ghost.dataset.key = key;
        if (tool === 'sign') {
          const it = { text: sig.text, font: sig.font, size: signSize, color }, c = sigImage(it);
          p.ghost.appendChild(sigEl(it, scale)); p.ghostW = c.w * scale; p.ghostH = c.h * scale;
        } else { p.ghostW = p.ghostH = size * 1.15 * scale; p.ghost.appendChild(markSVG(tool, p.ghostW, color)); }
      }
      const r = p.el.getBoundingClientRect();
      p.ghost.style.transform = `translate(${e.clientX - r.left - p.ghostW / 2}px,${e.clientY - r.top - p.ghostH / 2}px)`;
      p.ghost.style.display = 'block';
    });
    L.addEventListener('pointerleave', () => { p.ghost.style.display = 'none'; });

    L.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const ae = document.activeElement;
      if (ae && ae.isContentEditable && !ae.contains(e.target)) ae.blur();   // commit pending text first
      const target = e.target.closest('.item');
      if (target && target.isContentEditable) return;
      if (target) { if (e.target.classList.contains('rh')) startResize(e, p, target); else startDrag(e, p, target); return; }
      if (tool === 'select') { select(null); return; }
      const field = p.ann && FIELD_TOOLS.has(tool) && fieldAt(e.clientX, e.clientY);
      if (field) {                                     // touch, or the hover hand-over did not happen: use the form field
        e.preventDefault();
        if (field.type === 'checkbox' || field.type === 'radio') field.click();
        else { field.focus(); if (field.tagName === 'SELECT') try { field.showPicker(); } catch { /* ignore */ } }
        return;
      }
      if (tool === 'redact') { startRedactBox(e, p); return; }
      if (tool === 'sign' && !sig) { openSignDialog(); return; }
      const [x, y] = toBase(p, e.clientX, e.clientY);
      pushHistory();
      const it = { id: nextId++, page: p.n, type: tool, x, y, size, color, bold: tool === 'text' && bold, text: '', ang: p.rot };
      if (tool === 'sign') { it.text = sig.text; it.font = sig.font; it.size = signSize; it.bold = false; }
      items.push(it); selected = it.id;
      p.ghost.style.display = 'none';
      if (tool === 'text') {
        // (x, y) is the top-left of the text; centre the first line on the click point
        const [dx, dy] = rotVec(0, size * LH / 2, it.ang); it.x = x - dx; it.y = y - dy;
        redraw(p.n); const el = L.querySelector(`[data-id="${it.id}"]`); el.textContent = '';
        editText(it, el, true); e.preventDefault();
      } else { redraw(p.n); select(it.id); }
    });

    L.addEventListener('dblclick', e => {
      const t = e.target.closest('.item.text'); if (!t) return;
      const it = itemById(+t.dataset.id); select(it.id); editText(it, t, false);
    });
  }

  function startDrag(e, p, target) {
    const it = itemById(+target.dataset.id);
    select(it.id);
    const [sx, sy] = toBase(p, e.clientX, e.clientY), cx = e.clientX, cy = e.clientY, ox = it.x, oy = it.y; let moved = false;
    const place = () => { const [lx, ly] = originOf(it); target.style.left = lx + 'px'; target.style.top = ly + 'px'; };
    const move = ev => {
      const [bx, by] = toBase(p, ev.clientX, ev.clientY), dx = bx - sx, dy = by - sy;
      if (!moved && Math.hypot(ev.clientX - cx, ev.clientY - cy) < 3) return;
      if (!moved) { pushHistory(); moved = true; }
      it.x = clamp(ox + dx, 0, p.w); it.y = clamp(oy + dy, 0, p.h); place();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    e.preventDefault();
  }

  /* ---------- redaction boxes ---------- */
  function startRedactBox(e, p) {
    const [sx, sy] = toBase(p, e.clientX, e.clientY);
    const band = document.createElement('div'); band.className = 'rband'; p.layer.appendChild(band);
    let box = null;
    const move = ev => {
      const [bx, by] = toBase(p, ev.clientX, ev.clientY), x = clamp(bx, 0, p.w), y = clamp(by, 0, p.h);
      box = { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
      Object.assign(band.style, { left: box.x * U + 'px', top: box.y * U + 'px', width: box.w * U + 'px', height: box.h * U + 'px' });
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      band.remove();
      if (!box || box.w * scale < 4 || box.h * scale < 4) { hint('Drag across the text you want to hide.'); return; }
      pushHistory();
      const it = { id: nextId++, page: p.n, type: 'redact', ...box, size: 0, color: 'black', text: '' };
      items.push(it); redraw(p.n); select(it.id);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    e.preventDefault();
  }
  function startResize(e, p, target) {
    const it = itemById(+target.dataset.id); select(it.id);
    const [sx, sy] = toBase(p, e.clientX, e.clientY), ow = it.w, oh = it.h; let moved = false;
    const move = ev => {
      if (!moved) { pushHistory(); moved = true; }
      const [bx, by] = toBase(p, ev.clientX, ev.clientY);
      it.w = clamp(ow + bx - sx, 2, p.w - it.x); it.h = clamp(oh + by - sy, 2, p.h - it.y);
      target.style.width = it.w * U + 'px'; target.style.height = it.h * U + 'px';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    e.preventDefault(); e.stopPropagation();
  }

  /* ---------- find & redact ---------- */
  const SKIP = /[\s\-\u2010-\u2015.]/;                     // ignored when matching, so 123-456-789 = 123 456 789
  const measureCtx = document.createElement('canvas').getContext('2d');
  function pageText(p) {
    if (!p.textInfo) p.textInfo = p.page.getTextContent().then(tc => tc.items.filter(i => i.str !== undefined));
    return p.textInfo;
  }
  async function findMatches(query) {               // -> [{page, x, y, w, h}] in page units (top-left origin)
    const q = [...query.toLowerCase()].filter(ch => !SKIP.test(ch)).join('');
    if (q.length < 2) return [];
    const out = [];
    for (const p of pages) {
      const its = await pageText(p), vp = p.page.getViewport({ scale: 1, rotation: 0 });
      let norm = ''; const map = [];                // map[k] = [item index, char index] for each normalised char
      its.forEach((it, ii) => [...it.str].forEach((ch, ci) => {
        if (SKIP.test(ch)) return;
        const low = ch.toLowerCase(); for (const c of low) { norm += c; map.push([ii, ci]); }
      }));
      for (let at = norm.indexOf(q); at >= 0; at = norm.indexOf(q, at + q.length)) {
        const spans = new Map();                    // item -> [first char, last char]
        for (let k = at; k < at + q.length; k++) {
          const [ii, ci] = map[k], s = spans.get(ii);
          spans.set(ii, s ? [Math.min(s[0], ci), Math.max(s[1], ci)] : [ci, ci]);
        }
        spans.forEach(([a, b], ii) => { const r = charBox(its[ii], a, b, vp); if (r) out.push({ page: p.n, ...r }); });
      }
    }
    return out;
  }
  function charBox(it, a, b, vp) {                  // box around characters a..b of a text item, padded
    const t = it.transform, chars = [...it.str], fh = Math.hypot(t[2], t[3]) || it.height || 10;
    let x0, x1, y0, y1;
    if (Math.abs(t[1]) < 1e-3 && Math.abs(t[2]) < 1e-3) {
      measureCtx.font = '100px Helvetica, Arial, sans-serif';
      const full = measureCtx.measureText(it.str).width || 1;
      const f0 = measureCtx.measureText(chars.slice(0, a).join('')).width / full;
      const f1 = measureCtx.measureText(chars.slice(0, b + 1).join('')).width / full;
      const pad = fh * 0.08;
      x0 = t[4] + it.width * f0 - pad; x1 = t[4] + it.width * f1 + pad;
      y0 = t[5] - fh * 0.3; y1 = t[5] + fh * 1.0;
    } else { x0 = t[4]; x1 = t[4] + it.width + fh * 0.2; y0 = t[5] - fh * 0.3; y1 = t[5] + fh * 1.0; }   // rotated text: whole run
    const [ax, ay] = vp.convertToViewportPoint(x0, y0), [bx, by] = vp.convertToViewportPoint(x1, y1);
    const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  let findTimer, findResults = [], findSeq = 0;
  function openFind() {
    if (!hasDoc()) { toast('Open a PDF first.', true); return; }
    $('moreMenu').open = false; $('findMsg').textContent = 'Type the text to find, e.g. your SIN.'; $('findGo').disabled = true;
    $('findDialog').showModal(); $('findInput').focus(); $('findInput').select();
    if ($('findInput').value) runFind();
  }
  async function runFind() {
    const seq = ++findSeq, q = $('findInput').value;
    findResults = await findMatches(q);
    if (seq !== findSeq) return;
    const pagesHit = new Set(findResults.map(r => r.page)).size;
    $('findGo').disabled = !findResults.length;
    $('findMsg').textContent = q.trim().length < 2 ? 'Type the text to find, e.g. your SIN.'
      : findResults.length ? `Found on ${pagesHit} page${pagesHit === 1 ? '' : 's'} (${findResults.length} box${findResults.length === 1 ? '' : 'es'}).`
        : 'Not found. Scanned pages (pictures of text) cannot be searched; draw a box instead.';
  }
  function applyFind() {
    if (!findResults.length) return;
    pushHistory();
    const touched = new Set();
    findResults.forEach(r => { items.push({ id: nextId++, type: 'redact', size: 0, color: 'black', text: '', ...r }); touched.add(r.page); });
    touched.forEach(redraw); $('findDialog').close();
    if (tool !== 'redact') activateTool('redact');
    const first = Math.min(...touched); pages[first - 1].el.scrollIntoView({ block: 'start' });
    toast(`Added ${findResults.length} redaction${findResults.length === 1 ? '' : 's'}. Check them, then Save PDF.`);
  }
  $('findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 200); });
  $('findInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); runFind().then(applyFind); } });
  $('findGo').onclick = applyFind;
  $('findCancel').onclick = () => $('findDialog').close();
  $('findBtn').onclick = openFind;

  /* ---------- delete / undo / nudge ---------- */
  function deleteSel() {
    if (selected == null) return;
    const it = itemById(selected); pushHistory(); items = items.filter(i => i.id !== selected); select(null); redraw(it.page);
  }
  function undo() {
    if (!history.length) return;
    const touched = new Set([...items.map(i => i.page)]);
    items = JSON.parse(history.pop()); items.forEach(i => touched.add(i.page));
    selected = null; $('del').disabled = true; $('undo').disabled = !history.length;
    touched.forEach(redraw);
  }
  function nudge(dx, dy) {
    const it = itemById(selected); if (!it) return;
    pushHistory(); it.x += dx; it.y += dy; redraw(it.page);
  }

  /* ---------- page rotation ---------- */
  function rotatePage(d) {
    const p = pages[curPage - 1]; if (!p) return;
    p.rot = (p.rot + d + 360) % 360; dirty = true;
    computeScale(); layout();                          // the picture, thumbnail, text and form layers follow
    p.el.scrollIntoView({ block: 'nearest' });
    hint(`Page ${p.n} rotated. Items on it turn with the page. Save PDF to keep the change.`);
  }
  $('rotL').onclick = () => rotatePage(-90); $('rotR').onclick = () => rotatePage(90);

  /* ---------- zoom ---------- */
  function stepZoom(dir) {
    fit = false;
    const next = dir > 0 ? ZOOMS.find(z => z > scale + 0.01) : [...ZOOMS].reverse().find(z => z < scale - 0.01);
    if (!next) return;
    const ratio = next / scale, st = stage.scrollTop, sl = stage.scrollLeft;
    scale = next; layout(); stage.scrollTop = st * ratio; stage.scrollLeft = sl * ratio;
  }

  /* ---------- progress files ---------- */
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  const baseName = () => fileName.replace(/\.pdf$/i, '');
  function cleanItems(arr) {
    if (!Array.isArray(arr)) throw new Error('bad');
    const out = [];
    for (const i of arr.slice(0, 5000)) {
      if (!i || !['text', 'check', 'cross', 'sign', 'redact'].includes(i.type)) continue;
      const page = Math.floor(+i.page);
      if (!(page >= 1 && page <= pages.length)) continue;
      if (i.type === 'redact') {
        const x = +i.x, y = +i.y, w = +i.w, h = +i.h;
        if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) out.push({ id: out.length + 1, page, type: 'redact', x, y, w, h, size: 0, color: 'black', text: '' });
        continue;
      }
      const x = +i.x, y = +i.y, sz = +i.size;
      if (![x, y, sz].every(Number.isFinite)) continue;
      if (i.type === 'sign' && !String(i.text ?? '').trim()) continue;
      const isSign = i.type === 'sign', ang = [0, 90, 180, 270].includes(+i.ang) ? +i.ang : 0;
      out.push({ id: out.length + 1, page, type: i.type, x, y, size: isSign ? clamp(sz, SIG_MIN, SIG_MAX) : clamp(sz, MIN_SIZE, MAX_SIZE),
        color: COLORS[i.color] ? i.color : 'black', bold: i.type === 'text' && i.bold === true,
        text: i.type === 'text' ? String(i.text ?? '').slice(0, 500) : isSign ? String(i.text).slice(0, 40) : '',
        ang, ...(isSign ? { font: SIG_FONTS.includes(i.font) ? i.font : SIG_FONTS[0] } : {}) });   // old styles -> default
    }
    return out;
  }

  /* ---------- export ---------- */
  async function savePdf() {
    if (!hasDoc()) return;
    const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = PDFLib;
    const btn = $('save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      // Redactions need the rebuild path: it only copies objects the (rewritten) pages still use,
      // so the original text, document metadata, bookmarks and form data are not carried over.
      const redRects = new Map();                     // page model -> [[x0,y0,x1,y1] in PDF user space]
      for (const it of items) {
        if (it.type !== 'redact') continue;
        const p = pages[it.page - 1]; if (!p) continue;
        const vp = p.page.getViewport({ scale: 1, rotation: 0 });
        const [ax, ay] = vp.convertToPdfPoint(it.x, it.y), [bx, by] = vp.convertToPdfPoint(it.x + it.w, it.y + it.h);
        if (!redRects.has(p)) redRects.set(p, []);
        redRects.get(p).push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]);
      }
      const redacting = redRects.size > 0, red = { glyphs: 0, images: 0, annots: 0 };
      const merged = redacting || !(sources.length === 1 && pages.length === sources[0].doc.numPages && pages.every((p, i) => p.idx === i));
      const load = async s => {
        // form field values: pdf.js writes them (with their appearance) into a copy of the file
        const bytes = s.doc.annotationStorage.size ? await s.doc.saveDocument() : s.bytes;
        // encrypted (the trailer, at the end, names /Encrypt): decrypt while parsing; the saved copy has no encryption
        const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
        let d = null;
        if (!tail.includes('/Encrypt')) {
          try { d = await PDFDocument.load(bytes, { ignoreEncryption: true, parseSpeed: PDFLib.ParseSpeeds.Fastest }); } catch (e) { console.warn(e); }
        }
        if (!d || d.isEncrypted) d = await PdfDecrypt.load(bytes, s.password);
        for (const p of pages) {                       // redact every page of this source before copying any of them
          if (p.src !== s || !redRects.has(p)) continue;
          let r;
          try { r = Redactor.redactPage(d, d.getPage(p.idx), redRects.get(p)); } catch (e) { console.error(e); throw new Error('REDACT:' + p.n); }
          red.glyphs += r.glyphs; red.images += r.images; red.annots += r.annots;
        }
        return d;
      };
      let doc;
      if (!merged) doc = await load(sources[0]);
      else {                                           // build a new document from the selected pages, in order
        doc = await PDFDocument.create(); const cache = new Map();
        for (const p of pages) {
          let sd = cache.get(p.src); if (!sd) { sd = await load(p.src); cache.set(p.src, sd); }
          const [cp] = await doc.copyPages(sd, [p.idx]); doc.addPage(cp);
        }
      }
      const pgs = doc.getPages();
      pages.forEach((p, i) => pgs[i].setRotation(degrees(p.rot)));
      if (items.some(i => i.type === 'sign')) await loadFonts();
      const sigImgs = new Map(), fonts = new Map();
      const pdfFont = (face, b) => {                   // embedded once per document, on first use
        const k = face + b;
        if (!fonts.has(k)) fonts.set(k, face === 'helv' ? doc.embedFont(b ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)
          : (async () => { await loadScript('lib/fontkit.umd.min.js'); doc.registerFontkit(window.fontkit); return doc.embedFont(await fontBytes(face, b), { subset: true }); })());
        return fonts.get(k);
      };
      for (const it of items) {
        const pg = pgs[it.page - 1], p = pages[it.page - 1]; if (!pg || !p || it.type === 'redact') continue;
        const col = rgb(...(COLORS[it.color] || COLORS.black)), a = it.ang || 0, vp0 = p.page.getViewport({ scale: 1, rotation: 0 });
        const at = (lx, ly) => { const [vx, vy] = rotVec(lx, ly, a); return vp0.convertToPdfPoint(it.x + vx, it.y + vy); };  // item frame -> PDF
        if (it.type === 'sign') {
          const c = sigImage(it);
          if (!sigImgs.has(c.url)) sigImgs.set(c.url, await doc.embedPng(c.url));
          const [x, y] = at(-c.w / 2, c.h / 2);           // bottom-left corner of the image
          pg.drawImage(sigImgs.get(c.url), { x, y, width: c.w, height: c.h, rotate: degrees(a) });
        } else if (it.type === 'text') {
          await drawTextItem(doc, pg, it, at, col, pdfFont);
        } else {
          const b = markBox(it), k = b / 10;
          const P = (px, py) => { const [x, y] = at(px * k - b / 2, py * k - b / 2); return { x, y }; };
          const seg = (a, c) => pg.drawLine({ start: P(...a), end: P(...c), thickness: 1.25 * k, color: col, lineCap: LineCapStyle.Round });
          if (it.type === 'check') { seg([1.2, 5.4], [4, 8.2]); seg([4, 8.2], [8.8, 1.6]); }
          else { seg([1.5, 1.5], [8.5, 8.5]); seg([8.5, 1.5], [1.5, 8.5]); }
        }
      }
      redRects.forEach((rs, p) => {                    // black boxes last, so they also cover anything drawn above
        const pg = pgs[p.n - 1];
        rs.forEach(r => pg.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: rgb(0, 0, 0) }));
      });
      const out = await doc.save({ objectsPerTick: Infinity });
      download(new Blob([out], { type: 'application/pdf' }), baseName() + (redacting ? '-redacted' : merged ? '-combined' : '-filled') + '.pdf');
      dirty = false;
      if (red.images) toast('Saved, but a redaction box covers an image (for example a scanned page). The box hides it, but the picture underneath was not changed. Do not rely on it for scans.', true);
      else if (redacting) toast(`Saved. Removed ${red.glyphs} character${red.glyphs === 1 ? '' : 's'}${red.annots ? ` and ${red.annots} form field${red.annots === 1 ? '' : 's'}/note${red.annots === 1 ? '' : 's'}` : ''} under the black boxes.`);
      else toast('Saved to your Downloads folder. The original file was not changed.');
    } catch (e) {
      console.error(e);
      const m = e && e.message || '';
      toast(m === 'ENCRYPTED'
        ? 'One of these PDFs uses an encryption type that is not supported here. Print it to a new PDF first (Print → Save as PDF), then open that copy.'
        : m === 'PASSWORD' ? 'Could not unlock one of these encrypted PDFs, so nothing was saved.'
        : m.startsWith('REDACT:') ? `Could not safely redact page ${m.slice(7)}, so nothing was saved.`
          : 'Could not save this PDF.', true);
    } finally { btn.disabled = false; btn.textContent = 'Save PDF'; }
  }

  // One text item into the PDF, matching the screen: same font, line boxes (LH), baseline, direction and alignment.
  async function drawTextItem(doc, pg, it, at, col, pdfFont) {
    const { degrees } = PDFLib, rot = degrees(it.ang || 0), lines = it.text.split('\n'), rtl = isRtl(it.text);
    let face = textFace(it.text), font = null;
    if (face !== 'img') {
      try {
        font = await pdfFont(face, !!it.bold);
        const fk = face !== 'helv' && font.embedder && font.embedder.font;
        if (fk && [...it.text].some(c => c !== '\n' && !fk.hasGlyphForCodePoint(c.codePointAt(0)))) face = 'img';
      } catch (e) { console.warn(e); face = 'img'; }
    }
    if (face === 'img') {                              // any script: a sharp picture of the text
      const K = 4, S = it.size * K, P = Math.ceil(S * 0.5), cv = document.createElement('canvas'), ctx = cv.getContext('2d');
      const css = `${it.bold ? 700 : 400} ${S}px ${FACE_CSS.img}`; ctx.font = css;
      const W = Math.ceil(Math.max(1, ...lines.map(l => ctx.measureText(l).width))), H = Math.ceil(lines.length * LH * S);
      cv.width = W + 2 * P; cv.height = H + 2 * P;
      ctx.font = css; ctx.fillStyle = CSS_COLOR[it.color] || '#000'; ctx.direction = rtl ? 'rtl' : 'ltr'; ctx.textAlign = rtl ? 'right' : 'left';
      const m = ctx.measureText('Hg'), fa = m.fontBoundingBoxAscent, fd = m.fontBoundingBoxDescent;
      lines.forEach((l, n) => ctx.fillText(l, rtl ? P + W : P, P + n * LH * S + (LH * S - fa - fd) / 2 + fa));
      const img = await doc.embedPng(cv.toDataURL('image/png')), w = cv.width / K, h = cv.height / K;
      const [x, y] = at(-P / K, h - P / K);
      pg.drawImage(img, { x, y, width: w, height: h, rotate: rot });
      return;
    }
    if (face !== 'helv') await ensureCssFace(face, !!it.bold);
    const B = baselineOf(face, !!it.bold), size = it.size;
    const runsOf = line => face !== 'vazir' ? [{ text: line }]
      : bidiRuns(line, rtl).flatMap(r => !r.rtl && ARABIC.test(r.text) ? [...r.text].map(c => ({ text: c })) : [r]);   // e.g. Persian digits, left to right
    const widthOf = runs => runs.reduce((w, r) => w + font.widthOfTextAtSize(r.text, size), 0);
    const laid = lines.map(l => { const runs = runsOf(l); return { runs, w: widthOf(runs) }; });
    const maxW = Math.max(0, ...laid.map(l => l.w));
    laid.forEach(({ runs, w }, n) => {
      let x = rtl ? maxW - w : 0;
      for (const r of runs) {
        const [px, py] = at(x, size * (B + n * LH));
        if (r.text.trim()) pg.drawText(r.text, { x: px, y: py, size, font, color: col, rotate: rot });
        x += font.widthOfTextAtSize(r.text, size);
      }
    });
  }

  /* ---------- signature dialog ---------- */
  let sigFont = SIG_FONTS[0], sigBuilt = false;
  function paintSigPreviews() {
    const txt = $('sigName').value.trim() || 'Your name';
    document.querySelectorAll('.sigopt').forEach(b => {
      b.querySelector('.sigtxt').textContent = txt;
      const on = b.dataset.font === sigFont; b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
    });
  }
  function buildSigOptions() {
    if (sigBuilt) return; sigBuilt = true;
    SIG_FONTS.forEach(f => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sigopt'; b.dataset.font = f;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-label', 'Style ' + f);
      const t = document.createElement('span'); t.className = 'sigtxt'; t.style.fontFamily = `"${f}", cursive`;
      const s = document.createElement('small'); s.textContent = f;
      b.append(t, s); b.onclick = () => { sigFont = f; paintSigPreviews(); }; $('sigOpts').appendChild(b);
    });
  }
  async function openSignDialog() {
    if (!hasDoc()) { toast('Open a PDF first.', true); return; }
    await loadFonts(); buildSigOptions();
    $('sigName').value = sig ? sig.text : lastName; if (sig) sigFont = sig.font;
    paintSigPreviews(); $('signDialog').showModal(); $('sigName').focus(); $('sigName').select();
  }
  function useSignature() {
    const t = $('sigName').value.trim().slice(0, 40);
    if (!t) { toast('Type your name first.', true); $('sigName').focus(); return; }
    sig = { text: t, font: sigFont }; lastName = t;
    $('signDialog').close(); activateTool('sign');
  }
  $('sigName').addEventListener('input', paintSigPreviews);
  $('sigName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); useSignature(); } });
  $('sigUse').onclick = useSignature;
  $('sigCancel').onclick = () => $('signDialog').close();

  /* ---------- wiring ---------- */
  const pick = () => $('file').click();
  $('openBtn').onclick = pick; $('openBtn2').onclick = pick;
  $('file').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length > 1) addPdfs(fs); else openPdf(fs[0]); };
  const pickAdd = () => { $('moreMenu').open = false; $('addFile').click(); };
  $('addBtn').onclick = pickAdd; $('addBtn2').onclick = pickAdd;
  $('addFile').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addPdfs(fs); };
  document.querySelectorAll('#tools button').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });
  document.querySelectorAll('.sw').forEach(b => { b.onclick = () => { setColor(b.dataset.color); if (selected != null) changeSelected({ color: b.dataset.color }); }; });
  $('sizeUp').onclick = () => adjustSize(1);
  $('sizeDown').onclick = () => adjustSize(-1);
  $('boldBtn').onclick = () => {
    setBold(!bold);
    const it = itemById(selected); if (it && it.type === 'text') changeSelected({ bold });
  };
  $('del').onclick = deleteSel; $('undo').onclick = undo;
  $('zoomIn').onclick = () => stepZoom(1); $('zoomOut').onclick = () => stepZoom(-1);
  $('zoomFit').onclick = () => { fit = true; computeScale(); layout(); };
  $('save').onclick = savePdf;
  $('shortcutsBtn').onclick = () => { $('moreMenu').open = false; $('shortcuts').showModal(); };

  $('saveWork').onclick = () => {
    $('moreMenu').open = false;
    const fields = sources.map(s => s.doc.annotationStorage.getAll() || {});   // form field values, per source file
    download(new Blob([JSON.stringify({ app: 'fill-pdf', v: 1, file: fileName, pages: pages.length, rotations: pages.map(p => p.rot), items, fields }, null, 1)], { type: 'application/json' }), baseName() + '.progress.json');
    toast('Progress saved. Load it later with the same PDF.');
  };
  function restoreFields(all) {
    const ok = v => typeof v === 'string' ? v.length <= 10000 : typeof v === 'boolean' || typeof v === 'number' || (Array.isArray(v) && v.length <= 500 && v.every(x => typeof x === 'string'));
    sources.forEach((s, i) => {
      const vals = all[i]; if (!vals || typeof vals !== 'object') return;
      for (const [id, v] of Object.entries(vals).slice(0, 5000)) {
        if (!/^\d+R$/.test(id) || !v || typeof v !== 'object') continue;
        const clean = {}; for (const k of ['value', 'formattedValue']) if (k in v && ok(v[k])) clean[k] = v[k];
        if ('value' in clean) s.doc.annotationStorage.setValue(id, clean);
      }
    });
    pages.forEach(p => { if (p.ann) { p.annEl.textContent = ''; p.ann = null; p.annRot = null; } });
    pump();
  }
  $('loadWorkBtn').onclick = () => { $('moreMenu').open = false; $('loadWork').click(); };
  $('loadWork').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !hasDoc()) return;
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error('big');
      const d = JSON.parse(await f.text());
      const loaded = cleanItems(d.items); await loadFonts();
      pushHistory(); items = loaded; nextId = items.length + 1; select(null);
      if (Array.isArray(d.rotations) && d.rotations.length === pages.length) {
        d.rotations.forEach((r, i) => { if ([0, 90, 180, 270].includes(r)) pages[i].rot = r; });
        computeScale(); layout();
      }
      if (Array.isArray(d.fields) && d.fields.length === sources.length) restoreFields(d.fields);
      redrawAll();
      toast(`Loaded ${items.length} item${items.length === 1 ? '' : 's'}.`);
      if ((d.file && d.file !== fileName) || (d.pages && d.pages !== pages.length)) toast('Loaded. Note: this progress file was saved for a different PDF or page order.', true);
    } catch { toast('That is not a valid progress file.', true); }
  };
  document.addEventListener('click', e => { const m = $('moreMenu'); if (m.open && !m.contains(e.target)) m.open = false; });

  addEventListener('keydown', e => {
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    if ($('shortcuts').open || $('signDialog').open || $('dropDialog').open || $('findDialog').open) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); undo(); return; }
    if (mod && k === 's') { e.preventDefault(); savePdf(); return; }
    if (mod && k === 'b' && hasDoc()) { e.preventDefault(); $('boldBtn').click(); return; }
    if (mod || e.altKey || !hasDoc()) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (selected != null) { e.preventDefault(); deleteSel(); } return; }
    if (e.key === 'Escape') { select(null); return; }
    if (e.key === '[' || e.key === ']') { e.preventDefault(); rotatePage(e.key === ']' ? 90 : -90); return; }
    if (selected != null && e.key.startsWith('Arrow')) {
      const st = e.shiftKey ? 5 : 1;
      const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (d) { e.preventDefault(); nudge(...d); } return;
    }
    if (k === 'f') { e.preventDefault(); openFind(); return; }
    const t = { t: 'text', c: 'check', x: 'cross', s: 'sign', v: 'select', r: 'redact' }[k]; if (t) setTool(t);
  });

  // drag & drop PDF files
  let dragDepth = 0, pendingDrop = [];
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  function endFileDrag() { dragDepth = 0; $('dropVeil').hidden = true; $('dropCard').classList.remove('over'); }
  addEventListener('dragenter', e => {
    if (!hasFiles(e)) return; e.preventDefault(); dragDepth++;
    $('dropVeil').textContent = hasDoc() ? 'Drop on the page list to insert pages here, or drop anywhere to choose' : 'Drop the PDF to open it';
    $('dropVeil').hidden = false; $('dropCard').classList.add('over');
  });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) endFileDrag(); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return; e.preventDefault(); endFileDrag();
    const files = [...e.dataTransfer.files].filter(isPdf);
    if (!files.length) { toast('Please drop PDF files.', true); return; }
    if (!hasDoc()) { addPdfs(files); return; }                      // nothing open yet: open (and combine if several)
    pendingDrop = files;
    $('dropMsg').textContent = files.length === 1 ? `“${files[0].name}”` : `${files.length} PDF files`;
    $('dropDialog').showModal();
  });
  $('dropAdd').onclick = () => { $('dropDialog').close(); addPdfs(pendingDrop); };
  $('dropReplace').onclick = async () => { $('dropDialog').close(); const [f, ...rest] = pendingDrop; await openPdf(f); if (rest.length && hasDoc()) addPdfs(rest); };
  $('dropCancel').onclick = () => $('dropDialog').close();
  addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  setSize(10); setTool('text'); hint('Open a PDF to begin.');
})();
