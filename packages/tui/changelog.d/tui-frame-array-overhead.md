### Performance

- Skip the kitty placement scan on terminals that do not run the kitty graphics protocol, and keep the outgoing logical and raw frames by reference instead of copying them. Both removed a walk over every transcript line from every render frame; emitted bytes are unchanged.
