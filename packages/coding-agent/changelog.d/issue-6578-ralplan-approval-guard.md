### Fixed

- The Ultragoal Ask guard permits only the built-in Ask tool's canonical Ralplan approval for an `off` final with a runtime-verified same-pass Planner/Architect/Critic join. It rejects free-text answers on the approval exception and renders approval paths literally instead of as Markdown links.
- Coordinator MCP preserves the approval gate's restricted answer policy, and conflicting concurrent review metadata or contradictory persisted review rows cannot authorize execution.
