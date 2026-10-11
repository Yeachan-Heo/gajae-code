// Prints the TLS verification switch after the env module has applied its
// dotenv overlays. Spawned with a controlled cwd so the caller can plant a
// project `.env`, which is parsed at module load from `process.cwd()`.
import { $env } from "../../src/env";

console.log(JSON.stringify({ value: $env.NODE_TLS_REJECT_UNAUTHORIZED ?? null }));
