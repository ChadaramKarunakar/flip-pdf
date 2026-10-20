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


## Library (v2)

Flip PDF is now a small book-reading app. Everything is stored **on your device** (IndexedDB), private and offline.

- **Library**: add one or many PDFs (button, drag & drop, share-to-app on phones). Covers are made from page 1, or set your own (image or any page of the PDF).
- **Organise**: shelves, tags, a category per book, favourites, 1–5 star rating; group by author / category / status; search by title, author, category or tag.
- **Status lists**: Reading, Read later, Finished (auto-updates as you read).
- **Wishlist**: books you want, with priority, note and link. "I have the PDF" moves it into the library.
- **Reading progress**: percentage = pages you actually visited (a page counts after you stay on it ~1 second).
- **Annotations**: bookmark pages (B), write page notes (N), highlight areas in four colours with optional comments (H, Reader view). Everything is collected under *Notes & bookmarks*.
- **Backup & restore**: export a `.zip` (with or without the PDFs) and restore it on another phone/computer. This is how to move your library between devices until cloud sync is added.

Storage layout lives behind `db.js`, so a Cloudflare (D1/R2) sync backend can later be added without touching the UI.

### Adding books from your device
A web app can't browse your storage silently, so Flip PDF uses a one-time permission:
- **Connect a folder** (Chrome / Edge on desktop; Chrome on Android where supported): pick e.g. *Downloads* or *Books* once. Each time you open the app it scans that folder (and sub-folders) and adds new PDFs automatically. If the browser asks again, tap *Allow & scan* on the banner.
- **Pick a folder once**, **Choose PDF files**, drag & drop, **Share → Flip PDF** on phones, or **Open with** on desktop.
- Books you delete are remembered so folder scans don't re-add them (*Add books → Bring back books I removed* undoes that).
