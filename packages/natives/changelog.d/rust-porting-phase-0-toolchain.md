### Changed

- Build the native addon with Rust `nightly-2026-08-12` and align shared Cargo dependencies with the pinned upstream tracked in `docs/rust-porting-inventory.md` (html-to-markdown-rs 3.x, icy_sixel 0.7, brush-parser 0.4, phf 0.14, similar 3.2, smallvec 1.16, dashmap 6.2, tree-sitter-cmake 0.7.5, tree-sitter-r 1.3, syntect with bundled themes and YAML syntax loading).
- `htmlToMarkdown` now uses html-to-markdown-rs 3.x and fails with `Conversion error` when the document exceeds the converter's nesting depth, instead of returning truncated markdown.
- `encodeSixel` output now starts with a SIXEL raster-attributes header (`"1;1;<width>;<height>`), so terminals size the image before drawing it.
