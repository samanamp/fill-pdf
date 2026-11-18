/* Removes the Standard security handler encryption from a PDF so pdf-lib can edit and save it.
 * Supports RC4 (40-128 bit), AES-128 and AES-256 (revisions 2-6). The open (user) password is
 * usually empty for "restricted" PDFs; the owner password also works.
 *   PdfDecrypt.load(bytes, password) -> decrypted PDFLib.PDFDocument
 *   throws Error('ENCRYPTED') for unsupported handlers, Error('PASSWORD') for a wrong password. */
const PdfDecrypt = (() => {
  'use strict';
  const { PDFParser, PDFObjectStreamParser, PDFDocument, PDFName, PDFDict, PDFArray, PDFString,
    PDFHexString, PDFRawStream, PDFStream, PDFNumber, PDFBool } = PDFLib;

  /* ---------- byte helpers ---------- */
  const cat = (...as) => { const o = new Uint8Array(as.reduce((s, a) => s + a.length, 0)); let p = 0; for (const a of as) { o.set(a, p); p += a.length; } return o; };
  const eq = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);

  /* ---------- MD5 ---------- */
  const MD5K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
  const MD5S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  function md5(data) {
    const len = data.length, n = (((len + 8) >> 6) + 1) * 64, buf = new Uint8Array(n);
    buf.set(data); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(n - 8, (len * 8) >>> 0, true); dv.setUint32(n - 4, Math.floor(len / 2 ** 29), true);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < n; off += 64) {
      for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + 4 * j, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + MD5K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        const s = MD5S[(i >> 4) * 4 + (i & 3)];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16), ov = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((w, i) => ov.setInt32(4 * i, w, true));
    return out;
  }

  /* ---------- RC4 ---------- */
  function rc4(key, data) {
    const s = new Uint8Array(256).map((_, i) => i), out = new Uint8Array(data.length);
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
      out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
  }

  /* ---------- AES (decryption, CBC) ---------- */
  const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
  (() => {
    const rotl = (x, s) => ((x << s) | (x >> (8 - s))) & 255;
    let p = 1, q = 1;
    do {
      p = p ^ ((p << 1) & 255) ^ (p & 0x80 ? 0x1b : 0);
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255; if (q & 0x80) q ^= 0x09;
      const x = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
      SBOX[p] = x; INV[x] = p;
    } while (p !== 1);
    SBOX[0] = 0x63; INV[0x63] = 0;
  })();
  const gmul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = (a << 1) ^ (a & 0x80 ? 0x11b : 0); b >>= 1; } return r; };
  const M9 = new Uint8Array(256).map((_, i) => gmul(i, 9)), M11 = new Uint8Array(256).map((_, i) => gmul(i, 11)),
    M13 = new Uint8Array(256).map((_, i) => gmul(i, 13)), M14 = new Uint8Array(256).map((_, i) => gmul(i, 14));
  function expandKey(key) {
    const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1));
    w.set(key);
    for (let i = nk, rcon = 1; i < 4 * (nr + 1); i++) {
      let t = w.slice(4 * (i - 1), 4 * i);
      if (i % nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = gmul(rcon, 2); }
      else if (nk > 6 && i % nk === 4) t = t.map(x => SBOX[x]);
      for (let j = 0; j < 4; j++) w[4 * i + j] = w[4 * (i - nk) + j] ^ t[j];
    }
    return { w, nr };
  }
  function decryptBlock({ w, nr }, s) {                 // in place, 16 bytes
    const t = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] ^= w[16 * nr + i];
    for (let r = nr - 1; r >= 0; r--) {
      for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[row + 4 * ((c + row) % 4)] = INV[s[row + 4 * c]];
      for (let i = 0; i < 16; i++) s[i] = t[i] ^ w[16 * r + i];
      if (r === 0) break;
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        s[c] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
        s[c + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
        s[c + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
        s[c + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
      }
    }
  }
  function aesCbcDecrypt(key, iv, data, unpad) {
    const k = expandKey(key), n = data.length - (data.length % 16), out = new Uint8Array(n);
    let prev = iv;
    for (let off = 0; off < n; off += 16) {
      const blk = data.slice(off, off + 16), c = blk.slice();
      decryptBlock(k, blk);
      for (let i = 0; i < 16; i++) out[off + i] = blk[i] ^ prev[i];
      prev = c;
    }
    if (unpad && n) {
      const p = out[n - 1];
      if (p >= 1 && p <= 16 && out.subarray(n - p).every(x => x === p)) return out.subarray(0, n - p);
    }
    return out;
  }
  const aesPdf = (key, data) => data.length < 16 ? new Uint8Array(0) : aesCbcDecrypt(key, data.subarray(0, 16), data.subarray(16), true);

  /* ---------- SHA-2 / AES encryption for revision 5-6 (WebCrypto) ---------- */
  const sha = async (bits, data) => new Uint8Array(await crypto.subtle.digest('SHA-' + bits, data));
  async function aes128CbcEncryptNoPad(key, iv, data) {
    const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data)).subarray(0, data.length);
  }
  async function hashR6(pw, salt, udata) {               // ISO 32000-2, algorithm 2.B
    let k = await sha(256, cat(pw, salt, udata));
    for (let i = 0; ; ) {
      const k1 = cat(pw, k, udata), big = new Uint8Array(k1.length * 64);
      for (let j = 0; j < 64; j++) big.set(k1, j * k1.length);
      const e = await aes128CbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), big);
      let m = 0; for (let j = 0; j < 16; j++) m += e[j];
      k = await sha([256, 384, 512][m % 3], e);
      i++;
      if (i >= 64 && e[e.length - 1] <= i - 32) break;
    }
    return k.subarray(0, 32);
  }

  /* ---------- key derivation ---------- */
  const bytesOf = o => (o instanceof PDFString || o instanceof PDFHexString) ? o.asBytes() : new Uint8Array(0);
  const num = (d, k, def) => { const v = d.lookup(PDFName.of(k)); return v instanceof PDFNumber ? v.asNumber() : def; };

  async function fileKey(enc, ctx, password) {
    const R = num(enc, 'R', 2), V = num(enc, 'V', 0);
    const O = bytesOf(enc.lookup(PDFName.of('O'))), U = bytesOf(enc.lookup(PDFName.of('U')));
    if (R >= 5) {
      const pw = new TextEncoder().encode(password).subarray(0, 127);
      const h = (p, salt, ud) => R === 5 ? sha(256, cat(p, salt, ud)).then(x => x.subarray(0, 32)) : hashR6(p, salt, ud);
      const zero = new Uint8Array(16), u48 = U.subarray(0, 48);
      if (eq(await h(pw, O.subarray(32, 40), u48), O, 32))
        return aesCbcDecrypt(await h(pw, O.subarray(40, 48), u48), zero, bytesOf(enc.lookup(PDFName.of('OE'))), false);
      if (eq(await h(pw, U.subarray(32, 40), new Uint8Array(0)), U, 32))
        return aesCbcDecrypt(await h(pw, U.subarray(40, 48), new Uint8Array(0)), zero, bytesOf(enc.lookup(PDFName.of('UE'))), false);
      throw new Error('PASSWORD');
    }
    const P = num(enc, 'P', 0), n = R === 2 ? 5 : Math.min(16, Math.max(5, (num(enc, 'Length', 40) / 8) | 0));
    const idArr = ctx.lookup(ctx.trailerInfo.ID);
    const id0 = idArr instanceof PDFArray && idArr.size() ? bytesOf(idArr.lookup(0)) : new Uint8Array(0);
    const encMeta = enc.lookup(PDFName.of('EncryptMetadata'));
    const padPw = pw => cat(pw.subarray(0, 32), PAD.subarray(0, 32 - Math.min(32, pw.length)));
    const keyFor = userPw => {
      let h = md5(cat(padPw(userPw), O.subarray(0, 32), new Uint8Array([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >> 24) & 255]), id0,
        R >= 4 && encMeta instanceof PDFBool && !encMeta.asBoolean() ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
      if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
      return h.subarray(0, n);
    };
    const xorKey = (k, i) => k.map(x => x ^ i);
    const checkUser = key => {
      if (R === 2) return eq(rc4(key, PAD), U, 32);
      let x = rc4(key, md5(cat(PAD, id0)));
      for (let i = 1; i <= 19; i++) x = rc4(xorKey(key, i), x);
      return eq(x, U, 16);
    };
    const pw = Uint8Array.from(password, c => c.charCodeAt(0) & 255);
    let key = keyFor(pw);
    if (checkUser(key)) return key;
    let ok = md5(padPw(pw));                             // try it as the owner password (algorithm 7)
    if (R >= 3) for (let i = 0; i < 50; i++) ok = md5(ok);
    ok = ok.subarray(0, n);
    let up = O.subarray(0, 32);
    if (R === 2) up = rc4(ok, up); else for (let i = 19; i >= 0; i--) up = rc4(xorKey(ok, i), up);
    key = keyFor(up);
    if (checkUser(key)) return key;
    throw new Error('PASSWORD');
  }

  // -> {str, stm}: functions (bytes, objNum, gen) -> bytes; null means "leave as is"
  function ciphers(enc, key) {
    const V = num(enc, 'V', 0);
    const objKey = (num_, gen, aes) => md5(cat(key, new Uint8Array([num_ & 255, (num_ >> 8) & 255, (num_ >> 16) & 255, gen & 255, (gen >> 8) & 255]),
      aes ? new Uint8Array([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0))).subarray(0, Math.min(key.length + 5, 16));
    const byMethod = m => m === 'None' ? null
      : m === 'AESV3' ? (b => aesPdf(key, b))
        : m === 'AESV2' ? ((b, n, g) => aesPdf(objKey(n, g, true), b))
          : ((b, n, g) => rc4(objKey(n, g, false), b));
    if (V < 4) return { str: byMethod('V2'), stm: byMethod('V2') };
    const cf = enc.lookup(PDFName.of('CF'));
    const method = name => {
      const nm = name instanceof PDFName ? name.decodeText() : 'Identity';
      if (nm === 'Identity') return null;
      const d = cf instanceof PDFDict ? cf.lookup(PDFName.of(nm)) : null;
      const m = d instanceof PDFDict ? d.lookup(PDFName.of('CFM')) : null;
      return byMethod(m instanceof PDFName ? m.decodeText() : 'None');
    };
    return { str: method(enc.lookup(PDFName.of('StrF'))), stm: method(enc.lookup(PDFName.of('StmF'))) };
  }

  /* ---------- object stream capture ---------- */
  // pdf-lib expands object streams while parsing, before we know the key. For our parser's context,
  // record them (with their object number) instead, and expand them after decrypting.
  const capture = new WeakMap();                        // PDFContext -> (stream) => void
  const origForStream = PDFObjectStreamParser.forStream;
  PDFObjectStreamParser.forStream = function (stream, ...rest) {
    const h = stream && stream.dict && capture.get(stream.dict.context);
    return h ? { parseIntoContext: async () => h(stream) } : origForStream.call(this, stream, ...rest);
  };

  async function load(bytes, password = '') {
    const parser = PDFParser.forBytesWithOptions(bytes, Infinity, false, false);
    const ctx = parser.context, order = new Map(), objStms = [];
    let seq = 0, lastRef = null;
    const header = parser.parseIndirectObjectHeader;
    parser.parseIndirectObjectHeader = function () { return (lastRef = header.call(this)); };
    ctx.assign = function (ref, obj) { order.set(ref.tag, seq++); return PDFLib.PDFContext.prototype.assign.call(this, ref, obj); };
    capture.set(ctx, stream => objStms.push({ ref: lastRef, stream, seq: seq++ }));
    try { await parser.parseDocument(); } finally { capture.delete(ctx); delete ctx.assign; }

    const encRef = ctx.trailerInfo.Encrypt, enc = ctx.lookup(encRef);
    if (enc instanceof PDFDict) {
      const filter = enc.lookup(PDFName.of('Filter'));
      if (!(filter instanceof PDFName) || filter.decodeText() !== 'Standard') throw new Error('ENCRYPTED');
      const key = await fileKey(enc, ctx, password), { str, stm } = ciphers(enc, key);
      const encMeta = enc.lookup(PDFName.of('EncryptMetadata'));
      const skipMeta = encMeta instanceof PDFBool && !encMeta.asBoolean();
      const decStr = (o, n, g) => str ? PDFHexString.of(hex(str(o.asBytes(), n, g))) : o;
      const walk = (o, n, g) => {
        if (o instanceof PDFString || o instanceof PDFHexString) return decStr(o, n, g);
        if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i), d = walk(v, n, g); if (d !== v) o.set(i, d); } }
        else if (o instanceof PDFDict) {
          const sig = o.has(PDFName.of('ByteRange'));    // signature /Contents are never encrypted
          for (const [k, v] of o.entries()) { if (sig && k.decodeText() === 'Contents') continue; const d = walk(v, n, g); if (d !== v) o.set(k, d); }
        } else if (o instanceof PDFStream) walk(o.dict, n, g);
        return o;
      };
      const decStream = (s, n, g) => {
        const type = s.dict.lookup(PDFName.of('Type'));
        if (type === PDFName.of('XRef') || (skipMeta && type === PDFName.of('Metadata'))) return;
        let f = s.dict.lookup(PDFName.of('Filter'));
        if (f === PDFName.of('Crypt') || (f instanceof PDFArray && f.lookup(0) === PDFName.of('Crypt'))) return;  // own crypt filter: rare, leave
        if (stm) s.contents = stm(s.contents, n, g);
      };
      for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (ref === encRef) continue;
        walk(obj, ref.objectNumber, ref.generationNumber);
        if (obj instanceof PDFRawStream) decStream(obj, ref.objectNumber, ref.generationNumber);
      }
      for (const { ref, stream } of objStms) if (ref) decStream(stream, ref.objectNumber, ref.generationNumber);
      if (encRef instanceof PDFLib.PDFRef) ctx.delete(encRef);
      delete ctx.trailerInfo.Encrypt;
    }
    for (const { stream, seq: s } of objStms) {         // a later object in the file wins, as in pdf-lib
      ctx.assign = function (ref, obj) {
        if ((order.get(ref.tag) ?? -1) > s) return;
        order.set(ref.tag, s); return PDFLib.PDFContext.prototype.assign.call(this, ref, obj);
      };
      try { await origForStream.call(PDFObjectStreamParser, stream, () => false).parseIntoContext(); } finally { delete ctx.assign; }
    }
    return new PDFDocument(ctx, false, true);
  }

  return { load, _test: { md5, rc4, aesCbcDecrypt } };
})();
