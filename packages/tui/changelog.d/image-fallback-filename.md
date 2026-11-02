### Fixed

- Image fallback text strips terminal controls from the filename and media type before they are painted, so a hostile name cannot emit OSC, DCS, or C1 sequences on that line.
