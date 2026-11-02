### Fixed

- The Ultragoal ask guard no longer refuses the execution approval for a reviewed ralplan final written with the bundled skill's per-pass `--stage_n`. When every stage of a pass shares one `stage_n`, the current final is now the last index row, its opener is the nearest planner/revision row before it, and its Architect/Critic verdicts are the rows between the two. A final followed by any stage, or by a stage with a higher `stage_n`, is still refused.
