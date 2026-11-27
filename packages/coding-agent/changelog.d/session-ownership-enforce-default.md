### Changed

- Session ownership now defaults to `enforce` (`session.ownership.mode`): only one gjc process writes a session at a time. What you will see:
  - A second terminal that resumes a session another terminal has open (`gjc --resume <id>`, the `--resume` picker, `/resume`) shows a warning naming the holder, with **Fork into a new session** and **Cancel**.
  - Picking up on a PC a session started from a phone or a bot (Gajae Mobile, Telegram, `gjc acp`, `gjc sdk`) while its broker-launched host is still running shows the warning with **Continue here**, which moves the session to this terminal between turns.
  - `gjc -p --resume <id>` of a held session exits 1 and names the holder before any model call.
  - Starring or deleting a held session in the picker is refused, and a broker `session.delete` of a held session answers `live_session`.
  - ACP `session/load`, `gjc sdk session send` and the notification daemons still attach to the process that holds the session, and their prompts run there.
- To opt out, set `session.ownership.mode` to `observe` (claims and counts, never refuses) or `off` (no claims) in the global config, for example `gjc config set session.ownership.mode observe`, and restart running gjc processes; a long-lived SDK embedding reads the config once and also needs a restart. `GJC_SESSION_OWNERSHIP=observe|off` in your shell lowers the mode only for processes started from that shell: hosts the broker launches (ACP, `gjc sdk`, daemon sessions) take the broker's environment, so use the config file for them. On Windows there is no native lock yet, so claims fail open there and nothing is refused. See `docs/session.md`.
