// Prints PI_COMPILED after the env module has applied its dotenv overlays.
// Spawned with a controlled cwd so the caller can plant a project `.env`.
import { $env } from "../../src/env";

console.log(JSON.stringify({ value: $env.PI_COMPILED ?? null }));
