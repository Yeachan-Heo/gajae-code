### Fixed

- A repository `.gjc/config.yml` or `.gjc/settings.json` can no longer set `searxng.endpoint` or replace the user SearXNG settings with a non-object value, and a runtime override cannot replace the user endpoint. Web search keeps the user config endpoint, or `SEARXNG_ENDPOINT` when that value is unset.
