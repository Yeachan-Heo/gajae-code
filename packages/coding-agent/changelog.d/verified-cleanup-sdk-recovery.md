### Fixed

- Narrowed revert of specific SDK terminal publication edges from #6388 to address managed-receipt-process-ownership race conditions causing terminal publication flakes (failed 4/6 test runs). Only agent-session.ts publication-edge revert applied; lifecycle, session-scope, retirement, and artifact-owner paths restored to dev to preserve cleanup and task-owner features.
