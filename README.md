# Fill PDF

Static, client-side PDF form filler: type text (normal or bold), tick or cross boxes, add a typed signature in a handwriting style, combine several PDFs (drag files onto the page list, drag pages to reorder, remove pages), select and copy the PDF's text with the Select tool, redact text (draw a box, or *Find and redact* to catch every occurrence of e.g. a SIN), then save.
Files never leave the browser. Live at https://pdf.samankeon.com.

Built on [pdf.js](https://github.com/mozilla/pdf.js) (display) and [pdf-lib](https://github.com/Hopding/pdf-lib) (save).
Copies of both live in `lib/` under their own licenses (Apache-2.0 and MIT). Signature fonts live in `fonts/` (see `fonts/LICENSES.md`).

## Run locally
`./run.sh` serves the folder on http://127.0.0.1:8765

## Deploy
Deploys are manual, with wrangler, to the Cloudflare Pages project `fill-pdf`. Stage only the site files, then deploy:
```sh
rm -rf /tmp/fill-pdf-dist && mkdir /tmp/fill-pdf-dist
cp -r index.html app.js redact.js styles.css favicon.svg _headers lib fonts /tmp/fill-pdf-dist/
npx wrangler@4 pages deploy /tmp/fill-pdf-dist --project-name fill-pdf --branch main
```
Keep this file list (and the one in `.github/workflows/deploy.yml`) in sync with everything `index.html` loads.
The GitHub workflow runs on pushes to `main`, but it needs the repository secrets
`CLOUDFLARE_API_TOKEN` (*Account > Cloudflare Pages > Edit*) and `CLOUDFLARE_ACCOUNT_ID` and currently fails.

Security headers (CSP etc.) are in `_headers`.

## Notes
- Redaction (`redact.js`) is real: the glyphs under each box are deleted from the page's content stream (and from form XObjects it draws), with a spacing adjustment so the rest of the line keeps its position and stays selectable text. Form fields, comments and links overlapping a box are removed. The saved file is rebuilt from the pages, so the old content, metadata, bookmarks and the interactive form are not carried over.
- Redaction limits: images (scans) under a box are covered but not altered, and the app warns when that happens. Text drawn as vector outlines is not detected. If a form XObject (e.g. a repeated header) is redacted, the same text disappears wherever else it is drawn.
- Encrypted PDFs (`decrypt.js`): restricted or password-protected files (RC4, AES-128, AES-256) are decrypted in the browser when saving, and the saved copy has no encryption or restrictions. The open password is asked for once when the file is opened. Certificate-based (public key) encryption is not supported.
- pdf.js runs with `isEvalSupported:false` (mitigates CVE-2024-4367). Upgrade to >= 4.2.67 when convenient.
- Page rotation: items are stored in the page's unrotated coordinates with the angle they were placed at, so they turn with the page (like ink on paper), and new items are always upright on screen.
- Form fields: pdf.js draws the PDF's own fields as real inputs (`AnnotationLayer`), and `saveDocument()` writes the values with their appearance before pdf-lib adds the overlays. Field scripts (calculations, formatting) are not run. Values are kept in progress files.
- Text: plain Latin text uses Helvetica (no font embedded). Other text embeds a subset of Noto Sans (Latin, Greek, Cyrillic, Vietnamese) or Vazirmatn (Persian, Arabic; shaped by fontkit, with a simplified Unicode bidi for mixed lines). Any other script (Chinese, Hebrew, emoji, …) is saved as a sharp image of the text. fontkit and the font files are loaded only when needed.
- Rendering: pages are drawn one at a time, nearest to the view first; pages far from the view release their pictures, and canvases are capped at 16 MP. Zooming changes one transform per page and re-renders only what is on screen. Thumbnails reuse the page picture when there is one. Saving parses and writes at full speed (no yielding).
- Plain PDFs only (not XFA).
