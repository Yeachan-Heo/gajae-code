### Fixed

- Reading a PDF that mixes text and scanned pages now prefixes the extracted Markdown with a warning listing pages that need OCR and any font-encoding issues, instead of presenting partial output as complete.
- Fetching a URL labeled `image/svg+xml` whose bytes cannot be rasterized now returns the invalid-image metadata result instead of failing the whole fetch.
