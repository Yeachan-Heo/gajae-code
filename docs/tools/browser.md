# browser

> Open, reuse, close, and script Puppeteer tabs against headless Chromium or CDP-attached apps.

## Source
- Entry: `packages/coding-agent/src/tools/browser.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/browser.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/browser/tab-supervisor.ts` — global tab registry; worker lifecycle; run/close coordination.
  - `packages/coding-agent/src/tools/browser/tab-worker.ts` — executes `run` code; implements the `tab` helper API.
  - `packages/coding-agent/src/tools/browser/tab-worker-entry.ts` — worker-thread transport bootstrap.
  - `packages/coding-agent/src/tools/browser/registry.ts` — browser-handle registry keyed by browser kind.
  - `packages/coding-agent/src/tools/browser/launch.ts` — Puppeteer loading, Chromium resolution/download, headless launch, stealth injection.
  - `packages/coding-agent/src/tools/browser/attach.ts` — CDP attach/reuse, target picking, spawned-app process handling.
  - `packages/coding-agent/src/tools/browser/tab-protocol.ts` — worker init/run/result message schema.
  - `packages/coding-agent/src/tools/browser/readable.ts` — `tab.extract()` readability extraction.
  - `packages/coding-agent/src/tools/browser/render.ts` — TUI rendering for `open`/`close` status lines and `run` JS cells.
  - `packages/coding-agent/src/tools/puppeteer/00_stealth_tampering.txt` — mask patched functions/descriptors as native.
  - `packages/coding-agent/src/tools/puppeteer/01_stealth_activity.txt` — synthesize visibility/focus/scroll activity.
  - `packages/coding-agent/src/tools/puppeteer/02_stealth_hairline.txt` — fix Modernizr hairline detection.
  - `packages/coding-agent/src/tools/puppeteer/03_stealth_botd.txt` — spoof `navigator.webdriver`, `window.chrome`, and Chrome fingerprint surfaces.
  - `packages/coding-agent/src/tools/puppeteer/04_stealth_iframe.txt` — patch iframe `contentWindow`/`srcdoc` behavior.
  - `packages/coding-agent/src/tools/puppeteer/05_stealth_webgl.txt` — spoof WebGL vendor/renderer/precision.
  - `packages/coding-agent/src/tools/puppeteer/06_stealth_screen.txt` — normalize screen/viewport/device-pixel-ratio values.
  - `packages/coding-agent/src/tools/puppeteer/07_stealth_fonts.txt` — spoof local fonts and perturb canvas text rendering.
  - `packages/coding-agent/src/tools/puppeteer/08_stealth_audio.txt` — spoof audio latency/sample-rate and perturb offline rendering.
  - `packages/coding-agent/src/tools/puppeteer/09_stealth_locale.txt` — force locale/languages/timezone/date strings.
  - `packages/coding-agent/src/tools/puppeteer/10_stealth_plugins.txt` — synthesize `navigator.plugins`/`navigator.mimeTypes`.
  - `packages/coding-agent/src/tools/puppeteer/11_stealth_hardware.txt` — spoof `navigator.hardwareConcurrency`.
  - `packages/coding-agent/src/tools/puppeteer/12_stealth_codecs.txt` — spoof media codec support.
  - `packages/coding-agent/src/tools/puppeteer/13_stealth_worker.txt` — carry UA/platform spoofing into `Worker`/`SharedWorker`.

## Inputs

### Shared fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"open" \| "close" \| "run"` | Yes | Dispatches to the open/close/run path. |
| `name` | `string` | No | Tab id. Defaults to `"main"`. Tabs live in a process-global map, so the same name is reused across later calls and in-process subagents until closed. |
| `timeout` | `number` | No | Tool wall-clock timeout in seconds. Defaults to `30`; clamped to the browser tool range before execution. |

