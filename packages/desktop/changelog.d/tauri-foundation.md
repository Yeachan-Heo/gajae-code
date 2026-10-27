### Added

- Add private desktop and desktop-host monorepo workspaces with a Tauri 2/React interface and bundled Bun public-SDK host.
- Add project-grouped session navigation, session persistence, model/API-key settings, portable questions, tool and goal controls, and Git diff review.
- Add isolated-host regression tests, a component showcase, and an Ego-compatible real-host QA bridge.
- Add public-SDK account authorization callbacks with provider selection, explicit HTTPS browser opening, code prompts, cancellation and app-owned credential state. Isolate inherited provider credentials and routing before SDK imports.

### Notes

- Initial packaging targets macOS 15+ arm64. Full TUI parity, real-provider authorization/native-WebView verification, and notarized distribution are not complete. Missing upstream contracts are tracked in #7322 and are explicitly unavailable rather than emulated.
