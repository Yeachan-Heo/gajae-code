### Changed
- Selecting a long conversation or sending a message in it no longer re-reads its whole transcript to check whether the terminal changed it. The app now checks the file's size and timestamps first and reads the transcript only when they changed.
