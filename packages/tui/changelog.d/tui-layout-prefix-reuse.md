### Performance

- Layout-only frames reuse a cached transcript prefix instead of copying and re-normalizing every row. Off-screen prefix identity is still checked by reference, and only the viewport window is normalized. Emitted bytes stay the same.
