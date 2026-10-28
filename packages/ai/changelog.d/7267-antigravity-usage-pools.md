### Fixed

- Grouped Google Antigravity usage limits into their shared quota pools (`Claude / GPT-OSS`, `Gemini Argon`, and `Gemini`), classified 5-hour versus 7-day weekly reset windows, and registered an Antigravity ranking strategy so credential ranking and preference caps evaluate each model pool independently (#7267).
- Versioned the Google Antigravity usage-report cache identity (`|schema:2`) so cache rows written before the 5h/7d window split and quota-pool separation are never read back by a newer binary; provider-scoped cache purges still match both key shapes (#7267).
