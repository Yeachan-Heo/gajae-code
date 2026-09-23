### Improved

- Reduced fetch-tool startup work by loading site-specific scraper handlers only when a non-raw fetch dispatches special URL handling. The startup-import probe now verifies dispatch still works and allows a cold Bun child import up to 30 seconds under CI shard contention.
