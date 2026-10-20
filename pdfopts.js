// Shared pdf.js options. Fonts, CJK/Indic character maps and the JPEG2000/JBIG2/colour decoders
// are shipped with the app (vendor/…) so scanned books and PDFs with non-embedded fonts draw
// correctly, even offline. URLs must be absolute because pdf.js fetches them from inside its worker.
const abs = (p) => new URL(p, document.baseURI).href;
export const pdfParams = (data) => ({
  data,
  wasmUrl: abs('vendor/wasm/'),
  standardFontDataUrl: abs('vendor/standard_fonts/'),
  cMapUrl: abs('vendor/cmaps/'),
  cMapPacked: true,
  iccUrl: abs('vendor/iccs/'),
  useSystemFonts: true,
});
