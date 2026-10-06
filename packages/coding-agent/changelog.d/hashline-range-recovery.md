### Fixed

- Hashline stale-anchor recovery now handles multi-line ranges (`≔A..B` spanning three or more lines). Range interiors carry no model-supplied hash, so recovery previously refused every such edit even when a retained read snapshot vouched for both endpoints; interior lines now only need to be present in the snapshot, and the replayed hunk must still match the live file exactly.
