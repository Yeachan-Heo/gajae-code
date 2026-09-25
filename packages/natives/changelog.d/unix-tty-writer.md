Added the Unix-only `TtyWriter` N-API class, which queues UTF-8 output to a dedicated thread, tracks pending bytes, detects dead terminal fds, and supports bounded exit flushing.
