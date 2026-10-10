// Prints the shell and shell prefix the shell config resolves in this process.
// Spawned with a controlled cwd so the caller can plant a project `.env`:
// `projectEnv` is parsed at module load from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { getShellConfig } from "../../src/procmgr";

const config = getShellConfig();
console.log(JSON.stringify({ shell: config.shell, prefix: config.prefix ?? null }));
