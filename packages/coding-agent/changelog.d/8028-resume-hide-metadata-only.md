### Fixed

- `/resume` and bare `gjc --resume` no longer list sessions that never started a conversation: an unnamed, unstarred transcript that holds only its header and startup controls (model, thinking level, service tier, configured model chain) is left out of the picker. Header-only, handoff, named, and starred sessions still appear, as do sessions with a thinking level the operator chose, as does any transcript that cannot be fully checked within 64 KiB. `SessionManager.list()`, `--resume <id>`, and session recovery still see every session (#8028).
