### Fixed
- Match macOS Dock and Finder icon sizing with a centered 824 px illustration on the 1024 px app-icon canvas, retaining transparent outer margins without changing in-app branding.
- Keep artwork inside a smooth rounded tile so macOS renders it at native size instead of shrinking it onto an extra white fallback plate.
- Include generated app icons explicitly in Tauri bundles so macOS packages ship their ICNS resource and icon metadata.
