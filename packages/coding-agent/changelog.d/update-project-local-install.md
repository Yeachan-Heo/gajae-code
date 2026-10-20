### Fixed

- `gjc update` recognizes a project dependency install at `<project>/node_modules/.bin/gjc` — including the real `.exe` that Windows dependency installs place there — and refuses with package-manager instructions instead of downloading a replacement. Replacing that file broke the project's lockfile contract and failed on Windows with `acl_present`.
