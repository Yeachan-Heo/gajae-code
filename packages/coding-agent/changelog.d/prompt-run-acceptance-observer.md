### Added

- Report prompt run acceptances to embedders through `PromptOptions.onRunAccepted`, including replacement handles minted for mid-run context maintenance on the same logical run, exactly once per handle and contained when the observer throws or rejects.
