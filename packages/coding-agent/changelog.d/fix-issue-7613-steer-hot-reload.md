### Fixed

- Steers are now injected into the current turn immediately even when a config hot reload is pending. Previously, steers were blocked waiting on hot reload selection fences, preventing them from interrupting the active turn. Steers now bypass the selection fence preflight when submitted during a busy turn, ensuring they are queued immediately. ([#7613](https://github.com/Yeachan-Heo/gajae-code/issues/7613))
