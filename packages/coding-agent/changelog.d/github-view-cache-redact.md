### Fixed

- GitHub issue, pull request, and pull-request diff view cache rows scrub credential-shaped text, authenticated URLs, and home-directory paths before they are written to the local cache database, and scrub again when a row is read so entries written by an older binary are never served verbatim.
