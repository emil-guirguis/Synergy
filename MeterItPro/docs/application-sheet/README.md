# MeterIt Pro — Application Sheet

Product spec / cut sheet for MeterIt Pro (electricity meter management platform).

## Revisions
- **Rev B** (`*-RevB.*`) — current. Working revision.
- **Rev A** (no suffix) — original, kept as archive. Do not edit.

Both revisions are published on the app's Documentation page; the Vite `docs-plugin`
copies every file in this folder into `dist/docs/`, so a new format appears on the
site as soon as it is committed. The `images/` folder is a directory and is skipped
by that copy — it holds the screenshots extracted from the HTML (`images/originals/`
keeps the pre-edit versions) so they can be re-worked and re-embedded.

## Files
- `MeterItPro-Application-Sheet.html` — self-contained page. All screenshots and
  product photos are embedded as base64 data URIs, so it opens offline with no
  external assets. Print-friendly (A4, colored bands via `print-color-adjust`).
- `MeterItPro-Application-Sheet.pdf` — exported PDF (headless Chrome).

## Contents (9 sections)
1. Overview · 2. Core capabilities · 3. Meters & registers · 4. Metering data captured
5. Dashboards & analytics · 6. Alerts & notifications · 7. Zenith AI assistant
8. On-site Sync Server (Linux, BACnet/IP, offline resilience) · 9. Specifications

## Regenerate the PDF
Open the HTML in a browser and Print → Save as PDF (enable "Background graphics"),
or headless Chrome:

```sh
chrome --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="MeterItPro-Application-Sheet.pdf" \
  "file:///ABSOLUTE/PATH/MeterItPro-Application-Sheet.html"
```

## Editing
Edit the HTML directly. Screenshots are inline data URIs; to swap one, replace the
matching `data:image/...` string (each `<img>` has a descriptive `alt`).
