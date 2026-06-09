Drives a real Chromium tab with full puppeteer access via JS execution.

<instruction>
- For static web content (articles, docs, issues/PRs, JSON, PDFs, feeds), prefer the `read` tool with a URL — reader-mode text without spinning up a browser. Use this tool when you need JS execution, authentication, or interactive actions.
- Four actions:
  - `open` — acquire (or reuse) a named tab. `name` defaults to `"main"`. Optional `url` navigates after the tab is ready. Optional `viewport` sets dimensions. Optional `dialogs: "accept" | "dismiss"` auto-handles `alert`/`confirm`/`beforeunload` so navigation/clicks don't hang (default: leave dialogs unhandled — page hangs until caller wires `page.on('dialog', …)`).
  - `close` — release a tab by `name`, or every tab with `all: true`. For spawned-app browsers, set `kill: true` to terminate the process tree (default leaves it running).
  - `run` — execute JS against an existing tab. `code` is the body of an async function with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. The function's return value is JSON-stringified into the tool result; multiple `display(value)` calls accumulate text/images.
  - `act` — run a list of structured `actions` against an existing tab without writing JS (preferred for routine navigation/interaction). Each step is `{ verb, … }`; verbs: `navigate {url, wait_until?}`, `click {id|selector}`, `type {id|selector, text}`, `fill {selector, value}`, `select {selector, values}`, `press {key, selector?}`, `scroll {dx?, dy?}`, `back`, `wait {selector?|ms?}`, `observe {viewport_only?, include_all?}`, `extract {format?}`, `screenshot`. Address elements by the numeric `id` from a prior `observe` (preferred) or a selector. Steps run in order; the tool returns an array of per-step results (observations/extracted content included). Use `run` only when a verb does not cover what you need.
- Tabs survive across `run` calls and across in-process subagents. Open once, reuse many times.
- Browser kinds, selected by the `app` field on `open`:
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn an absolute binary (Electron/CDP). If a running instance already exposes a CDP port, it is reused; otherwise stale instances are killed and a fresh one is spawned. No stealth patches — never tamper with a real desktop app.
  - `app.cdp_url` → connect to an existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring matched against url+title to pick a BrowserWindow when the app exposes several.
- Inside `run`, `tab` exposes high-level helpers; reach for `page` (raw puppeteer Page) when you need anything they don't cover.
  - `tab.goto(url, { waitUntil? })` — clears the element cache and navigates.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot. Returns `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Element ids are stable until the next observe/goto.
  - `tab.id(n)` — resolves an element id from the most recent observe to a real `ElementHandle` you can `.click()`, `.type()`, etc.
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)` — selector-based actions.
  - `tab.waitFor(selector)` — waits until the selector is attached, returns the resolved `ElementHandle` for chaining (e.g. `const btn = await tab.waitFor('text/Submit'); await btn.click();`).
  - `tab.drag(from, to)` — drag from one point to another. Each endpoint is either a selector string (drag center-to-center) or a `{ x, y }` viewport-coordinate point (e.g. for canvases, sliders).
  - `tab.scrollIntoView(selector)` — scroll the matching element to the center of the viewport (use before clicking off-screen elements).
  - `tab.select(selector, …values)` — set the selected option(s) on a `<select>`. Returns the values that ended up selected. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to an `<input type="file">`. Paths resolve relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — pattern is a substring or `RegExp`. Polls `location.href` so it works for SPA pushState navigations, not just real navigations. Returns the matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — pattern is a substring, `RegExp`, or `(response) => boolean`. Returns the raw puppeteer `HTTPResponse` (call `.text()` / `.json()` / `.status()` / `.headers()` on it).
  - `tab.evaluate(fn, …args)` — sugar for `page.evaluate` with the abort signal already wired. Use this instead of dropping to `page.evaluate` for ad-hoc DOM reads.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — auto-attaches the image to the tool output unless `silent: true`. Saves full-res to `save` (or `browser.screenshotDir` setting) and a downscaled copy to the model.
  - `tab.extract(format = "markdown")` — Readability-extracted page content.
- Selectors accept CSS as well as puppeteer query handlers: `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`. Playwright-style `p-aria/[name="…"]`, `p-text/…`, etc. are normalized.
- Default to `tab.observe()` over `tab.screenshot()` for understanding page state. Screenshot only when visual appearance matters.
</instruction>

<critical>
- You MUST call `open` before `run` or `act`. Neither implicitly creates a tab.
- You NEVER screenshot just to "see what's on the page" — `tab.observe()` returns structured data with element ids you can act on immediately.
- After a `tab.goto()` or any navigation, prior element ids from `tab.observe()` are invalidated. Re-observe before referencing them.
- `code` runs with full Node access. Treat it as your code, not sandboxed code.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); display(obs); return obs.elements.length;"}`

# Click an observed element by id
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();"}`

# Save a full-page screenshot to disk
`{"action":"run","name":"docs","code":"await tab.screenshot({ fullPage: true, save: 'screenshot.png' });"}`

# Fill and submit a form via selectors
`{"action":"run","name":"docs","code":"await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');"}`

# Attach to an existing Electron app
`{"action":"open","name":"cursor","app":{"path":"/Applications/Cursor.app/Contents/MacOS/Cursor"}}`

# Close one tab (browser stays alive if other tabs reference it)
`{"action":"close","name":"docs"}`

# Close every tab; leave spawned apps running
`{"action":"close","all":true}`

# Close every tab and kill spawned-app processes too
`{"action":"close","all":true,"kill":true}`
</examples>

<output>
- Per call: any `display(value)` outputs (text/images) followed by the JSON-stringified return value of the `code` function. `run` always produces at least a status line.
</output>
