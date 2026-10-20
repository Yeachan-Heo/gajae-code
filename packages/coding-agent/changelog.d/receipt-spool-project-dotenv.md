### Fixed

- A project dotenv entry can no longer choose the harness receipt spool directory, including when a command forwards that value to an owner started elsewhere. `spool.jsonl` is opened without following a final-component symlink, and an existing spool file is tightened to owner-only mode before a receipt is appended.
