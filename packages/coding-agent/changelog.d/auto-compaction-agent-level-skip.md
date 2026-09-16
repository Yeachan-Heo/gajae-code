### Fixed

- Auto-compaction on a session whose reachable models are all agent-level providers (e.g. Devin over ACP) no longer reports a guaranteed `maintenanceCall` refusal as `Auto-compaction failed` on every threshold crossing. Agent-level providers own conversation history and cannot serve GJC maintenance calls by contract, so the maintenance is now a benign skip; the candidate chain also no longer spends an attempt on an agent-level model while a text-model candidate exists.
