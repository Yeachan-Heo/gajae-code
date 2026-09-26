### Removed

- Remove MuPDF.js and its AGPL-3.0-or-later runtime and release-material build from PDF extraction in favor of the native MIT `pdf-inspector` implementation. Markit remains for DOCX, PPTX, XLSX, EPUB, and RTF conversion.

### Changed

- PDF Markdown now preserves explicit page markers and groups adjacent text runs. This accepted D6/D7 output-shape divergence is backed by the `pdf-native` golden corpus and differential tests; pages with no extracted text report the page numbers requiring OCR.
