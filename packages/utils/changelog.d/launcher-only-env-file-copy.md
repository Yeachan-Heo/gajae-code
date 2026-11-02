### Fixed

- The env module no longer copies per-launch managed-owner context (`GJC_MANAGED_OWNER_*`, `GJC_TMUX_OWNER_STATE_DIR`, `GJC_TMUX_OWNER_GENERATION`, `GJC_TMUX_OWNER_SERVER_KEY`, `GJC_TMUX_LAUNCHED`) from any env file layer: project dotenv, agent and config `.env`, home `.env`, or parsed shell startup files. Only a launcher or the managed-owner supervisor sets these, so a compiled binary or a library caller of `main()` no longer acquires owner context it did not inherit. Inherited values, including empty ones, are untouched.
