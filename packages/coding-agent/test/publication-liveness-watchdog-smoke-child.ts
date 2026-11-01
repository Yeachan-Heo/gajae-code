/**
 * Child for the compiled-entrypoint smoke. Spawn with cwd = repository root
 * so the bun --compile worker literal resolves to the source tree.
 *
 * Usage: bun publication-liveness-watchdog-smoke-child.ts
 */
import { smokeTestPublicationLivenessWatchdog } from "../src/sdk/broker/publication-liveness-watchdog-smoke";

await smokeTestPublicationLivenessWatchdog({ compiled: true });
