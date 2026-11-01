### Changed

- Move every control, card, panel and overlay onto one soft, rounded scale (`--radius-xs` through `--radius-pill`) with soft borders, inset surfaces and a shallow shadow, so the app reads calmer without changing its layout or palette system.
- Give inputs, buttons and session rows the same 10px radius; tabs and nested cards (MCP servers, session info, btw turns, empty states) use 13px; panels, user messages, question cards and the composer use 16px; the modal uses 20px. Replace the hard focus outline on fields with an accent border plus a tinted halo, keep a visible ring on checkboxes and in forced-colors mode, and let the composer textarea sit flat inside its card.
- Rebuild the settings dialog as four tabs — General, Account, Runtime, Capabilities — instead of one long scroll. Each block gets a heading and one explanatory line, the tab bar stays pinned while the panel scrolls, arrow/Home/End keys move focus and selection, and reopening returns to General.
- Route the provider entry points to the Account tab so "Add provider" and "Configure providers" land on the form they name.
- Use the same surface-and-pill tab pattern in the model picker and the settings dialog.
