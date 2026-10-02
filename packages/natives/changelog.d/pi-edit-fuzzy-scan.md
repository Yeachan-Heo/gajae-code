### Fixed

- Restored whole-block fuzzy `findMatch` speed after the pi-edit integration: content lines are normalized once per search and each target line is scored with a bit-parallel UTF-16 Levenshtein, so scores stay byte-identical while the scan is about 4x faster.
