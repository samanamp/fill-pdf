/* True redaction for pdf-lib pages: deletes the text that lies under redaction rectangles from the
 * page's content stream (and from any form XObjects it draws). Everything else stays as real text.
 *
 *   Redactor.redactPage(pdfDoc, pdfPage, rects) -> { glyphs, images, annots }
 *     rects: [[x0, y0, x1, y1], ...] in PDF user space (the page's own coordinates)
 *
 * Removed glyphs are replaced by a TJ spacing adjustment, so the remaining text does not move.
 * Annotations (form fields, comments, links) that overlap a rectangle are removed.
 * Images are NOT changed; `images` counts image draws that overlap a rectangle so the caller can warn.
 * Throws if a stream cannot be decoded, so the caller never saves a half-redacted file.
 * Form XObjects are edited in place, so the same text also disappears wherever else that XObject is drawn.
 */
(() => {
  'use strict';

  /* ---------- content stream lexer ---------- */
  const WS = new Uint8Array(256), DL = new Uint8Array(256);
  [0, 9, 10, 12, 13, 32].forEach(c => { WS[c] = 1; });
  '()<>[]{}/%'.split('').forEach(c => { DL[c.charCodeAt(0)] = 1; });
  const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;
  const ascii = (b, s, e) => { let t = ''; for (let k = s; k < e; k++) t += String.fromCharCode(b[k]); return t; };
  const hexv = c => (c >= 48 && c <= 57) ? c - 48 : (c >= 65 && c <= 70) ? c - 55 : (c >= 97 && c <= 102) ? c - 87 : -1;

  // Values: number | boolean | null | {n: name} | {s: Uint8Array} | {d: Map} | Array | {op: string}
  function lex(b) {
    const n = b.length, ops = [];
    let i = 0;
    const skipWs = () => {
      for (;;) {
        while (i < n && WS[b[i]]) i++;
        if (i < n && b[i] === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; } else return;
      }
    };
    const readLit = () => {
      const out = []; let depth = 1; i++;
      while (i < n) {
        const c = b[i++];
        if (c === 92) {
          const e = b[i++];
          if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9);
          else if (e === 98) out.push(8); else if (e === 102) out.push(12);
          else if (e >= 48 && e <= 55) {
            let v = e - 48;
            for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48;
            out.push(v & 255);
          } else if (e === 13) { if (b[i] === 10) i++; } else if (e === 10) { /* line continuation */ }
          else if (e !== undefined) out.push(e);
        } else if (c === 40) { depth++; out.push(c); }
        else if (c === 41) { if (--depth === 0) break; out.push(c); }
        else out.push(c);
      }
      return { s: Uint8Array.from(out) };
    };
    const readHex = () => {
      const out = []; let hi = -1; i++;
      while (i < n && b[i] !== 62) {
        const v = hexv(b[i++]); if (v < 0) continue;
        if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
      }
      if (hi >= 0) out.push(hi * 16);
      i++; return { s: Uint8Array.from(out) };
    };
    const readName = () => {
      const s = ++i; while (i < n && !WS[b[i]] && !DL[b[i]]) i++;
      return { n: ascii(b, s, i).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    };
    const readValue = () => {
      const c = b[i];
      if (c === 40) return readLit();
      if (c === 60) {
        if (b[i + 1] !== 60) return readHex();
        i += 2; const d = new Map();
        for (;;) {
          skipWs(); if (i >= n) return { d };
          if (b[i] === 62 && b[i + 1] === 62) { i += 2; return { d }; }
          const k = readValue(); skipWs(); if (i >= n) return { d };
          const v = readValue(); if (k && k.n !== undefined) d.set(k.n, v);
        }
      }
      if (c === 91) {
        i++; const arr = [];
        for (;;) { skipWs(); if (i >= n) return arr; if (b[i] === 93) { i++; return arr; } arr.push(readValue()); }
      }
      if (c === 47) return readName();
      const s = i; while (i < n && !WS[b[i]] && !DL[b[i]]) i++;
      if (s === i) { i++; return { op: String.fromCharCode(c) }; }        // stray delimiter
      const t = ascii(b, s, i);
      if (NUM.test(t)) return +t;
      if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
      return { op: t };
    };

    let args = [], argStart = -1;
    for (;;) {
      skipWs(); if (i >= n) break;
      const s = i, v = readValue();
      if (v === null || typeof v !== 'object' || v.op === undefined) { if (argStart < 0) argStart = s; args.push(v); continue; }
      const start = argStart >= 0 ? argStart : s;
      if (v.op === 'BI') {                                // inline image: skip its binary data
        const d = new Map();
        for (;;) {
          skipWs(); if (i >= n) break;
          const k = readValue();
          if (k && k.op === 'ID') break;
          skipWs(); const val = readValue(); if (k && k.n !== undefined) d.set(k.n, val);
        }
        i++;                                              // single whitespace after ID
        let j = i;
        while (j < n && !(b[j] === 69 && b[j + 1] === 73 && WS[b[j - 1]] && (j + 2 >= n || WS[b[j + 2]] || DL[b[j + 2]]))) j++;
        i = Math.min(n, j + 2);
        ops.push({ op: 'BI', args: [{ d }], start, end: i });
      } else ops.push({ op: v.op, args, start, end: i });
      args = []; argStart = -1;
    }
    return ops;
  }

  /* ---------- serialising ---------- */
  const fmt = x => { const s = (Math.round(x * 1000) / 1000).toString(); return s === '-0' ? '0' : s; };
  const hexStr = bytes => '<' + Array.from(bytes, x => (x < 16 ? '0' : '') + x.toString(16)).join('') + '>';
  const nameStr = s => '/' + [...s].map(ch => {
    const c = ch.charCodeAt(0);
    return (c < 33 || c > 126 || c === 35 || DL[c]) ? '#' + (c < 16 ? '0' : '') + (c & 255).toString(16) : ch;
  }).join('');
  function ser(v) {
    if (typeof v === 'number') return fmt(v);
    if (v === true || v === false) return String(v);
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return '[' + v.map(ser).join(' ') + ']';
    if (v.n !== undefined) return nameStr(v.n);
    if (v.s !== undefined) return hexStr(v.s);
    if (v.d !== undefined) return '<<' + [...v.d].map(([k, x]) => nameStr(k) + ' ' + ser(x)).join(' ') + '>>';
    return v.op || '';
  }
  const enc = s => { const u = new Uint8Array(s.length); for (let k = 0; k < s.length; k++) u[k] = s.charCodeAt(k) & 255; return u; };

  /* ---------- geometry ---------- */
  const ID = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  function bbox(m, x0, y0, x1, y1) {                       // axis-aligned box of a transformed rectangle
    const xs = [], ys = [];
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { xs.push(x * m[0] + y * m[2] + m[4]); ys.push(x * m[1] + y * m[3] + m[5]); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const overlaps = (a, r) => a[0] < r[2] && a[2] > r[0] && a[1] < r[3] && a[3] > r[1];
  // a glyph counts as redacted when its centre is inside a rect or at least 35% of it is covered
  function glyphHit(g, rects) {
    const gw = g[2] - g[0], gh = g[3] - g[1], cx = (g[0] + g[2]) / 2, cy = (g[1] + g[3]) / 2, area = gw * gh;
    for (const r of rects) {
      if (cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]) return true;
      if (area > 1e-6) {
        const ix = Math.min(g[2], r[2]) - Math.max(g[0], r[0]), iy = Math.min(g[3], r[3]) - Math.max(g[1], r[1]);
        if (ix > 0 && iy > 0 && ix * iy >= 0.35 * area) return true;
      }
    }
    return false;
  }

  /* ---------- fonts ---------- */
  const STD = (base) => {
    const b = base.replace(/^[A-Z]{6}\+/, '').replace(/[\s,]/g, ''), bold = /bold|black|heavy/i.test(b), it = /italic|oblique/i.test(b);
    if (/zapf|dingbat/i.test(b)) return 'ZapfDingbats';
    if (/symbol/i.test(b)) return 'Symbol';
    if (/courier|mono/i.test(b)) return 'Courier' + (bold || it ? '-' + (bold ? 'Bold' : '') + (it ? 'Oblique' : '') : '');
    if (/times|serif|georgia|garamond|roman/i.test(b) && !/sans/i.test(b)) return bold && it ? 'Times-BoldItalic' : bold ? 'Times-Bold' : it ? 'Times-Italic' : 'Times-Roman';
    return 'Helvetica' + (bold || it ? '-' + (bold ? 'Bold' : '') + (it ? 'Oblique' : '') : '');
  };

  function makeFontReader(PL) {
    const { PDFName, PDFDict, PDFArray, PDFNumber } = PL;
    const N = s => PDFName.of(s);
    const num = (o, dflt) => (o instanceof PDFNumber ? o.asNumber() : dflt);
    const nums = arr => { const out = []; if (arr instanceof PDFArray) for (let k = 0; k < arr.size(); k++) out.push(num(arr.lookup(k), 0)); return out; };
    const nameOf = o => (o instanceof PDFName ? o.decodeText() : '');
    const cache = new Map();
    const FALLBACK = { bytes: 1, width: () => 0.5, asc: 0.9, dsc: -0.25 };

    function metrics(fdesc) {
      let asc = 0.9, dsc = -0.25;
      if (fdesc instanceof PDFDict) {
        const a = num(fdesc.lookup(N('Ascent')), 0) / 1000, d = num(fdesc.lookup(N('Descent')), 0) / 1000;
        if (a > 0.3 && a < 2) asc = a;
        if (d < 0 && d > -1) dsc = d;
      }
      return { asc, dsc };
    }
    function read(fd) {
      if (!(fd instanceof PDFDict)) return FALLBACK;
      if (cache.has(fd)) return cache.get(fd);
      let info;
      const sub = nameOf(fd.lookup(N('Subtype')));
      if (sub === 'Type0') {
        const df = fd.lookup(N('DescendantFonts')), d = df instanceof PDFArray ? df.lookup(0) : null;
        const w = new Map(); let dw = 1000, m = { asc: 0.9, dsc: -0.25 };
        if (d instanceof PDFDict) {
          dw = num(d.lookup(N('DW')), 1000); m = metrics(d.lookup(N('FontDescriptor')));
          const W = d.lookup(N('W'));
          if (W instanceof PDFArray) {
            for (let k = 0; k < W.size();) {
              const c = num(W.lookup(k), 0), nx = W.lookup(k + 1);
              if (nx instanceof PDFArray) { nums(nx).forEach((v, j) => w.set(c + j, v)); k += 2; }
              else { const c2 = num(nx, c), v = num(W.lookup(k + 2), dw); for (let x = c; x <= c2 && x - c < 65536; x++) w.set(x, v); k += 3; }
            }
          }
        }
        info = { bytes: 2, width: c => (w.has(c) ? w.get(c) : dw) / 1000, ...m };
      } else {
        const first = num(fd.lookup(N('FirstChar')), 0), widths = nums(fd.lookup(N('Widths')));
        const fdesc = fd.lookup(N('FontDescriptor')), mw = fdesc instanceof PDFDict ? num(fdesc.lookup(N('MissingWidth')), 0) : 0;
        const fm = sub === 'Type3' ? (nums(fd.lookup(N('FontMatrix')))[0] || 0.001) : 0.001;
        let width;
        if (widths.length) width = c => ((c >= first && c - first < widths.length) ? widths[c - first] : mw) * fm;
        else {                                            // standard 14 font without a Widths array
          let emb = null; try { emb = PL.StandardFontEmbedder.for(STD(nameOf(fd.lookup(N('BaseFont'))))); } catch { emb = null; }
          const wc = new Map();
          width = c => {
            if (wc.has(c)) return wc.get(c);
            let v = mw ? mw / 1000 : 0.5;
            if (emb) { try { v = emb.widthOfTextAtSize(String.fromCharCode(c), 1000) / 1000; } catch { /* keep fallback */ } }
            wc.set(c, v); return v;
          };
        }
        info = { bytes: 1, width, ...metrics(fdesc) };
      }
      cache.set(fd, info); return info;
    }
    return { read, FALLBACK };
  }

  /* ---------- the redactor ---------- */
  function redactPage(pdfDoc, page, rects) {
    const PL = globalThis.PDFLib;
    const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } = PL;
    const ctx = pdfDoc.context, N = s => PDFName.of(s);
    const fonts = makeFontReader(PL);
    const stats = { glyphs: 0, images: 0, annots: 0 };
    rects = rects.map(r => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]);
    if (!rects.length) return stats;

    const decode = s => {
      if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
      if (s && typeof s.getContents === 'function') return s.getContents();
      throw new Error('Unsupported stream');
    };
    const numsOf = arr => { const out = []; if (arr instanceof PDFArray) for (let k = 0; k < arr.size(); k++) { const v = arr.lookup(k); out.push(v instanceof PDFNumber ? v.asNumber() : 0); } return out; };
    const sub = (dict, key) => { const v = dict instanceof PDFDict ? dict.lookup(N(key)) : undefined; return v instanceof PDFDict ? v : null; };
    const done = new Set();                               // form XObjects already rewritten for a given CTM

    // returns new bytes, or null when nothing in this stream had to change
    function process(bytes, res, ctm0, depth) {
      const ops = lex(bytes), repl = new Map();
      let gs = { ctm: ctm0, font: fonts.FALLBACK, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0 };
      const stack = [], mc = [], tainted = new Set();
      let Tm = ID, Tlm = ID;
      const fontRes = sub(res, 'Font'), xoRes = sub(res, 'XObject');
      const nl = () => { Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm; };

      const show = (k, elems, prefix) => {
        const f = gs.font, sz = gs.size, Th = gs.Th, unit = sz * Th;
        const out = []; let cur = [], pending = 0, hit = false;
        const flushStr = () => { if (cur.length) { out.push(Uint8Array.from(cur)); cur = []; } };
        const flushGap = () => { if (pending) { if (unit) { flushStr(); out.push(-pending * 1000 / unit); } pending = 0; } };
        for (const el of elems) {
          if (typeof el === 'number') {
            flushStr(); out.push(el);
            Tm = mul([1, 0, 0, 1, -el / 1000 * unit, 0], Tm); continue;
          }
          if (!el || !el.s) continue;
          const s = el.s;
          for (let j = 0; j + f.bytes <= s.length; j += f.bytes) {
            const code = f.bytes === 2 ? (s[j] << 8) | s[j + 1] : s[j];
            const w0 = f.width(code);
            const g = bbox(mul(Tm, gs.ctm), 0, gs.Ts + f.dsc * sz, w0 * unit, gs.Ts + f.asc * sz);
            const tx = (w0 * sz + gs.Tc + (f.bytes === 1 && code === 32 ? gs.Tw : 0)) * Th;
            if (glyphHit(g, rects)) { hit = true; pending += tx; stats.glyphs++; }
            else { flushGap(); for (let q = 0; q < f.bytes; q++) cur.push(s[j + q]); }
            Tm = mul([1, 0, 0, 1, tx, 0], Tm);
          }
        }
        if (!hit) return;
        flushStr(); flushGap();
        mc.forEach(x => { if (x >= 0) tainted.add(x); });
        repl.set(k, prefix + '[' + out.map(x => (typeof x === 'number' ? fmt(x) : hexStr(x))).join(' ') + '] TJ');
      };

      ops.forEach((o, k) => {
        const a = o.args;
        switch (o.op) {
          case 'q': stack.push({ ...gs }); break;
          case 'Q': if (stack.length) gs = stack.pop(); break;
          case 'cm': if (a.length >= 6) gs.ctm = mul(a.slice(-6), gs.ctm); break;
          case 'BT': Tm = Tlm = ID; break;
          case 'Tf': {
            const nm = a[a.length - 2];
            gs.font = (fontRes && nm && nm.n !== undefined) ? fonts.read(fontRes.lookup(N(nm.n))) : fonts.FALLBACK;
            gs.size = +a[a.length - 1] || 0; break;
          }
          case 'Tc': gs.Tc = +a[0] || 0; break;
          case 'Tw': gs.Tw = +a[0] || 0; break;
          case 'Tz': gs.Th = (+a[0] || 0) / 100; break;
          case 'TL': gs.TL = +a[0] || 0; break;
          case 'Ts': gs.Ts = +a[0] || 0; break;
          case 'Td': case 'TD':
            if (o.op === 'TD') gs.TL = -(+a[1] || 0);
            Tlm = mul([1, 0, 0, 1, +a[0] || 0, +a[1] || 0], Tlm); Tm = Tlm; break;
          case 'Tm': if (a.length >= 6) { Tlm = Tm = a.slice(-6).map(x => +x || 0); } break;
          case 'T*': nl(); break;
          case 'Tj': show(k, [a[0]], ''); break;
          case 'TJ': show(k, Array.isArray(a[0]) ? a[0] : [], ''); break;
          case "'": nl(); show(k, [a[0]], 'T* '); break;
          case '"': {
            gs.Tw = +a[0] || 0; gs.Tc = +a[1] || 0; nl();
            show(k, [a[2]], fmt(gs.Tw) + ' Tw ' + fmt(gs.Tc) + ' Tc T* '); break;
          }
          case 'BMC': mc.push(-1); break;
          case 'BDC': mc.push(a[1] && a[1].d ? k : -1); break;
          case 'EMC': mc.pop(); break;
          case 'BI': if (rects.some(r => overlaps(bbox(gs.ctm, 0, 0, 1, 1), r))) stats.images++; break;
          case 'Do': {
            const nm = a[0]; if (!xoRes || !nm || nm.n === undefined) break;
            const raw = xoRes.get(N(nm.n)), xo = ctx.lookup(raw);
            if (!xo || !xo.dict) break;
            const st = xo.dict.lookup(N('Subtype'));
            if (st === N('Image')) { if (rects.some(r => overlaps(bbox(gs.ctm, 0, 0, 1, 1), r))) stats.images++; break; }
            if (st !== N('Form') || depth > 12) break;
            const m = numsOf(xo.dict.lookup(N('Matrix'))), fm = m.length === 6 ? m : ID, ctm = mul(fm, gs.ctm);
            const key = (raw instanceof PDFRef ? raw.toString() : nm.n) + '@' + ctm.map(fmt).join(',');
            if (done.has(key)) break; done.add(key);
            const fres = sub(xo.dict, 'Resources') ? xo.dict.lookup(N('Resources')) : res;
            const nb = process(decode(xo), fres, ctm, depth + 1);
            if (nb && raw instanceof PDFRef) {           // rewrite the XObject in place (same object number)
              const ns = ctx.flateStream(nb);
              for (const [kk, vv] of xo.dict.entries()) {
                if (kk !== N('Filter') && kk !== N('DecodeParms') && kk !== N('Length') && kk !== N('DL')) ns.dict.set(kk, vv);
              }
              ctx.assign(raw, ns);
            } else if (nb) throw new Error('Inline form XObject');
            break;
          }
          default: break;
        }
      });

      tainted.forEach(k => {                               // drop ActualText/Alt so the hidden text is not kept there
        const o = ops[k], d = o.args[1].d;
        if (!d.has('ActualText') && !d.has('Alt') && !d.has('E')) return;
        const nd = new Map([...d].filter(([kk]) => kk !== 'ActualText' && kk !== 'Alt' && kk !== 'E'));
        repl.set(k, ser(o.args[0]) + ' ' + ser({ d: nd }) + ' BDC');
      });
      if (!repl.size) return null;

      const parts = []; let pos = 0, len = 0;
      ops.forEach((o, k) => {
        if (!repl.has(k)) return;
        parts.push(bytes.subarray(pos, o.start), enc(' ' + repl.get(k) + ' ')); pos = o.end;
      });
      parts.push(bytes.subarray(pos));
      parts.forEach(p => { len += p.length; });
      const out = new Uint8Array(len); let off = 0;
      parts.forEach(p => { out.set(p, off); off += p.length; });
      return out;
    }

    /* page content */
    const node = page.node, contents = node.Contents();
    const streams = [];
    if (contents instanceof PDFArray) { for (let k = 0; k < contents.size(); k++) { const s = contents.lookup(k); if (s) streams.push(s); } }
    else if (contents) streams.push(contents);
    const chunks = streams.map(decode), total = chunks.reduce((s, c) => s + c.length + 1, 0);
    const all = new Uint8Array(total); let off = 0;
    chunks.forEach(c => { all.set(c, off); off += c.length; all[off++] = 10; });
    const res = node.Resources();
    const nb = process(all, res instanceof PDFDict ? res : null, ID, 0);
    if (nb) node.set(N('Contents'), ctx.register(ctx.flateStream(nb)));
    if (res instanceof PDFDict && !node.get(N('Resources'))) node.set(N('Resources'), res);   // keep inherited resources

    /* annotations (form fields, comments, links) over a redacted area */
    const annots = node.Annots();
    if (annots instanceof PDFArray) {
      const keep = [], gone = new Set();
      for (let k = 0; k < annots.size(); k++) {
        const ref = annots.get(k), d = annots.lookup(k);
        if (!(d instanceof PDFDict)) { keep.push(ref); continue; }
        const r = numsOf(d.lookup(N('Rect')));
        const box = r.length === 4 ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])] : null;
        if (box && rects.some(x => overlaps(box, x))) gone.add(d); else keep.push(ref);
      }
      for (let k = 0; k < annots.size(); k++) {          // popups belonging to removed annotations
        const d = annots.lookup(k); if (!(d instanceof PDFDict) || gone.has(d)) continue;
        const par = d.lookup(N('Parent'));
        if (d.lookup(N('Subtype')) === N('Popup') && gone.has(par)) { gone.add(d); keep.splice(keep.indexOf(annots.get(k)), 1); }
      }
      const SCRUB = ['AP', 'V', 'DV', 'AS', 'Contents', 'RC', 'MK', 'T', 'TU', 'TM', 'Popup', 'A', 'AA', 'RV'];
      gone.forEach(d => {
        SCRUB.forEach(key => d.delete(N(key)));
        const par = d.lookup(N('Parent'));
        if (par instanceof PDFDict && d.lookup(N('Subtype')) === N('Widget')) {
          const kids = par.lookup(N('Kids'));
          if (kids instanceof PDFArray) {
            for (let k = kids.size() - 1; k >= 0; k--) if (kids.lookup(k) === d) kids.remove(k);
            if (kids.size() === 0) { par.delete(N('V')); par.delete(N('DV')); }
          }
        }
        stats.annots++;
      });
      if (gone.size) { if (keep.length) node.set(N('Annots'), ctx.obj(keep)); else node.delete(N('Annots')); }
    }
    return stats;
  }

  globalThis.Redactor = { redactPage, _lex: lex };
})();