### `action: "open"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | No | Navigate after the tab is ready. Existing reusable tabs also navigate when `url` is supplied. |
| `viewport` | `{ width: number; height: number; scale?: number }` | No | Requested viewport. For headless launch this becomes the initial viewport; for a page it is applied with `page.setViewport()`. `scale` maps to Puppeteer `deviceScaleFactor`. |
| `wait_until` | `"load" \| "domcontentloaded" \| "networkidle0" \| "networkidle2"` | No | Navigation wait condition. Defaults to `"networkidle2"` where omitted. |
| `dialogs` | `"accept" \| "dismiss"` | No | Installs a page `dialog` handler that auto-accepts or auto-dismisses dialogs. Omitted means no handler. |
| `app` | `{ path?: string; cdp_url?: string; browser?: "chrome"; user_data_dir?: string; profile_directory?: string; background?: boolean; no_focus?: boolean; cdp_port?: number; args?: string[]; target?: string }` | No | Selects browser kind. No `app` uses the session `browser.headless` setting. `app.path` alone is resolved against the session cwd and used as the executable path for spawn/attach reuse. `app.cdp_url` connects to an existing CDP endpoint. `app.browser: "chrome"` selects guarded saved-profile mode and requires `path`, `user_data_dir`, and `profile_directory`. `args` are appended only when spawning `app.path` or a Chrome profile. `target` is used for attached/spawned/profile page selection. |

### `action: "close"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `all` | `boolean` | No | Close every known tab. Omitted closes only `name`. |
| `kill` | `boolean` | No | When a tab release drops a spawned-app browser handle to refcount 0, also terminate its process tree. For Chrome profile mode this kills only a profile browser process launched by GJC; externally-owned profile CDP and `app.cdp_url` are disconnect-only. Has no effect on headless shutdown. |

### `action: "run"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | `string` | Yes | Async-function body executed in a VM context with `page`, `browser`, `tab`, `display`, `assert`, `wait`, `console`, timers, `URL`, `TextEncoder`, `TextDecoder`, and `Buffer` in scope. |

## Outputs
The tool returns one result per call; no streaming partial output is emitted from the browser implementation itself.

- `open`: text content with `Opened` or `Reused`, browser description, URL, and optional title. `details` includes `action`, `name`, `browser`, `url`, `viewport`, and the same text in `details.result`.
- `close`: text content with either `Closed ...` or `No tab named ...`. `details` includes `action`, `name`, and `details.result`.
- `run`: ordered `content` array built as:
  1. every `display(value)` call in execution order,
  2. final return value, JSON-stringified unless already a string,
  3. or `Ran code on tab "..."` if nothing else was produced.
- `display(value)` coercion in `packages/coding-agent/src/tools/browser/tab-worker.ts`:
  - `{ type: "image", data: string, mimeType: string }` becomes image content,
  - `string` becomes text content,
  - other values become pretty JSON text when serializable, else `String(value)`.
- `tab.screenshot()` also appends text plus an image content item unless `silent: true`; `details.screenshots` records persisted screenshot metadata `{ dest, mimeType, bytes, width, height }`.
- `run` `details` includes `action`, `name`, current `browser`/`url` when the tab exists, optional `screenshots`, and `details.result` containing only the concatenated text outputs.

## Flow
1. `BrowserTool.execute()` (`packages/coding-agent/src/tools/browser.ts`) abort-checks, clamps `timeout` via `clampTimeout("browser", ...)`, defaults `name` to `"main"`, and dispatches on `action`.
2. `open` resolves browser kind with `resolveBrowserKind()`:
   - `app.cdp_url` → `{ kind: "connected" }` after trimming trailing slashes.
   - `app.browser: "chrome"` → `{ kind: "chrome-profile" }` after resolving `path` and `user_data_dir` against session cwd and copying `profile_directory`, `background`, `no_focus`, and optional `cdp_port`.
   - `app.path` → `{ kind: "spawned" }` after resolving against session cwd.
   - otherwise → `{ kind: "headless", headless: session.settings.get("browser.headless") }`.
