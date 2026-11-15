# Fill PDF

Static, client-side PDF form filler: type text (normal or bold), tick or cross boxes, add a typed signature in a handwriting style, combine several PDFs (drag files onto the page list, drag pages to reorder, remove pages), select and copy the PDF's text with the Select tool, then save.
Files never leave the browser. Live at https://pdf.samankeon.com.

Built on [pdf.js](https://github.com/mozilla/pdf.js) (display) and [pdf-lib](https://github.com/Hopding/pdf-lib) (save).
Copies of both live in `lib/` under their own licenses (Apache-2.0 and MIT). Signature fonts live in `fonts/` (see `fonts/LICENSES.md`).

## Run locally
`./run.sh` serves the folder on http://127.0.0.1:8765

## Deploy
Pushing to `main`, or pushing a tag like `v1.2.0`, deploys to the Cloudflare Pages project `fill-pdf`
(`.github/workflows/deploy.yml`). Required repository secrets:
- `CLOUDFLARE_API_TOKEN`: an API token with *Account > Cloudflare Pages > Edit*
- `CLOUDFLARE_ACCOUNT_ID`

Security headers (CSP etc.) are in `_headers`.

## Notes
- Combining: encrypted (restricted) PDFs can be viewed but not saved or combined; print them to a new PDF first.
- pdf.js runs with `isEvalSupported:false` (mitigates CVE-2024-4367). Upgrade to >= 4.2.67 when convenient.
- Plain PDFs only (not XFA), unrotated pages, standard Helvetica text (WinAnsi characters).
