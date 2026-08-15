Drives a real Chromium tab with full puppeteer access via JS execution.

<instruction>
- For static web content (articles, docs, issues/PRs, JSON, PDFs, feeds), prefer the `read` tool with a URL. Use this tool only when you need JS execution, authentication, or interactive actions.
- Four actions:
  - `open` — acquire (or reuse) a named tab. `name` defaults to `"main"`. Optional `url`, `viewport`, and `dialogs: "accept" | "dismiss"` (auto-handles `alert`/`confirm`/`beforeunload`). The `app` field selects the browser kind (spawned binary, saved Chrome profile, or existing CDP endpoint); omitted means headless Chromium with stealth patches.
  - `close` — release a tab by `name`, or every tab with `all: true`. `kill: true` also terminates a spawned-app process tree.
  - `act` — run a list of structured `actions` against an existing tab without writing JS (preferred for routine navigation/interaction). Each step is `{ verb, … }`; verbs: `navigate {url, wait_until?}`, `click {id|selector}`, `type {id|selector, text}`, `fill {selector, value}`, `select {selector, values}`, `press {key, selector?}`, `scroll {dx?, dy?}`, `back`, `wait {selector?|ms?}`, `observe {viewport_only?, include_all?}`, `extract {format?}`, `screenshot`. Address elements by the numeric `id` from a prior `observe` (preferred) or a selector. Steps run in order; the tool returns per-step results.
  - `run` — execute JS against an existing tab. `code` is the body of an async function with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. The return value is JSON-stringified into the tool result; `display(value)` calls accumulate text/images. Use `run` only when an `act` verb does not cover what you need.
- Tabs survive across `run` calls and across in-process subagents. Open once, reuse many times.
- Browser kinds: no `app` launches headless Chromium; `app.path` reuses CDP or kills stale same-path processes before spawning — NEVER use it for a daily Chrome profile; use explicit `app.browser: "chrome"` profile mode instead. In profile mode, `path` defaults to installed Chrome/Chromium and `profile_directory` defaults to `"Default"`, but `user_data_dir` must name a separate non-default Chrome data directory: Chrome 136+ disables remote debugging for its default data directory. Only Chrome/Chromium executables are admitted; Edge, Brave, Vivaldi, Opera, unknown browser brands, and default Chrome data roots are rejected. Use `app.cdp_url` to attach to an already-authorized browser. Saved-profile/CDP automation has access to that profile's cookies and authenticated accounts. Profile mode refuses a matching non-CDP Chrome instead of killing/relaunching it, and `kill: true` can terminate only a Chrome process GJC launched; `app.cdp_url` is externally owned and disconnect-only. CDP must stay on `127.0.0.1`: it grants full browser-account access.
- Inside `run`, `tab` exposes high-level helpers (`goto`, `observe`, `id`, `click`, `type`, `fill`, `press`, `waitFor`, `screenshot`, `extract`, …); reach for `page` (raw puppeteer Page) when they don't cover it.
- Selectors accept CSS as well as puppeteer query handlers: `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`.
- Runtime diagnostics are opt-in: pass `diagnostics: true` to `open` to subscribe the tab to page `Runtime.exceptionThrown` and `console.error` events. The next successful `act`/`run` response then includes at most 20 `runtimeDiagnostics` entries plus `runtimeDiagnosticsDropped`, then drains them. Entries contain only kind, time, origin-only URL, line/column, and a built-in error class from a fixed allowlist — never path segments, query strings, messages, console arguments, values, or stacks. Output is byte-bounded and marks truncation explicitly.
- Full reference — helpers, browser kinds, CDP/security details, and more examples — read `gjc://tools/browser.md`.
</instruction>

<critical>
- You MUST call `open` before `run` or `act`. Neither implicitly creates a tab.
- You MUST observe before taking a screenshot to understand page state; screenshot only when visual appearance matters.
- After a `tab.goto()` or any navigation, prior element ids from `tab.observe()` are invalidated. Re-observe before referencing them.
- `code` runs with full Node access. Treat it as your code, not sandboxed code.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"act","name":"docs","actions":[{"verb":"observe"}]}`

# Click an observed element, then fill and submit a form
`{"action":"act","name":"docs","actions":[{"verb":"click","id":12},{"verb":"fill","selector":"input[name=email]","value":"me@example.com"},{"verb":"click","selector":"text/Continue"}]}`

# Use `run` only when `act` has no suitable verb
`{"action":"run","name":"docs","code":"const count = await page.locator('canvas').count(); return { count };"}`
</examples>

<output>
- Per call: any `display(value)` outputs (text/images) followed by the JSON-stringified return value of the `code` function. `run` always produces at least a status line.
</output>