3. `open` rejects reusing the same tab name across different browser kinds (`sameBrowserKind()`); callers must close first.
4. `open` acquires a browser handle through `acquireBrowser()` (`packages/coding-agent/src/tools/browser/registry.ts`):
   - existing connected handle is reused by browser-kind key;
   - stale disconnected handles are disposed and recreated;
   - headless launches via `launchHeadlessBrowser()`;
   - `connected` waits for `${cdpUrl}/json/version`, then `puppeteer.connect()`;
   - `spawned` first tries `findReusableCdp()`, else kills same-path processes, allocates a free loopback port, spawns the executable with `--remote-debugging-port=<port>`, waits for CDP, then connects.
   - `chrome-profile` checks same-executable processes for matching `--user-data-dir` and `--profile-directory`; if the matching process already exposes a responding `127.0.0.1` CDP port it reuses and later only disconnects, if it is running without attachable CDP it refuses without killing or relaunching, and if it is not running GJC launches Chrome with `--remote-debugging-address=127.0.0.1`, an ephemeral or configured `--remote-debugging-port`, `--user-data-dir`, `--profile-directory`, and `--no-startup-window` when `background` or `no_focus` is set. Only this GJC-launched process is eligible for `kill` cleanup.
5. `open` acquires a tab through `acquireTab()` (`packages/coding-agent/src/tools/browser/tab-supervisor.ts`):
   - same-name + same-browser + alive tab is reused unless `dialogs` changed;
   - same-name but different browser handle, dead state, or changed dialog policy forces release and recreation;
   - reusing with a new `url` navigates by issuing `await tab.goto(...)` through the worker.
6. New tabs build a `WorkerInitPayload` in `buildInitPayload()`:
   - headless mode sends `url`, `waitUntil`, `viewport`, `dialogs`, and timeout;
   - attach mode resolves a page with `pickElectronTarget()`, gets its target id, and sends `targetId` plus `dialogs`.
7. `acquireTab()` spawns a dedicated Bun `Worker` from `tab-worker-entry.ts`; if that fails it falls back to inline execution in the main thread (`spawnInlineWorker()`), preserving behavior but losing protection against synchronous infinite loops.
8. `WorkerCore.#init()` (`packages/coding-agent/src/tools/browser/tab-worker.ts`) connects back to the browser websocket endpoint. Headless mode opens a new page, applies stealth patches, applies viewport, installs dialog handling if requested, and optionally navigates. Attach mode resolves the requested target page and optionally installs dialog handling.
9. On success the worker sends `ready` with `{ url, title, viewport, targetId }`; the supervisor stores a `TabSession`, increments browser-handle refcount with `holdBrowser()`, and keeps the tab in a process-global `Map<string, TabSession>`.

### Existing Chrome profile mode

Use this mode when automation needs cookies and login state from a saved Chrome profile without risking the daily Chrome process:

```json
{
  "action": "open",
  "name": "work-browser",
  "app": {
    "browser": "chrome",
    "path": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "user_data_dir": "~/Library/Application Support/Google/Chrome",
    "profile_directory": "Profile 10",
    "background": true,
    "no_focus": true,
    "target": "example.com"
  }
}
```

Security and lifecycle rules:

