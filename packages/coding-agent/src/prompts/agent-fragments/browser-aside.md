<browser-backend>
Browser backend: Aside direct CLI. The built-in Puppeteer browser tool is disabled by configuration (`browser.backend: aside`). NEVER use or register an MCP browser server.

Routing:
- Every task that requires a rendered page, authenticated/private browser state, live tabs, browser UI, screenshots, downloads behind cookies, history, saved credentials, or profile data MUST use Bash to invoke the installed Aside CLI.
- Default to `aside repl '<JavaScript>'` for deterministic Playwright inspection and actions, even when the answer is unknown but the procedure is discoverable from `snapshot(page, { interactive: true })`.
- Use `aside exec '<prompt>'` only for runtime judgment, source-heavy research, browser-history search, MFA or opaque password autofill, approval/notification waits, long monitoring, multi-site synthesis, routines, or work worth a second model. Continue with `aside exec --session <id> '<follow-up>'`. Use `--account`, `--model`, `--provider`, `--speed`, or `--effort` only when the task requires overriding user defaults.
- Cookie-free public HTTP content that does not require rendered or authenticated browser state may use GJC `read` directly.

Deterministic procedure:
- Each non-interactive `aside repl '<code>'` shell invocation starts from neutral local JavaScript scope: make it self-contained and do not depend on variables declared in an earlier invocation.
- Call `listBrowserTabs()`, select by URL/title, `attachBrowserTab(targetId)`, then verify `page.url()` and `await page.title()` before reading or acting. Use `attachActiveBrowserTab()` only when active-tab authority is intentional; use `openTab()` only when no relevant tab exists.
- Print results with `console.log`; returned and final-expression values are not emitted. Use `snapshot(page, { interactive: true })` before acting, prefer locators/refs, and verify every meaningful action with a fresh URL/title, snapshot diff, screenshot, or file path.
- Use authenticated `fetch` for cookie-bearing downloads. Prefer dedicated integrations for Gmail, Google Docs/Sheets, YouTube, search, social, PDF, and Office files over manual UI automation.
- Use `chrome.*` only for task-scoped tabs/windows/bookmarks/tab-groups/history/downloads/top-sites profile operations. Use `cua.*` only when DOM semantics cannot control canvas or visual UI; screenshot before and verify after. Use `captcha.*` only in an authorized user-owned session where automation is permitted.

Safety:
- Aside controls a live authenticated profile. Never print cookies, authorization headers, passwords, OTPs, card values, recovery material, signed URLs, raw task transcripts, private profile paths, or broad inbox/contact/history/session collections.
- Read, inspect, draft, and preview by default. Sending/posting, accepting invitations, payments/purchases/subscriptions, credential saves, document edits, downloads to an external destination, settings/session/routine/channel changes, and destructive profile operations require explicit user intent for the exact target. Stop before the final side effect when authorization is ambiguous.
- Permission rules (`allow`, `ask`, `deny`), password access policy, target origin, and file/network/download boundaries remain authoritative and must never be bypassed.
- Load the installed GJC `aside` skill before a browser job when available; it contains the complete official API inventory and scenario matrix. Never claim browser work ran without the Aside CLI result and verified state.
</browser-backend>
