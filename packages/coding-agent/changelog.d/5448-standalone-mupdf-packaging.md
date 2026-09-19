### Fixed

- Standalone builds now package MuPDF and its WASM asset for PDF extraction instead of requiring a globally installed module (#5433); npm/Bun package tarballs include the pinned patched converter and declare its matching runtime dependencies. Short and attachment-named PDFs are accepted as readable text, authoritative non-PDF MIME types retain their handlers, and failed or empty extraction reports a failed inspection rather than raw bytes. Tool diagnostics keep local dependency paths private while debug logs retain provenance. Explicit raw reads remain available.