- CDP is bound to `127.0.0.1`; do not expose logged-in profile CDP ports on a public interface. A CDP client has full browser-account access.
- A matching already-running profile is reused only when its localhost CDP endpoint responds. A matching profile running normally without CDP is refused with remediation text; GJC does not kill or relaunch it.
- `background` and `no_focus` add Chromium's `--no-startup-window` launch guard. Focus avoidance is best-effort and platform-dependent; already-visible Chrome windows can still be selected by `target` but are not OS-keyboard/mouse driven.
- Cleanup disconnects externally-owned CDP endpoints. `kill: true` terminates only the Chrome profile process that GJC launched for this mode.
10. `run` requires non-empty `code`, looks up the tab with `getTab()`, then delegates to `runInTab()`.
11. `runInTabWithSnapshot()` rejects dead tabs and concurrent runs (`Tab ... is busy`), captures session cwd plus optional `browser.screenshotDir`, registers an abort hook, sends a `run` message to the worker, and races the result against `timeoutMs + 750` ms. Timeouts force-kill the tab worker and, for headless tabs, close the orphaned page target.
12. `WorkerCore.#run()` creates a VM context, exposes the raw Puppeteer `page`/`browser` plus a synthetic `tab` API, and executes `(async () => { ...code... })()` via `vm.runInContext()`.
13. The `tab` helper API implemented in `#createTabApi()` is:
   - `tab.name: string`
   - `tab.page: Page`
   - `tab.signal?: AbortSignal`
   - `tab.url(): string`
   - `tab.title(): Promise<string>`
   - `tab.goto(url, { waitUntil? })`
   - `tab.observe({ includeAll?, viewportOnly? })`
   - `tab.screenshot({ selector?, fullPage?, save?, silent? })`
   - `tab.extract(format = "markdown")`
   - `tab.click(selector)`
   - `tab.type(selector, text)`
   - `tab.fill(selector, value)`
   - `tab.press(key, { selector? })`
   - `tab.scroll(deltaX, deltaY)`
   - `tab.drag(from, to)`
   - `tab.waitFor(selector)`
   - `tab.evaluate(fn, ...args)`
   - `tab.scrollIntoView(selector)`
   - `tab.select(selector, ...values)`
   - `tab.uploadFile(selector, ...filePaths)`
   - `tab.waitForUrl(pattern, { timeout? })`
   - `tab.waitForResponse(pattern, { timeout? })`
   - `tab.id(n)`
14. Selector handling in `normalizeSelector()` accepts plain CSS and Puppeteer query handlers, and rewrites legacy Playwright-style prefixes `p-text/`, `p-xpath/`, `p-pierce/`, `p-aria/`; other `p-*` prefixes throw a `ToolError`.
15. `tab.observe()` clears the element cache, takes a Puppeteer accessibility snapshot, filters to interactive nodes unless `includeAll`, optionally filters to viewport-visible nodes, assigns numeric ids, caches `ElementHandle`s, and returns URL/title/viewport/scroll metadata plus `elements`.
16. `tab.id(n)` resolves the cached `ElementHandle`, verifies `el.isConnected`, and throws a stale-id error after cache invalidation if the DOM changed or the cache was cleared.
17. `tab.goto()` clears the cached element ids before navigating. Any new `tab.observe()` also clears and rebuilds the cache.
18. `tab.click()` uses a custom retry loop for `text/...` selectors to find an actionable visible match; other selectors use `page.locator(...).click()` with the run timeout.
19. `tab.screenshot()` captures either the whole page or a selector PNG, downsizes a copy for model output, chooses a persistence path, writes the image to disk, records metadata, and optionally emits text + image display entries.
20. `display()` calls accumulate in an array. After code finishes, the worker posts `{ displays, returnValue, screenshots }`; `BrowserTool.#run()` appends the return value as trailing text content when not `undefined`.
21. `close` releases one tab or all tabs via `releaseTab()` / `releaseAllTabs()`. Each tab aborts pending runs, asks the worker to close, waits up to `750` ms for a `closed` ack, terminates the worker, decrements browser refcount, and disposes the browser handle when refcount reaches zero.

## Modes / Variants
- **Action dispatch**
  - `open` — acquire/reuse browser + tab.
  - `close` — release one tab or all tabs.
  - `run` — execute JS inside the tab worker.
- **Browser kind**
  - **Headless**: launches local Chromium with Puppeteer, applies stealth patches, and creates a fresh page per tab.
  - **Spawned app (`app.path`)**: reuses an existing CDP-enabled process for that executable when possible; otherwise kills same-path processes, spawns the executable with remote debugging enabled, then attaches. No stealth patches are injected.
  - **Connected browser (`app.cdp_url`)**: attaches to an already-running CDP endpoint. No process ownership; close only disconnects.
