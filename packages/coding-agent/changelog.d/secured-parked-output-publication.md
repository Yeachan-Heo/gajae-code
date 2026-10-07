### Fixed
- Publish large parked completion follow-ups through secured session artifact storage, preserving lifecycle and no-replace refusals instead of returning a successful preview.
- Distinguish complete artifacts from capped output and report omitted UTF-8 bytes accurately, including codepoints that cross the storage cap.
