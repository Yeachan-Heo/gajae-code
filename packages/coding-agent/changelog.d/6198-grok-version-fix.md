### Fixed

- **Grok CLI version management**: Defaults the client version to xAI's known minimum, 1.0.13. When xAI responds with HTTP 426 and a newer required version, retries the request once with that version and keeps it for subsequent requests. Learned minimums never downgrade, even when responses arrive out of order.
