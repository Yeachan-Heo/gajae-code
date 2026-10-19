### Fixes

- **bash tool**: Complete removal of default CI=true injection. PR #6937 removed CI from the non-interactive constant but the underlying buildSpawnEnv() function in shell-config.ts still injected CI by default. This prevented tools like node-llama-cpp and test runners from running correctly, as they change behavior when CI=true is present. The injection is now completely removed; CI is only present in the spawned bash environment if inherited from the parent process.
