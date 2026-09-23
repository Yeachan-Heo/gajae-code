// Bun test disposes per-file isolates without emitting process exit events.
// Run the same process-owned cleanup at the file's lifecycle boundary.
import { afterAll } from "bun:test";
import { cleanupIsolatedTempDirs } from "./test-preload";

afterAll(cleanupIsolatedTempDirs);
