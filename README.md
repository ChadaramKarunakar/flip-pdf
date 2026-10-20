# Flip PDF

Turn any PDF (your novel, a magazine, a portfolio) into a realistic page-flip book.
Free, runs fully on your computer, no uploads, no watermark, no page limit.

## Start it
- **Windows:** double-click `start.bat`
- **Mac / Linux:** run `./start.sh`

It opens http://localhost:8765 in your browser. Needs Python 3 or Node.js installed (either one).
Everything else (pdf.js + StPageFlip) is bundled in `vendor/`, so it works offline.

## Use it
1. Drop your PDF on the page (or click **Choose a PDF**).
2. Flip by dragging a page corner, clicking the arrows, or with the keyboard:
   `←` `→` `Space` `PgUp` `PgDn` `Home` `End`, `F` fullscreen, `M` single/spread, `T` light/dark.
3. It remembers where you stopped reading for each file.
4. **Export flipbook** saves ONE self-contained `.html` file with the whole book inside.
   Send it to anyone, or upload it to Netlify / GitHub Pages / your own site.

## Notes
- **Quality** (bottom bar): Standard is fine for screens; High/Max are sharper but make bigger exports.
- Pages are shown as images, so text is not selectable in the flipbook (layout stays exact).
- Don't open `index.html` by double-clicking; the browser blocks the PDF engine on `file://`. Use the start script.
- Libraries: pdf.js (Apache-2.0), StPageFlip (MIT).
