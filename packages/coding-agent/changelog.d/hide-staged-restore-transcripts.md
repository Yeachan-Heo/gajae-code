### Fixed
- Managed session inventory (resume picker, `--continue`, session lists and SDK candidate listing) now skips dot-prefixed `.jsonl` files, as explicit session directories already did, so the hidden staging copy that memory-guard checkpoint restore writes (`.<session-id>.memory-guard.<uuid>.jsonl`) is never listed or resumed in place of the original session.
