### Fixed

- `/share` strips project-declared `BUNDLE_GEMFILE` so Bundler cannot evaluate the checkout's Gemfile in GitHub CLI children.
