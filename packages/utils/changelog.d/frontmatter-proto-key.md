### Fixed

- Frontmatter key normalization stores a `__proto__` key as own data, so a kebab-case key in that value cannot replace the returned object's prototype.
