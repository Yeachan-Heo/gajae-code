# UI language

Human-facing interactive chrome can render in English, Korean, Simplified Chinese, or Japanese. Canonical persisted values are `en`, `ko`, `zh`, and `ja`. Commands, flags, environment variables, JSON, and other protocol output stay in English.

Primary implementation: `packages/coding-agent/src/modes/ui-language.ts`. Setting: `ui.language` in `packages/coding-agent/src/config/settings-schema.ts` (global-only; workspace config and runtime overrides cannot change it).

## Interactive switching (`/language`)

- `/language` with no arguments reports the current language and the available codes.
- `/language <value>` persists `ui.language` and confirms in the selected language. Accepted spellings:
  - canonical codes: `en`, `ko`, `zh`, `ja`
  - locale tags whose language subtag is one of those codes: `en-US`, `ko-KR`, `zh-CN`, `ja-JP`
  - English names: `english`, `korean`, `chinese`, `japanese`
  - endonyms: `한국어`, `中文`, `简体中文`, `日本語`
  - common aliases: `eng`, `kr`, `kor`, `zh`, `jp`, `jpn`
- An unsupported value (`fr`, …) is rejected with the available list and changes nothing.
- Durable-config failures use the same `config.yml` repair guidance as `/theme`.
- `/language` is TUI-only (visual/local). It is not an SDK control seam.

The settings Appearance tab exposes the same `en` / `ko` / `zh` / `ja` selector.

`GJC_UI_LANGUAGE` is an optional session-only first-use onboarding preference. It accepts the same codes and locale tags, bypasses the first-use picker, and falls back to English without prompting when invalid. It does not change later interactive chrome; use `gjc config set ui.language <code>` or Settings for a durable preference.

## Onboarding detection

An explicit `ui.language` selection pins onboarding copy to the selected supported language. The remaining catalog entries are display-only for onboarding and are not added to the persisted `ui.language` enum.

Detection rules:

- An explicit `ui.language` selection outranks messages and locale.
- Latin function words match on token boundaries, never substrings.
- Korean / Japanese / Chinese are scored by script ranges. Japanese kana claims mixed kanji so Chinese does not win on han characters alone; a Hangul claimant needs at least two characters before it can claim mixed han text, so one stray Hangul glyph (or an equal lone Hangul/kana pair) does not erase dominant han evidence. A lone kana still claims mixed kanji as Japanese.
- Script counts and word hits share one ranking. A language needs at least two matches and must beat the runner-up outright; ties fall back to the OS locale, then English.
