### Fixed

- Fixed intermittent "owner-not-live" errors when routing finalize requests to a newly started detached owner. The owner was registering its lease with a socket endpoint before the socket server started listening, creating a race condition where clients could find the lease but fail to connect. Socket now starts listening before the lease is acquired.
