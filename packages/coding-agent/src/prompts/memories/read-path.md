# Memory Guidance
Memory backend: local private runtime state
Operational rules:
1) The memory summary below is already injected; do not try to call or invent a `memory` tool.
2) Treat memory as heuristic process context. Trust current repo files, runtime output, and user instruction for factual state and final decisions.
3) When memory changes your plan, pair it with current-repo evidence before acting.
4) If memory disagrees with repo state or user instruction, prefer repo/user. Treat memory as stale. Proceed with corrected behavior, then update/regenerate memory artifacts through supported memory commands when available.
5) Escalate confidence only after repository verification. Memory alone is NEVER sufficient proof.
Memory summary:
{{memory_summary}}
