### Fixed

- `bash --rcfile FILE -c 'payload'` and other long-option forms of bash/sh no longer confuse script arguments with shell command payloads in the tmux self-injection guard.
- The guard now properly handles bash long options (`--rcfile`, `--init-file`, `--norc`, `--noprofile`) before `-c` and correctly identifies quoted payloads.
