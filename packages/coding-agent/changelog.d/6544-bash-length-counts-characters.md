### Fixed

- The Bash tool now counts characters instead of UTF-8 bytes for `${#var}`, so negative substring offsets such as `${var: -2}` select the right characters in non-ASCII values (#6544).
- A negative substring length now marks where the slice ends, as in bash (`${v:2:-2}` on `abcdefgh` is `cdef`), and an end before the offset or a negative length on an array fails with `substring expression < 0` instead of slicing the wrong range.
