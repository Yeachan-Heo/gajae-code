# UI language

Human-facing interactive chrome can render in English or Korean. Canonical persisted values are only `en` and `ko`. Commands, flags, environment variables, JSON, and other protocol output stay in English.

Primary implementation: `packages/coding-agent/src/modes/ui-language.ts`. Setting: `ui.language` in `packages/coding-agent/src/config/settings-schema.ts` (global-only; workspace config and runtime overrides cannot change it).

## Interactive switching (`/language`)

- `/language` with no arguments reports the current language and the available codes.
- `/language <value>` persists `ui.language` and confirms in the selected language. Accepted spellings:
  - canonical codes: `en`, `ko`
  - locale tags whose language subtag is one of those codes: `en-US`, `ko-KR`
  - English names: `english`, `korean`
  - Korean endonym: `한국어`
  - common aliases: `eng`, `kr`, `kor`
- An unsupported value (`fr`, `ja`, …) is rejected with the available list and changes nothing.
- Durable-config failures use the same `config.yml` repair guidance as `/theme`.
- `/language` is TUI-only (visual/local). It is not an SDK control seam.

The settings Appearance tab exposes the same `en` / `ko` selector.

## Onboarding detection

`/tutorial` and first-run onboarding may still choose copy from a larger catalog (`en`, `ko`, `ja`, `zh`, `es`, `fr`, `de`) based on transcript evidence and the OS locale. That catalog is display-only for onboarding and is not added to the persisted `ui.language` enum.

Detection rules:

- An explicit `ui.language` selection outranks messages and locale.
- Latin function words match on token boundaries, never substrings.
- Korean / Japanese / Chinese are scored by script ranges. Japanese kana claims mixed kanji so Chinese does not win on han characters alone.
- Script counts and word hits share one ranking. A language needs at least two matches and must beat the runner-up outright; ties fall back to the OS locale, then English.
