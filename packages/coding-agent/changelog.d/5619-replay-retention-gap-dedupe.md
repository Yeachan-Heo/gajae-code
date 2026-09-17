### Fixed

- Chat daemon replay retention-gap concessions now warn once per session stream and gap range. Reconnect and polling duplicates are demoted to debug, while a new gap range still emits the original warning; the bounded memo prevents long-running daemons from retaining unbounded stream history (issue #5619).
