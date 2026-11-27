// Bun test disposes per-file isolates without emitting process exit events.
// Run the same process-owned cleanup at the file's lifecycle boundary.
import { afterAll } from "bun:test";
import { close as closeLogger } from "../packages/utils/src/logger";
import { cleanupIsolatedTempDirs } from "./test-preload";

afterAll(async () => {
	// A test that logged leaves the lazily initialized log file opening in the
	// background; finish it first, or it recreates the removed log directory.
	await closeLogger();
	cleanupIsolatedTempDirs();
});
