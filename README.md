# Flip PDF

Turn any PDF (your novel, a magazine, a portfolio) into a flippable book.
Free, runs fully on your device, no uploads, no watermark, no page limit.

## Three ways to read (button in the top bar, or press `M`)
- **Two-page book**: realistic spread with a page-curl. Default on desktop.
- **Single page (curl)**: one page at a time with the curl animation.
- **Reader**: Kindle-style. One page at a time, swipe left/right (or tap the left/right edge). Default on phones.

## Run it on your computer
- **Windows:** double-click `start.bat`
- **Mac / Linux:** run `./start.sh`

Opens http://localhost:8765. Needs Python 3 or Node.js (either one). pdf.js and StPageFlip are bundled in `vendor/`, so it works offline.

## Use it
1. Drop your PDF on the page (or click **Choose a PDF**).
2. Navigate: drag a page corner, swipe, tap the arrows, or use the keyboard
   `←` `→` `Space` `PgUp` `PgDn` `Home` `End`. `F` fullscreen, `M` view, `T` light/dark.
3. It remembers where you stopped reading in each file.
4. **Export flipbook** saves ONE self-contained `.html` file with the whole book inside
   (two-page curl viewer). Send it to anyone or host it anywhere. On phones it opens the share sheet.

## Deploy to Cloudflare (so you can use it on your phone)
No build step; the repo root is the site.
- **Workers / "Import a repository" flow:** pick this repo, leave the build command empty,
  deploy command `npx wrangler deploy` (reads `wrangler.jsonc`; `.assetsignore` keeps server scripts out).
- **Pages flow:** Create → Pages → Connect to Git → this repo, framework "None", build command empty,
  output directory `/`. `_headers` sets sensible caching.

Every push to `main` redeploys. The app is 100% client-side: PDFs never leave the device.

## Install as an app (PWA)
Open the deployed URL on your phone:
- **Android (Chrome):** menu → *Install app* (or the *Install app* button in the top bar).
  Once installed, you can also share a PDF to it from Files / WhatsApp / Gmail via *Share → Flip PDF*.
- **iPhone (Safari):** Share → *Add to Home Screen*.

It then opens full-screen and works offline. When you change app files, bump `VERSION` in `sw.js`
so installed copies refresh.

## Notes
- **Quality** (bottom bar): Light/Standard/High/Max. Phones default to Light and only keep ~20 pages around
  the current one in memory, so big novels stay smooth.
- Pages are images, so text isn't selectable (layout stays exact).
- Don't open `index.html` by double-clicking; browsers block the PDF engine on `file://`. Use the start script.
- Libraries: pdf.js (Apache-2.0, legacy build for wide browser support), StPageFlip (MIT).
