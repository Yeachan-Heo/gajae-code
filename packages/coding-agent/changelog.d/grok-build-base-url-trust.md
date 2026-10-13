### Fixed

- Grok Build ignores a project dotenv declaration of its credential base URL and unsafe opt-in, including a quoted value whose suffix follows the closing quote and a quoted value that keeps spaces inside the quotes. Other repository `.env` entries are unchanged.
