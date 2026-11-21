### Changed

- Ship the desktop UI in English. Renderer copy now lives in a flat `as const` catalog under `src/i18n/en/` and is resolved through `t("area.key")`, so a missing key fails typecheck instead of rendering blank. Host-issued prose and protocol identifiers stay outside the catalog.
- Keep the locale seam open without shipping a half-translated language: the code set and persisted preference reuse the TUI's `en`/`ko`/`zh`/`ja` vocabulary, `t()` falls back to English when the active locale has no catalog, and only `en` is registered, so no language switch is offered yet.
- Use the Gajae-Code mascot as the app icon, the sidebar badge and the empty-state mark. `packages/desktop/icon.png` replaces the placeholder glyph and `bun run icons` regenerates the platform icons from it; the renderer shows a local tile and never fetches a remote image.
- Drop the repeated app name from the toolbar when no project is open.
- Keep model, reasoning, preset and role choices usable while a run is in progress: the request waits for the session to settle instead of the control refusing the change, no sentence explains the timing, and a rejected request shows its error in the model controls and in the preferences dialog.
- Show one human label instead of a label followed by its raw protocol token in the activity, session-info and settings surfaces.
