### Changed

- Tool results now have a 12 KB inline cap by default (`tools.maxInlineResultBytes`, previously 0 = off). Larger results keep their head and tail inline, and the full text is saved behind an `artifact://` reference. A live A/B on claude-haiku-4-5, gpt-5.5, and gpt-5.6-luna cut tool-result characters per task by 34–57% with task success unchanged (45/45). Set the value to `0` to restore uncapped inline results (#5945).

### Fixed

- The inline-result cap never truncates output it cannot store as an artifact. Standalone `gjc read` has no session artifact store, so it prints the full output, and it now honors the configured `tools.*` output settings (#5945).
