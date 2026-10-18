### Added

- Added the `task.compactSubagentPanel` setting. When it is on, live subagent await progress collapses into one summary line such as `12 subagents running · 3 idle >30s`, plus any provider-degradation warning and an expand hint, until tool output is expanded. Await progress then refreshes only when that summary changes, so redraw cost and frequency no longer grow with the number of live subagents. Final results, including timeout guidance and failure receipts, still render in full (#6774).