- **Target selection for attached/spawned browsers**
  - With `app.target`, `pickElectronTarget()` returns the first page whose URL or title contains the case-insensitive substring.
  - Without `app.target`, it skips titles/URLs matching `request handler|devtools|background page|background host|service worker` and otherwise falls back to the first page.
- **Worker mode**
  - **Dedicated worker**: normal path; user code runs off the main thread and can be aborted even when it blocks synchronously.
  - **Inline fallback**: activated when Bun worker spawn fails; behavior matches, but synchronous infinite loops on user code cannot be interrupted.
- **Dialog policy**
  - No `dialogs` field: no auto-handler.
  - `accept`/`dismiss`: page `dialog` events are handled automatically.
  - Changing dialog policy on an existing live tab forces tab recreation instead of mutating the worker in place.
- **Screenshot persistence**
  - `save` provided: persist full-resolution PNG at the resolved cwd-relative or absolute path.
  - `browser.screenshotDir` session setting set: persist full-resolution PNG under that directory with a timestamped filename.
  - Neither set: persist the resized image to a temp-file path under the OS temp dir.

## Side Effects
- Filesystem
  - `loadPuppeteer()` writes `{}` to `<puppeteer-safe-dir>/package.json` before importing `puppeteer-core`.
  - First headless launch may download Chromium into the Puppeteer cache directory returned by `getPuppeteerDir()`.
  - `tab.screenshot()` creates parent directories and writes image files.
  - `tab.uploadFile()` resolves supplied paths against the session cwd.
- Network
  - CDP attach paths poll `http://127.0.0.1:<port>/json/version` or the supplied `cdp_url` `/json/version`.
  - Headless/browser-attach sessions create CDP websocket connections.
  - Headless first-use Chromium download uses `@puppeteer/browsers`.
  - User `page` / `tab` operations perform normal browser network traffic.
- Subprocesses / native bindings
  - Headless mode launches Chromium through Puppeteer.
  - `app.path` mode may spawn the target executable via `Bun.spawn()`.
  - `killExistingByPath()` / `gracefulKillTreeOnce()` use `@gajae-code/natives` process inspection/termination.
  - Worker mode uses Bun `Worker`; fallback mode does not.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Browser handles are cached in a process-global `Map` keyed by browser kind in `packages/coding-agent/src/tools/browser/registry.ts`.
  - Tabs are cached in a process-global `Map` keyed by `name` in `packages/coding-agent/src/tools/browser/tab-supervisor.ts`.
  - `run` captures session cwd and optional `browser.screenshotDir` for screenshot/save path resolution.
  - `restartForModeChange()` drops only headless tabs.
- User-visible prompts / interactive UI
  - None beyond normal tool output. Dialog auto-handling is invisible unless it fails and emits debug logs.
- Background work / cancellation
  - `open`, `run`, CDP waits, and browser actions thread through abort signals.
  - A timed-out `run` aborts the worker execution path and can tear down the tab.

## Limits & Caps
- Tool timeout clamp: default `30` s, min `1` s, max `30` s (`TOOL_TIMEOUTS.browser` in `packages/coding-agent/src/tools/tool-timeouts.ts`).
- Supervisor grace period around init/run/close: `750` ms (`GRACE_MS` in `packages/coding-agent/src/tools/browser/tab-supervisor.ts`).
- Puppeteer protocol timeout for launch/connect operations: `60_000` ms (`BROWSER_PROTOCOL_TIMEOUT_MS` in `packages/coding-agent/src/tools/browser/launch.ts`).
- Connected-browser CDP readiness wait: `5_000` ms before `puppeteer.connect()` (`packages/coding-agent/src/tools/browser/registry.ts`).
- Spawned-app CDP readiness wait after spawn: `30_000` ms (`packages/coding-agent/src/tools/browser/registry.ts`).
- CDP polling cadence: 150 ms in `waitForCdp()` (`packages/coding-agent/src/tools/browser/attach.ts`).
- Headless default viewport: `1365x768` at `deviceScaleFactor: 1.25` (`DEFAULT_VIEWPORT` in `packages/coding-agent/src/tools/browser/launch.ts`).
- Screenshot model-attachment resize cap: `maxWidth 1024`, `maxHeight 1024`, `maxBytes 150 * 1024`, `jpegQuality 70` (`packages/coding-agent/src/tools/browser/tab-worker.ts`).
- `tab.waitForUrl()` polling interval: `200` ms (`packages/coding-agent/src/tools/browser/tab-worker.ts`).
- Drag simulation uses `12` mouse-move steps (`packages/coding-agent/src/tools/browser/tab-worker.ts`).

