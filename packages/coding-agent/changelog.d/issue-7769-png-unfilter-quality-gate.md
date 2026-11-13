### Fixed

- The quality-gate screenshot check no longer rejects real screenshots of mostly-white pages. It measured PNG-filtered scanline bytes, where flat white encodes as long `0x00` runs; it now decodes the rows (filter types 0-4) and measures pixels. Blank and solid captures still fail, and malformed PNG data is rejected. ([#7769](https://github.com/Yeachan-Heo/gajae-code/issues/7769))
