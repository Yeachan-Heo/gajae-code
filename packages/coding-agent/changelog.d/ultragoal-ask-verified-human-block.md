### Changed

- The Ultragoal ask guard now admits `ask` once a human-only blocker is verified: the latest `blocker_classified` event is `human_blocked` and a fresh clean pause terminal-critic verdict is bound to it. Previously `ask` stayed blocked regardless of classification, so a run that was allowed to park for the user could not put the human-only request to them as a structured question. The receipt is the only check — unlike `goal({"op":"pause"})`, no try-harder nudge is spent first. `resolvable`, unverified, rejected, stale, and other-session classifications still block `ask`.
