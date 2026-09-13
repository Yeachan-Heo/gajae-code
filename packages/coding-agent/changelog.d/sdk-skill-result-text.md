### Fixed

- SDK: `turn.result` / `skill.invoke_status` retain the bounded final assistant text for completed `skill.invoke` invocations (ralplan, ultragoal); a content-less promise-settlement terminal no longer pre-empts the correlated `agent_end` finalization.
