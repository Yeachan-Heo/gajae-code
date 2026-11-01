### Fixed

- Bash `rule://` expansion stays in the session directory, the repository root, the agent directory, a non-Git ancestor `.agent` or `.agents` rules directory under the trusted home, or a discovered user rule under `.agent/rules`, `.agents/rules`, or the agent directory. Bash no longer expands `memory://`: the memory store folds project paths such as `/work/acme-api/server` and `/work/acme/api-server` to one memory root, so the URL is rejected before resolution and stays on the internal reader.
