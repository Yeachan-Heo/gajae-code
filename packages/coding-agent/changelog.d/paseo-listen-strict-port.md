### Fixed
- Paseo listener parsing (`PASEO_HOST`, `PASEO_LISTEN`, pid file, `daemon.listen`) now requires a plain decimal port in `host:port` spellings. Hex (`0x1A0B`), exponent (`1e3`), decimal (`6767.0`) or padded ports were coerced by `Number()`, so GJC probed a different port than the raw value it handed to `paseo import`.
