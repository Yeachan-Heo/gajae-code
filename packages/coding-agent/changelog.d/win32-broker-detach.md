### Fixed

- Windows SDK broker now spawns directly with `detached:true` using Bun's UV_PROCESS_DETACHED flag, preventing it from being part of the parent's job. This ensures the broker and other clients' sessions survive when one client is force-terminated, without the complexity of cmd.exe wrapping that caused quoting, variable expansion, and discovery matching issues (issue #6007).
