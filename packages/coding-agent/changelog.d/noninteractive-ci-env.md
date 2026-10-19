### Fixed

- The non-interactive shell environment no longer sets `CI=1`. It made every child tool (including test runners and `node-llama-cpp`) believe it was running in CI, and a per-call `env` cannot unset it. The prompt-suppression intent is already covered by `GIT_TERMINAL_PROMPT`, `SSH_ASKPASS`, `GH_PROMPT_DISABLED`, `DEBIAN_FRONTEND`, and `PIP_NO_INPUT`.
