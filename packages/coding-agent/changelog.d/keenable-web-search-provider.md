### Added

- Added an optional Keenable `web_search` provider. Select it with `providers.webSearch = "keenable"` or list it in `web_search.fallback`. It works without an API key; `KEENABLE_API_KEY` (or a stored `keenable` credential) only raises rate limits. `auto` resolution and the DuckDuckGo terminal fallback are unchanged.
