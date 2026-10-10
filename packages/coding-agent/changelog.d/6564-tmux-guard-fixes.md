### Security

- fix(tmux-self-injection-guard): Fix multiple command-parsing vulnerabilities in the tmux injection guard
  - Restrict `command -v`/`-V` lookup suppression to the same command invocation; previously suppressed across command boundaries (`;`, `|`)
  - Preserve environment variable assignments like `env FOO=bar` in wrapper context; previously treated them as wrapped commands
  - Separate flag-only options (`setsid -c/-w`, `sudo -s/-i`, `xargs -0/-t/-x`) from argument-taking options to prevent adjacent words from being consumed as option arguments
  - Recognize shell option operands (`bash -O extglob`, `bash -o pipefail`) and skip over them when scanning for script payloads; previously halted at option operands
  - Removed unreachable dead code in wrapper mode state machine
