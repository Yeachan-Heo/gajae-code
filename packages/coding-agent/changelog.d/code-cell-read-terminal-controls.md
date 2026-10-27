### Fixed

- Code cells strip terminal control sequences from source bytes before rendering, so a file read cannot write OSC, CSI, or DCS to the operator terminal.
