### Fixed

- **Broker generation recovery** (#7879): Sessions with failed initial broker registrations now properly re-register with successor brokers when broker generation changes. The notification bus properly handles attachment transitions, and session-ready publication IDs are scoped by generation to prevent duplicate publications. The fix ensures the notification state machine transitions cleanly when a broker generation changes after initial registration failure.
