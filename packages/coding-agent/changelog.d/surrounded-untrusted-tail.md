### Fixed

- A tail-only tool-result cut keeps the opening untrusted-content tag on the retained tail when both the line budget and the byte budget have room for the tags, the trusted suffix, and one body line. A shortfall leaves the unfenced plain tail.
