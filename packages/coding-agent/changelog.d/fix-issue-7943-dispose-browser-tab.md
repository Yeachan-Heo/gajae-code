### Bug Fixes

- **Session disposal**: handle browser tab release timeout gracefully in SDK shutdown handler. When browser tab closure exceeded the dispose deadline on Windows (slow Puppeteer shutdown), `SessionDisposalIncompleteError` escaped as an unhandled rejection and crashed the process. Now the error is caught in the SDK shutdown handler with proper logging, and the process exits gracefully. Additionally, the dispose deadline is now passed to `releaseTabsForOwner` so browser cleanup respects the overall disposal deadline (#7943).
