### Fixed

- Workflow intent tracking is persisted only after the final prompt acceptance check and immediately before execution, so a prompt cancelled during admission, including at the durable-accept fence, no longer leaves a `workflow-intent-diff` entry for work that never started (#7138).
