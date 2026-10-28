# Gajae Code Desktop

## Workflow: greenfield selected references

Reference: https://developers.openai.com/codex/app/ (retrieved 2026-10-27; redirects to https://learn.chatgpt.com/docs/app). Translate project organization, parallel conversations, long-running work and reviewable outputs into a first-party GJC interface. The user requests Codex-style interaction, not copied branding/assets.

## Layout

Muted 264px left sidebar groups conversations by project, displaying running/waiting/error independently of selection. Compact toolbar names the selected project/session. Central conversation reading column and sticky bottom composer. Optional right changed-files/diff pane. Settings and command navigation require no terminal. Empty states offer a single primary action.

## Tokens

System sans-serif, 14px base, line-height 1.55; monospace for paths/diffs/output. Warm backgrounds #faf9f6 main, #f0efeb sidebar, #ffffff cards; text #242424, muted #64645f, border #deddd7, accent #23694f, error #a42f35. Dark colors #191a19/#222421/#2b2e29, text #eceee7, muted #b3b7ab, border #42473d. Spacing 4/8/12/16/24/32px. Radius 8px controls, 14px composer/cards. Lucide icons with accessible labels. Text contrast >=4.5:1. No decorative gradients or oversized hero copy.

## Components and showcase

Create ?showcase before broad screens: session row, toolbar button, composer, message, tool disclosure, question card, error banner, settings fields. Include realistic long paths, Korean/mixed-language text, empty/loading/disabled/error/selected/running/waiting states. Fixtures only in showcase, never product fallbacks. Missing upstream capabilities are visibly unavailable, never successful no-ops.

## States and accessibility

Operations expose pending/failure, preserve drafts on failure, prevent duplicate submissions. Disconnected is not idle. Selected sidebar rows and execution states remain independently visible. Questions resolve real SDK requests. Visible 2px focus rings, semantic buttons/forms, labeled inputs. Dialogs support Escape, focus containment and trigger restoration. Streaming announcements are bounded and polite. Paths wrap anywhere; Korean prose uses word-break:keep-all. Follow scrolling only when already near bottom; bound long output/history.

## Motion and depth

120ms color/opacity transitions, reduced-motion support, one soft overlay shadow; no per-token animation.

## Responsive

Review pane alongside conversation at >=1100px, drawer below. Sidebar collapses below 760px. Minimum native window 720x520; showcase also tests narrow web layout and 200% text scaling. Composer/toolbars wrap, never horizontal page overflow.

## Ownership

The app's catalog, transcripts and logs live under its desktop data root. Agent configuration, credentials, model profiles and the default preset share the terminal installation by default; `GJC_DESKTOP_ISOLATED=1` gives tests/QA an isolated install. Initial target macOS 15+ arm64 (WebView must support Promise.withResolvers). Closing last window hides app while tasks continue; explicit Quit cancels/disposes owned work. #7322 owns upstream parity; consume public SDK, never private endpoints or terminal controllers. Expose unavailable capabilities truthfully pending upstream implementation.

## Account authorization

The app uses public AuthStorage login callbacks with a single app-owned authorization flow. Provider selection, an explicit HTTPS-only system-browser action, optional code prompts, cancellation and reopening settings are supported. Prompt answers are never persisted in frontend storage. Cancellation does not undo credentials a provider already saved; an uncooperative provider may require Quit and relaunch before another login. This is not proof of a completed real-provider login.

Before the SDK captures environment state, the sidecar strips inherited provider keys/tokens, routing/proxy overrides and CLI broker state. Shared mode restores the installation's HOME and resolved agent directory (including explicit agent-directory overrides); credentials remain in the SDK's shared storage, not a new Keychain implementation. `GJC_DESKTOP_ISOLATED=1` instead places HOME, agent, configuration and XDG roots under the app data directory for tests/QA. Neither mode is an execution sandbox for SDK tools.

## Verification

Fresh current-branch screenshots for implemented surfaces/states/breakpoints and scroll boundaries, CJK wrapping inspection, independent review. Compilation is not evidence of signed standalone distribution, real-provider login or full TUI parity.
