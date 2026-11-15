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
  const SIG_FONTS = ['Great Vibes', 'Allura', 'Dancing Script', 'Sacramento', 'Mrs Saint Delafield', 'Homemade Apple'];
  const SIG_MIN = 8, SIG_MAX = 100, SIG_K = 4;       // SIG_K = render scale for crisp signatures

  /* ---------- state ---------- */
  let sources = [], nextSrc = 1, fileName = 'form.pdf';   // sources: {id, name, bytes, doc}
  let pages = [];                 // {n, el, canvas, layer, ghost, w, h, rot, page, src, idx, task, rendered}
  let items = [];                 // {id, page, type, x, y, size, color, text}
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
  function originOf(it) {
    if (it.type === 'text') return [it.x * scale, it.y * scale];
    if (it.type === 'sign') { const c = sigImage(it); return [(it.x - c.w / 2) * scale, (it.y - c.h / 2) * scale]; }
    const b = markBox(it) * scale; return [it.x * scale - b / 2, it.y * scale - b / 2];
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
    select: 'Select text to copy it (Ctrl+C), or drag items to move them. Double-click your text to edit.'
  };
  function setTool(t) {                        // user-facing: the Sign tool opens the dialog first
    if (t === 'sign' && (!sig || tool === 'sign')) { openSignDialog(); return; }
    activateTool(t);
  }
  function activateTool(t) {
    tool = t; showSize(); document.body.classList.toggle('mode-select', t === 'select');
    document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    pages.forEach(p => { p.layer.className = 'layer tool-' + t + (p.rot ? ' locked' : ''); p.ghost.style.display = 'none'; });
    hint(HINTS[t]);
  }
  function setColor(c) {
    color = c;
    document.querySelectorAll('.sw').forEach(b => { const on = b.dataset.color === c; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  }
  const showSize = () => { $('sizeOut').textContent = tool === 'sign' ? signSize : size; };
  function setSize(s) { size = clamp(Math.round(s), MIN_SIZE, MAX_SIZE); showSize(); }
  function adjustSize(d) {
    const it = itemById(selected);
    if (it && it.type === 'sign') { const s = clamp(it.size + d * 2, SIG_MIN, SIG_MAX); changeSelected({ size: s }); $('sizeOut').textContent = s; return; }
    if (!it && tool === 'sign') { signSize = clamp(signSize + d * 2, SIG_MIN, SIG_MAX); showSize(); return; }
    setSize(size + d); if (it) changeSelected({ size });
  }
  function setBold(b) { bold = !!b; $('boldBtn').setAttribute('aria-pressed', bold); }
  function syncControlsTo(it) {
    setColor(it.color);
    if (it.type === 'sign') { $('sizeOut').textContent = it.size; return; }
    setSize(it.size); if (it.type === 'text') setBold(it.bold);
  }

  function changeSelected(patch) {
    const it = items.find(i => i.id === selected); if (!it) return;
    pushHistory(); Object.assign(it, patch); redraw(it.page);
  }

  /* ---------- opening & combining PDFs ---------- */
  async function readPdf(file) {                       // -> source {id,name,bytes,doc} or null (toasts why)
    if (file.size > MAX_BYTES) { toast(`${file.name}: too large (limit 150 MB).`, true); return null; }
    let bytes;
    try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { toast('Could not read ' + file.name + '.', true); return null; }
    if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') { toast(file.name + ' does not look like a PDF file.', true); return null; }
    try {
      const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false }).promise;
      return { id: nextSrc++, name: file.name || 'document.pdf', bytes, doc };
    } catch (e) {
      toast(e && e.name === 'PasswordException' ? file.name + ' is password-protected and cannot be opened.' : 'Could not open ' + file.name + '.', true);
      return null;
    }
  }
  async function modelsFor(src) {                      // one page model per page of the source
    const out = [];
    for (let i = 0; i < src.doc.numPages; i++) {
      const page = await src.doc.getPage(i + 1), vp = page.getViewport({ scale: 1 });
      out.push({ n: 0, w: vp.width, h: vp.height, rot: page.rotate % 360, page, src, idx: i, task: null, rendered: 0 });
    }
    return out;
  }

  async function openPdf(file) {                       // replaces the current document
    if (!file) return;
    if (hasDoc() && dirty && !confirm('You have unsaved changes. Open a different PDF anyway?')) return;
    const token = ++loadToken;
    const src = await readPdf(file); if (!src) return;
    const models = await modelsFor(src);
    if (token !== loadToken) { src.doc.destroy(); return; }
    sources.forEach(s => s.doc.destroy()); sources = [src]; fileName = src.name;
    items = []; history = []; selected = null; nextId = 1; dirty = false; curPage = 1;
    $('undo').disabled = true; $('del').disabled = true;
    document.body.classList.add('loaded'); $('toolbar').hidden = false;
    ['save', 'saveWork', 'loadWorkBtn', 'addBtn2'].forEach(i => { $(i).disabled = false; });
    pages = models; renumber(); rebuildDom(); updateFileLabel();
    stage.scrollTo(0, 0); activateTool('text');
    if (pages.some(p => p.rot)) toast('Some pages are rotated. Placing items on rotated pages is not supported.', true);
    try {                                              // XFA forms render as a "please wait" placeholder; warn the user
      const probe = await pdfjs.getDocument({ data: src.bytes.slice(), isEvalSupported: false, enableXfa: true }).promise;
      if (probe.isPureXfa) toast('This is a dynamic XFA form and cannot be filled here. Use the form’s printable PDF version.', true);
      probe.destroy();
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
    const old = pages, pos = new Map(list.map((p, i) => [p, i + 1]));
    items = items.map(it => ({ ...it, page: pos.get(old[it.page - 1]) })).filter(it => it.page);
    old.forEach(p => { if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } } });
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

  function buildPageDom(p) {
    const el = document.createElement('div'); el.className = 'page';
    const canvas = document.createElement('canvas');
    const layer = document.createElement('div'); layer.className = 'layer';
    const ghost = document.createElement('div'); ghost.className = 'ghost';
    const textEl = document.createElement('div'); textEl.className = 'textLayer';
    const num = document.createElement('div'); num.className = 'num'; num.textContent = p.n;
    el.append(canvas, textEl, layer, ghost, num); pagesEl.appendChild(el);
    Object.assign(p, { el, canvas, textEl, layer, ghost, task: null, textTask: null, rendered: 0 });
    attachLayer(p);
  }
  function rebuildDom() {
    thumbObserver && thumbObserver.disconnect();
    pagesEl.textContent = ''; thumbList.textContent = '';
    pages.forEach(p => { buildPageDom(p); addThumb(p); });
    computeScale(); layout(); activateTool(tool); updatePageInfo();
  }

  /* ---------- layout & rendering ---------- */
  function computeScale() {
    if (!fit || !pages.length) return;
    const avail = stage.clientWidth - (window.innerWidth <= 860 ? 16 : 44) - (stage.offsetWidth - stage.clientWidth);
    const widest = Math.max(...pages.map(p => p.w));
    scale = clamp(avail / widest, 0.4, 1.5);
  }
  function layout() {
    $('zoomFit').textContent = Math.round(scale * 100) + '%';
    $('zoomFit').title = fit ? 'Fit to width (on)' : 'Fit to width';
    pages.forEach(p => {
      p.el.style.width = p.w * scale + 'px'; p.el.style.height = p.h * scale + 'px';
      p.textEl.textContent = '';                         // stale until the page is re-rendered
      p.rendered = 0; redraw(p.n);
    });
    renderVisible();
  }
  async function renderPage(p) {
    const stamp = ++p.rendered;                 // marks "render started"; layout() resets to 0
    const vp = p.page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } }
    const c = p.canvas;
    c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
    const task = p.page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    p.task = task;
    try { await task.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') { p.rendered = 0; return; } }
    p.rendered = stamp;
    renderText(p, vp);
  }
  async function renderText(p, vp) {                  // invisible, selectable text over the canvas
    if (p.textTask) { try { p.textTask.cancel(); } catch { /* ignore */ } }
    p.textEl.textContent = '';
    try {
      const t = pdfjs.renderTextLayer({ textContentSource: p.page.streamTextContent(), container: p.textEl, viewport: vp, textDivs: [] });
      p.textTask = t; await t.promise;
    } catch { /* cancelled, or the page has no text */ }
  }
  let raf = 0;
  function renderVisible() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const sr = stage.getBoundingClientRect(); const margin = 700;
      let best = null, bestVis = 0;
      for (const p of pages) {
        const r = p.el.getBoundingClientRect();
        if (r.bottom > sr.top - margin && r.top < sr.bottom + margin && p.rendered === 0) renderPage(p);
        const vis = Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top);
        if (vis > bestVis) { bestVis = vis; best = p; }
      }
      if (best && best.n !== curPage) { curPage = best.n; updatePageInfo(); }
      else updatePageInfo();
    });
  }
  function updatePageInfo() {
    $('pageinfo').textContent = hasDoc() ? `Page ${curPage} of ${pages.length}` : '';
    document.querySelectorAll('.thumb').forEach(t => {
      const on = +t.dataset.n === curPage; t.classList.toggle('cur', on);
      if (on && t.dataset.lastCur !== '1') { t.scrollIntoView({ block: 'nearest' }); }
      t.dataset.lastCur = on ? '1' : '';
    });
  }
  stage.addEventListener('scroll', renderVisible, { passive: true });
  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (hasDoc() && fit) { computeScale(); layout(); } }, 150);
  });

  /* ---------- thumbnails / page list ---------- */
  const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(async en => {
      if (!en.isIntersecting) return;
      thumbObserver.unobserve(en.target);
      const p = pages[+en.target.dataset.n - 1]; if (!p) return;
      const c = en.target.querySelector('canvas');
      const vp = p.page.getViewport({ scale: 110 / p.w });
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      try { await p.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch { /* ignore */ }
    });
  }, { root: $('thumbs'), rootMargin: '200px' }) : null;

  let dragSrc = null;                                  // page being reordered
  function addThumb(p) {
    const w = document.createElement('div');
    w.className = 'thumb s' + (sources.indexOf(p.src) % 6); w.dataset.n = p.n; w.draggable = true;
    w.title = `${p.src.name} · page ${p.idx + 1}`;
    const go = document.createElement('button'); go.type = 'button'; go.className = 'thumb-go'; go.setAttribute('aria-label', 'Go to page ' + p.n);
    const c = document.createElement('canvas'); c.width = 110; c.height = Math.round(110 * p.h / p.w); c.style.aspectRatio = `${p.w} / ${p.h}`;
    const s = document.createElement('span'); s.textContent = p.n;
    go.append(c, s);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'thumb-del'; del.textContent = '×';
    del.title = 'Remove this page'; del.setAttribute('aria-label', 'Remove page ' + p.n);
    w.append(go, del); thumbList.appendChild(w);
    go.onclick = () => { p.el.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
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
    thumbObserver && thumbObserver.observe(w);
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

  /* ---------- items ---------- */
  function redraw(n) {
    const p = pages[n - 1]; if (!p) return;
    p.layer.textContent = '';
    items.filter(i => i.page === n).forEach(it => addEl(p, it));
  }
  function addEl(p, it) {
    const el = document.createElement('div');
    el.className = 'item ' + (it.type === 'text' ? 'text' : it.type === 'sign' ? 'sign' : 'mark') + (it.bold ? ' bold' : '') + (it.id === selected ? ' sel' : '');
    el.dataset.id = it.id;
    if (it.type === 'text') {
      el.style.fontSize = it.size * scale + 'px'; el.style.color = CSS_COLOR[it.color] || '#000';
      el.textContent = it.text;
    } else if (it.type === 'sign') {
      el.appendChild(sigEl(it, scale));
    } else {
      el.appendChild(markSVG(it.type, markBox(it) * scale, it.color));
    }
    const [ox, oy] = originOf(it); el.style.left = ox + 'px'; el.style.top = oy + 'px';
    p.layer.appendChild(el); return el;
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
    el.addEventListener('paste', e => {          // paste as plain text
      e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').slice(0, 500));
    });
  }

  pagesEl.addEventListener('pointerdown', e => {
    if (tool === 'select' && !e.target.closest('.item') && selected != null) select(null);
  });

  /* ---------- pointer handling (one handler per page layer) ---------- */
  function attachLayer(p) {
    const L = p.layer;
    L.addEventListener('pointermove', e => {
      const ghostTool = tool === 'check' || tool === 'cross' || (tool === 'sign' && sig);
      if (e.pointerType !== 'mouse' || !ghostTool || p.rot || e.target.closest('.item')) { p.ghost.style.display = 'none'; return; }
      const r = L.getBoundingClientRect(); let w, h;
      p.ghost.textContent = '';
      if (tool === 'sign') {
        const it = { text: sig.text, font: sig.font, size: signSize, color }, c = sigImage(it);
        p.ghost.appendChild(sigEl(it, scale)); w = c.w * scale; h = c.h * scale;
      } else { w = h = size * 1.15 * scale; p.ghost.appendChild(markSVG(tool, w, color)); }
      p.ghost.style.left = (e.clientX - r.left - w / 2) + 'px'; p.ghost.style.top = (e.clientY - r.top - h / 2) + 'px'; p.ghost.style.display = 'block';
    });
    L.addEventListener('pointerleave', () => { p.ghost.style.display = 'none'; });

    L.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const ae = document.activeElement;
      if (ae && ae.isContentEditable && !ae.contains(e.target)) ae.blur();   // commit pending text first
      const target = e.target.closest('.item');
      if (target && target.isContentEditable) return;
      if (target) { startDrag(e, p, target); return; }
      if (p.rot) { toast('This page is rotated; placing items here is not supported.', true); return; }
      if (tool === 'select') { select(null); return; }
      if (tool === 'sign' && !sig) { openSignDialog(); return; }
      const r = L.getBoundingClientRect();
      const x = (e.clientX - r.left) / scale, y = (e.clientY - r.top) / scale;
      pushHistory();
      const it = { id: nextId++, page: p.n, type: tool, x, y, size, color, bold: tool === 'text' && bold, text: '' };
      if (tool === 'sign') { it.text = sig.text; it.font = sig.font; it.size = signSize; it.bold = false; }
      items.push(it); selected = it.id;
      p.ghost.style.display = 'none';
      if (tool === 'text') {
        // y is the top of the text; centre the first line on the click point
        it.y = y - size * 0.5;
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
    const sx = e.clientX, sy = e.clientY, ox = it.x, oy = it.y; let moved = false;
    const place = () => { const [lx, ly] = originOf(it); target.style.left = lx + 'px'; target.style.top = ly + 'px'; };
    const move = ev => {
      const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
      if (!moved && Math.hypot(dx, dy) * scale < 3) return;
      if (!moved) { pushHistory(); moved = true; }
      it.x = clamp(ox + dx, 0, p.w); it.y = clamp(oy + dy, 0, p.h); place();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    e.preventDefault();
  }

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
      if (!i || !['text', 'check', 'cross', 'sign'].includes(i.type)) continue;
      const page = Math.floor(+i.page);
      if (!(page >= 1 && page <= pages.length)) continue;
      const x = +i.x, y = +i.y, sz = +i.size;
      if (![x, y, sz].every(Number.isFinite)) continue;
      if (i.type === 'sign' && (!SIG_FONTS.includes(i.font) || !String(i.text ?? '').trim())) continue;
      const isSign = i.type === 'sign';
      out.push({ id: out.length + 1, page, type: i.type, x, y, size: isSign ? clamp(sz, SIG_MIN, SIG_MAX) : clamp(sz, MIN_SIZE, MAX_SIZE),
        color: COLORS[i.color] ? i.color : 'black', bold: i.type === 'text' && i.bold === true,
        text: i.type === 'text' ? String(i.text ?? '').slice(0, 500) : isSign ? String(i.text).slice(0, 40) : '',
        ...(isSign ? { font: i.font } : {}) });
    }
    return out;
  }

  /* ---------- export ---------- */
  async function savePdf() {
    if (!hasDoc()) return;
    const { PDFDocument, StandardFonts, rgb, LineCapStyle } = PDFLib;
    const btn = $('save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const merged = !(sources.length === 1 && pages.length === sources[0].doc.numPages && pages.every((p, i) => p.idx === i));
      const load = async s => {
        const d = await PDFDocument.load(s.bytes, { ignoreEncryption: true });
        if (d.isEncrypted) throw new Error('ENCRYPTED');
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
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
      const pgs = doc.getPages(); let replaced = false;
      if (items.some(i => i.type === 'sign')) await loadFonts();
      const sigImgs = new Map();
      const safe = s => [...s].map(ch => { try { font.encodeText(ch); return ch; } catch { replaced = true; return '?'; } }).join('');
      for (const it of items) {
        const pg = pgs[it.page - 1]; if (!pg) continue;
        const H = pg.getHeight(), col = rgb(...(COLORS[it.color] || COLORS.black));
        if (it.type === 'sign') {
          const c = sigImage(it);
          if (!sigImgs.has(c.url)) sigImgs.set(c.url, await doc.embedPng(c.url));
          pg.drawImage(sigImgs.get(c.url), { x: it.x - c.w / 2, y: H - it.y - c.h / 2, width: c.w, height: c.h });
        } else if (it.type === 'text') {
          safe(it.text).split('\n').forEach((line, n) => {
            if (!line) return;
            pg.drawText(line, { x: it.x, y: H - it.y - it.size * 0.82 - n * it.size * 1.15, size: it.size, font: it.bold ? fontBold : font, color: col });
          });
        } else {
          const b = markBox(it), x0 = it.x - b / 2, y0 = it.y - b / 2, k = b / 10;
          const P = (px, py) => ({ x: x0 + px * k, y: H - (y0 + py * k) });
          const seg = (a, c) => pg.drawLine({ start: P(...a), end: P(...c), thickness: 1.25 * k, color: col, lineCap: LineCapStyle.Round });
          if (it.type === 'check') { seg([1.2, 5.4], [4, 8.2]); seg([4, 8.2], [8.8, 1.6]); }
          else { seg([1.5, 1.5], [8.5, 8.5]); seg([8.5, 1.5], [1.5, 8.5]); }
        }
      }
      const out = await doc.save();
      download(new Blob([out], { type: 'application/pdf' }), baseName() + (merged ? '-combined' : '-filled') + '.pdf');
      dirty = false;
      toast(replaced ? 'Saved. Some characters are not supported by the PDF font and were replaced with “?”.' : 'Saved to your Downloads folder. The original file was not changed.', replaced);
    } catch (e) {
      console.error(e);
      toast(e && e.message === 'ENCRYPTED'
        ? 'One of these PDFs is encrypted (restricted), so it cannot be saved here. Print it to a new PDF first (Print → Save as PDF), then open that copy.'
        : 'Could not save this PDF.', true);
    } finally { btn.disabled = false; btn.textContent = 'Save PDF'; }
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
    download(new Blob([JSON.stringify({ app: 'fill-pdf', v: 1, file: fileName, pages: pages.length, items }, null, 1)], { type: 'application/json' }), baseName() + '.progress.json');
    toast('Progress saved. Load it later with the same PDF.');
  };
  $('loadWorkBtn').onclick = () => { $('moreMenu').open = false; $('loadWork').click(); };
  $('loadWork').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !hasDoc()) return;
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error('big');
      const d = JSON.parse(await f.text());
      const loaded = cleanItems(d.items); await loadFonts();
      pushHistory(); items = loaded; nextId = items.length + 1; select(null);
      pages.forEach(p => redraw(p.n));
      toast(`Loaded ${items.length} item${items.length === 1 ? '' : 's'}.`);
      if ((d.file && d.file !== fileName) || (d.pages && d.pages !== pages.length)) toast('Loaded. Note: this progress file was saved for a different PDF or page order.', true);
    } catch { toast('That is not a valid progress file.', true); }
  };
  document.addEventListener('click', e => { const m = $('moreMenu'); if (m.open && !m.contains(e.target)) m.open = false; });

  addEventListener('keydown', e => {
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    if ($('shortcuts').open || $('signDialog').open || $('dropDialog').open) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); undo(); return; }
    if (mod && k === 's') { e.preventDefault(); savePdf(); return; }
    if (mod && k === 'b' && hasDoc()) { e.preventDefault(); $('boldBtn').click(); return; }
    if (mod || e.altKey || !hasDoc()) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (selected != null) { e.preventDefault(); deleteSel(); } return; }
    if (e.key === 'Escape') { select(null); return; }
    if (selected != null && e.key.startsWith('Arrow')) {
      const st = e.shiftKey ? 5 : 1;
      const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (d) { e.preventDefault(); nudge(...d); } return;
    }
    const t = { t: 'text', c: 'check', x: 'cross', s: 'sign', v: 'select' }[k]; if (t) setTool(t);
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
