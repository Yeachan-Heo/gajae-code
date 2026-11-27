### Fixed
- Completing a goal no longer logs `[Unhandled Rejection] Error: Active tool selection was superseded before it could be applied` when the turn-end handler and the next input prompt both start the completed-goal exit. The later tool restore superseded the earlier one; both callers now share a single exit.
