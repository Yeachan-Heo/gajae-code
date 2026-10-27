// Prints GJC_SDK_DISABLE after the env module has applied its dotenv overlays.
// Spawned with a controlled cwd so the caller can plant a project `.env`.
// Session startup and the harness owner read this same process environment
// name after this module loads, including in a child that inherits it.
import { $env } from "../../src/env";

console.log(JSON.stringify({ value: $env.GJC_SDK_DISABLE ?? null }));
