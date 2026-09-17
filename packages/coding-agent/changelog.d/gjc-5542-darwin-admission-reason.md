### Fixed

- Managed owner admission now says why it blocked a child. A child that fails closed writes the
  platform and the exact-evidence reader state into its durable handoff and prints one reason line
  to stderr before exiting 75, instead of exiting silently. On platforms without the Linux-only
  recovery-fs authority this reports `exact binding reader unsupported` rather than leaving the
  operator with only the broker's registration-uncertain timeout.
