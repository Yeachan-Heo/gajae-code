// Prints harness directory overrides after the env module has applied its
// dotenv overlays. Spawned with a controlled cwd so the caller can plant a
// project `.env`, which is parsed at module load from `process.cwd()`.
// `controlSocketPath` and the harness root registry read these same process
// environment names after this module loads.
import { $env } from "../../src/env";

console.log(
	JSON.stringify({
		GJC_HARNESS_SOCKET_DIR: $env.GJC_HARNESS_SOCKET_DIR ?? null,
		GJC_HARNESS_ROOT_REGISTRY_DIR: $env.GJC_HARNESS_ROOT_REGISTRY_DIR ?? null,
	}),
);
