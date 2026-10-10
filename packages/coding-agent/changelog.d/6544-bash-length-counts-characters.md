### Fixed

- The Bash tool now counts characters instead of UTF-8 bytes for `${#var}`, so negative substring offsets such as `${var: -2}` select the right characters in non-ASCII values (#6544).
