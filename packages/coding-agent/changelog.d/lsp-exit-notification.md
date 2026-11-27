### Fixed
- Stopping a language server now follows the LSP shutdown sequence: after the `shutdown` response gjc sends the `exit` notification and lets the server terminate itself, and only signals its process group if it is still running after the 5-second deadline. Previously the server was always killed with SIGTERM right after `shutdown`.