## Errors
- `BrowserTool.execute()` converts DOM-style `AbortError` into `ToolAbortError`; other errors propagate.
- `run` hard-fails on missing code: `Missing required parameter 'code' for action 'run'.`
- `open` fails when reusing a name across browser kinds: `Tab "..." is bound to a different browser (...). Close it first.`
- `runInTabWithSnapshot()` fails when the tab is absent/dead (`Tab "..." is not alive. Reopen it.`) or already running (`Tab "..." is busy`).
- Worker init failures and run failures are serialized through `RunErrorPayload`; `ToolError` and abort state are reconstructed on the host side by `errorFromPayload()`.
- Attached-target mismatches surface as:
  - `No page targets available on the attached browser`
  - `No page target matched "...". Available pages:\n...`
  - `Target ... is no longer available on the attached browser`
- Spawned-app path validation requires an absolute executable path, not an app bundle path.
- Spawn/attach failures are wrapped into `ToolError`s such as `Timed out waiting for CDP endpoint ...`, `Failed to attach to ...`, or `Connected to ... but puppeteer.connect failed: ...`.
- `tab` helper errors are user-visible `ToolError`s, including unsupported selector prefix, stale/unknown element id, invalid drag target, missing upload files, non-`<select>` for `tab.select()`, non-file-input for `tab.uploadFile()`, and screenshot selector misses.
- On run timeout, the worker reports `Browser code execution timed out after <ms>ms`; the supervisor may escalate to `Browser code execution hung past grace; tab killed` if the worker does not respond after the grace window.

## Notes
- `loadPuppeteer()` and `loadPuppeteerInWorker()` temporarily redirect `cwd` to a safe Puppeteer directory before importing `puppeteer-core`, because Puppeteer probes the current working directory during module load.
- Headless launch prefers a detected system Chrome/Chromium, then `PUPPETEER_EXECUTABLE_PATH`, and only then downloads Chromium.
- Headless launch always passes `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-blink-features=AutomationControlled`, and a `--window-size=...` matching the initial viewport. It also ignores Puppeteer default args `--disable-extensions`, `--disable-default-apps`, and `--disable-component-extensions-with-background-pages`.
- Proxy-related env vars only affect headless launch: `PUPPETEER_PROXY`, `PUPPETEER_PROXY_BYPASS_LOOPBACK`, and `PUPPETEER_PROXY_IGNORE_CERT_ERRORS`.
- Stealth patches are applied only in headless mode. Spawned or externally connected browsers are intentionally left untouched.
- `applyStealthPatches()` also strips Puppeteer's `//# sourceURL=__puppeteer_evaluation_script__` suffix from CDP `Runtime.evaluate` / `Runtime.callFunctionOn` payloads.
- `tab.extract()` reads `page.content()`, runs Readability first, then falls back to `main article`/`article`/`main`/`[role='main']`/`body`, and returns `null` if neither extraction path yields content.
- `close(all: true, kill: false)` disconnects from spawned/connected browsers when the last tab closes but leaves spawned app processes running.
- Headless orphan cleanup is best-effort: if a worker dies before closing its page, the supervisor searches browser targets by `targetId` and closes that page.
- Console methods inside `run` do not appear in tool output; they are forwarded as debug/warn/error logs through the worker transport.