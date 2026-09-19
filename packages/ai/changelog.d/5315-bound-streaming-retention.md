### Performance

- Drain completion-only stream events instead of retaining them, close idle-iterator sources once on early exit, and avoid repeated suffix scans in escape-dense JSON.
