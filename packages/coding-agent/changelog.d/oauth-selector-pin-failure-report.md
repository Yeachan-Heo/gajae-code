### Fixed

- Choosing an OAuth account or AUTO in `/login` no longer crashes GJC with an unhandled rejection when the session refuses the credential write (for example a shared session that refuses the publication); the selector stays open and shows the error so you can retry or pick another row.
