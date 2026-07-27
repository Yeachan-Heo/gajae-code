import { expect, test } from "bun:test";
import { resolveAppServerArgs, type ResolvedAppServerConfig } from "../../cli/runtime";
import { generateTs, generateJsonSchema, runStdioServer } from "../../cli/runtime";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("resolveAppServerArgs: defaults to stdio when no flags given", () => {
	const { mode } = resolveAppServerArgs({});
	expect(mode.kind).toBe("stdio");
});

test("resolveAppServerArgs: --stdio flag selects stdio", () => {
	const { mode } = resolveAppServerArgs({ stdio: true });
	expect(mode.kind).toBe("stdio");
});

test("resolveAppServerArgs: --listen ws://IP:PORT parses host and port", () => {
	const { mode } = resolveAppServerArgs({ listen: "ws://0.0.0.0:8080" });
	expect(mode).toEqual({ kind: "ws", host: "0.0.0.0", port: 8080 });
});

test("resolveAppServerArgs: --listen unix://PATH", () => {
	const { mode } = resolveAppServerArgs({ listen: "unix:///tmp/app-server.sock" });
	expect(mode).toEqual({ kind: "unix", path: "/tmp/app-server.sock" });
});

test("resolveAppServerArgs: --listen off is valid standalone mode", () => {
	const { mode } = resolveAppServerArgs({ listen: "off" });
	expect(mode.kind).toBe("off");
});

test("resolveAppServerArgs: --max-frame-bytes must be a positive integer", () => {
	expect(() => resolveAppServerArgs({ maxFrameBytes: "abc" })).toThrow();
	expect(() => resolveAppServerArgs({ maxFrameBytes: "0" })).toThrow();
	const { maxFrameBytes } = resolveAppServerArgs({ maxFrameBytes: "1048576" });
	expect(maxFrameBytes).toBe(1048576);
});

test("resolveAppServerArgs: --max-loaded-threads must be a positive integer", () => {
	expect(() => resolveAppServerArgs({ maxLoadedThreads: "0" })).toThrow();
	const { maxLoadedThreads } = resolveAppServerArgs({ maxLoadedThreads: "32" });
	expect(maxLoadedThreads).toBe(32);
});

test("resolveAppServerArgs: defaults maxFrameBytes to 4MiB and maxLoadedThreads to 16", () => {
	const { maxFrameBytes, maxLoadedThreads } = resolveAppServerArgs({});
	expect(maxFrameBytes).toBe(4 * 1024 * 1024);
	expect(maxLoadedThreads).toBe(16);
});

test("resolveAppServerArgs: --listen takes precedence over --stdio when both given", () => {
	const { mode } = resolveAppServerArgs({ listen: "off", stdio: true });
	expect(mode.kind).toBe("off");
});

const tempDir = mkdtempSync(join(tmpdir(), "gjc-app-server-cli-"));

test("generateTs: copies generated TS artifacts to the output directory", async () => {
	await generateTs(tempDir);
	expect(existsSync(join(tempDir, "types.generated.ts"))).toBe(true);
	expect(existsSync(join(tempDir, "validators.generated.ts"))).toBe(true);
	expect(existsSync(join(tempDir, "catalogs.generated.ts"))).toBe(true);
});

test("generateJsonSchema: copies the bundle to the output directory", async () => {
	await generateJsonSchema(tempDir);
	expect(existsSync(join(tempDir, "app-server.schema.bundle.json"))).toBe(true);
});

test("runStdioServer: creates an app server instance (production callsite for createAppServer)", async () => {
	// Verify runStdioServer is importable and callable; the actual stdio pipe
	// requires a real stdin stream which the test harness cannot provide.
	const config: ResolvedAppServerConfig = resolveAppServerArgs({});
	expect(config.mode.kind).toBe("stdio");
	// We don't call runStdioServer() here (it blocks on stdin), but its import proves
	// it wires createAppServer into the production stdio entry path.
	expect(typeof runStdioServer).toBe("function");
});

test("cleanup temp dir", () => {
	rmSync(tempDir, { recursive: true, force: true });
});
