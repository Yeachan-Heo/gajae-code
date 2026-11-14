### Added

- Add private desktop and desktop-host monorepo workspaces with a Tauri 2/React interface and bundled Bun public-SDK host.
- Add project-grouped session navigation, session persistence, model/API-key settings, portable questions, tool and goal controls, and Git diff review.
- Add isolated-host regression tests, a component showcase, and an Ego-compatible real-host QA bridge.
- Add public-SDK account authorization callbacks with provider selection, explicit HTTPS browser opening, code prompts, cancellation and app-owned credential state. Isolate inherited provider credentials and routing before SDK imports.

### Changed

- Route desktop preferences, composer/HUD, activity/MCP, managed Bash/Python, frozen side conversations and working-tree diff through the public SDK; retain Tauri IPC only as an app-local bridge.
- Construct local storage and extension UI through the SDK embedding lifecycle, with an uncatalogued in-memory SDK owner for application-wide configuration and authorization.
- Preserve side-conversation provider cleanup uncertainty and block another question until settlement; withhold truncated operator output when boundary-safe secret redaction cannot be proven.
- Guard production app imports against coding-agent internals, terminal completion providers and legacy RPC control paths; run the complete desktop-host regression suite by default.

### Notes

- Initial packaging targets macOS 15+ arm64. Full TUI parity, real-provider authorization/native-WebView verification, and notarized distribution are not certified by the local bridge tests. The compiled host retains narrowly scoped CLI/shell-worker bootstrap imports because SDK subprocesses reenter the host executable; these are not external control APIs.
