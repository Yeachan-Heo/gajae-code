### Fixed

- `globPaths` with `gitignore: true` now excludes files inside a directory ignored without a trailing slash (`dist`, `/build`, `app/generated`), matching git; previously only the directory entry itself was excluded and its contents leaked into results.
