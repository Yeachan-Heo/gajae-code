### Fixed

- Share Cursor HTTP/2 write error and close listeners across pending frames to avoid listener-limit warnings during write bursts while preserving write-failure and drain-timeout handling.
