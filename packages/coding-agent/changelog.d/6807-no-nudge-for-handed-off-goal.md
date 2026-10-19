### Fixed

- Stop Ultragoal try-harder nudges from targeting goals handed off to a successor run. When a retained source-owned goal remains, nudges target that work instead, keeping aggregate drop guarded until its nudge budget is exhausted; when no retained target remains, the guard falls through to its normal gate without spending budget (#6807).
