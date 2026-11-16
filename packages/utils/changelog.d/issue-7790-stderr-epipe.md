### Fixed

- A direct `process.stderr.write` whose reader has gone away (`EPIPE`/`EIO`/`EBADF`, e.g. a closed console on Windows or `gjc ... 2>&1 | head`) now exits quietly with the broken-pipe status 141 instead of being recorded and reported as a crash, matching the existing stdout handling ([#7790](https://github.com/Yeachan-Heo/gajae-code/issues/7790)).
