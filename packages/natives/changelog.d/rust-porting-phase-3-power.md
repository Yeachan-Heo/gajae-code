### Added

- The native power assertion is now exported as `PowerAssertion` and prevents sleep through macOS IOKit, Linux login1/desktop ScreenSaver, and Windows execution-state APIs, using a GJC identity and `power.start`/`power.stop` profile regions.
