### Fixes

- Fix Orca setup instructions in `docs/terminal-app-integrations.md` and `README.md`. Previous docs told users to open "Settings → Agents" and add a custom agent, but Orca does not support custom agent registration yet ([stablyai/orca#36718](https://github.com/stablyai/orca/issues/36718)). Instructions now show the workaround: override a built-in agent's command with `gjc`, or run `gjc` directly in the worktree terminal. Support rating downgraded from ★★★★☆ to ★★★☆☆ and linked to upstream feature-request and PR issues.
