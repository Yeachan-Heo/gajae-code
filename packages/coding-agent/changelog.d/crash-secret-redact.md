### Fixed

- Crash egress now refuses a leftover 40-character AWS secret or percent-encoded `sessionid` cookie that the scrubber did not mask.
