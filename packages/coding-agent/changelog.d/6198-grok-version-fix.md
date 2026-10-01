### Fixed

- **Grok CLI version management**: Fixed version resolution to properly fetch and cache the latest Grok CLI version from GitHub releases instead of always using the fallback version. Removed dead code in the 426 error handler that was unreachable due to type mismatch in the response callback. Made `streamGrokCli` async to allow proper awaiting of version fetching, ensuring clients always send the latest version header.
- **Grok CLI tests**: Fixed tests to mock network calls to GitHub instead of making real HTTP requests. All async operations are now properly awaited, and test assertions correctly validate the fetched version behavior.
