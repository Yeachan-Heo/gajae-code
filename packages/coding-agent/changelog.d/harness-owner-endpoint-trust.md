### Fixed

- The harness owner ignores a parsed SDK discovery record unless it is a loopback origin for this session, requires a recorded pid to be live when one is present, starts the real session when that check fails, and propagates an error from the first discovery read.
