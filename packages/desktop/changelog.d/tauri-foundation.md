### Added

- Add private desktop and desktop-host monorepo workspaces with a Tauri 2/React interface and bundled Bun public-SDK host.
- Add project-grouped session navigation, session persistence, model/API-key settings, portable questions, tool and goal controls, and Git diff review.
- Add isolated-host regression tests, a component showcase, and an Ego-compatible real-host QA bridge.

### Notes

- Initial packaging targets macOS 15+ arm64. Full TUI parity, OAuth onboarding, live-provider/native-WebView verification, and notarized distribution are not complete. Missing upstream contracts are tracked in #7322 and are explicitly unavailable rather than emulated.
