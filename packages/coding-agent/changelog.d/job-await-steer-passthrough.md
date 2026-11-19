### Changed

- A `job` `poll` wait now ends the moment a new user message arrives, matching `subagent` await: there is no 2-second grace window and no `busyPromptMode` gate, and waits over `task`-backed jobs pass through too. The result appends `Job await interrupted by a new user message; …`, the watched jobs keep running, and their results are still delivered automatically on completion. The await is no longer folded, so it records no `foldReason`, emits no `bash_folded` frame, and the `job-await` fold wait kind is removed.
