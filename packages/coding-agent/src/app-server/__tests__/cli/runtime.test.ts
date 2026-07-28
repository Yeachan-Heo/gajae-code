import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateJsonSchema,
	generateTs,
	type ResolvedAppServerConfig,
	resolveAppServerArgs,
	runStdioServer,
	writeStdioFrame,
} from "../../cli/runtime";

test("resolveAppServerArgs: defaults to stdio when no flags given", () => {
	const { mode } = resolveAppServerArgs({});
	expect(mode.kind).toBe("stdio");
});

test("resolveAppServerArgs: --stdio flag selects stdio", () => {
	const { mode } = resolveAppServerArgs({ stdio: true });
	expect(mode.kind).toBe("stdio");
});

test("resolveAppServerArgs: --listen ws://IP:PORT parses host and port with authentication", () => {
	const { mode } = resolveAppServerArgs({
		listen: "ws://0.0.0.0:8080",
		wsAuth: "capability-token",
		wsTokenSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	});
	expect(mode).toEqual({ kind: "ws", host: "0.0.0.0", port: 8080 });
});

test("resolveAppServerArgs: rejects non-loopback ws:// listeners without authentication", () => {
	expect(() => resolveAppServerArgs({ listen: "ws://0.0.0.0:8080" })).toThrow(
		/non-loopback ws:\/\/ listeners require authentication.*--ws-auth.*--ws-token-file/,
	);
});

test("resolveAppServerArgs: permits loopback ws:// listeners without authentication for local development", () => {
	const { mode, wsAuth } = resolveAppServerArgs({ listen: "ws://127.0.0.1:8080" });
	expect(mode).toEqual({ kind: "ws", host: "127.0.0.1", port: 8080 });
	expect(wsAuth).toBeUndefined();
});

test("resolveAppServerArgs: permits unix:// listeners without authentication because socket permissions are the boundary", () => {
	const { mode, wsAuth } = resolveAppServerArgs({ listen: "unix:///tmp/app-server.sock" });
	expect(mode).toEqual({ kind: "unix", path: "/tmp/app-server.sock" });
	expect(wsAuth).toBeUndefined();
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

test("resolveAppServerArgs: resolves WebSocket capability-token authentication", () => {
	const config = resolveAppServerArgs({
		listen: "ws://127.0.0.1:8080",
		wsAuth: "capability-token",
		wsTokenSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	});
	expect(config.wsAuth).toEqual({
		mode: "capability-token",
		tokenFile: undefined,
		expectedToken: undefined,
		tokenSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	});
});

test("resolveAppServerArgs: rejects WebSocket auth options without an auth mode", () => {
	expect(() => resolveAppServerArgs({ wsTokenFile: "/tmp/token" })).toThrow(/--ws-auth/);
});

const tempDir = mkdtempSync(join(tmpdir(), "gjc-app-server-cli-"));

test("resolveAppServerArgs: resolves a capability token before the listener can bind", () => {
	const tokenPath = join(tempDir, "startup-token");
	writeFileSync(tokenPath, "startup-capability-token");
	const config = resolveAppServerArgs({
		listen: "ws://127.0.0.1:8080",
		wsAuth: "capability-token",
		wsTokenFile: tokenPath,
	});
	expect(config.wsAuth?.expectedToken).toBe("startup-capability-token");
});

test("resolveAppServerArgs: fails before binding for invalid credential files", () => {
	const emptyTokenPath = join(tempDir, "empty-startup-token");
	const emptySecretPath = join(tempDir, "empty-startup-secret");
	writeFileSync(emptyTokenPath, "\n");
	writeFileSync(emptySecretPath, " \t");
	expect(() =>
		resolveAppServerArgs({
			listen: "ws://127.0.0.1:8080",
			wsAuth: "capability-token",
			wsTokenFile: emptyTokenPath,
		}),
	).toThrow(/must not be empty/);
	expect(() =>
		resolveAppServerArgs({
			listen: "ws://127.0.0.1:8080",
			wsAuth: "signed-bearer-token",
			wsSharedSecretFile: emptySecretPath,
		}),
	).toThrow(/must not be empty/);
});

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

test("runStdioServer: is exported and default args resolve to stdio mode (does NOT prove server construction)", async () => {
	// Scope note: this asserts argument resolution and export shape only. It does NOT
	// prove runStdioServer constructs a server or wires createAppServer; the real stdio pipe
	// requires a real stdin stream which the test harness cannot provide.
	const config: ResolvedAppServerConfig = resolveAppServerArgs({});
	expect(config.mode.kind).toBe("stdio");
	// runStdioServer() is not invoked here (it blocks on stdin). Real stdio wiring is
	// covered by the spawned black-box gate, which is currently BLOCKED.
	expect(typeof runStdioServer).toBe("function");
});

test("writeStdioFrame: waits for stdout drain before resolving backpressured writes", async () => {
	let drain: (() => void) | undefined;
	const writer = {
		write: () => false,
		once: (event: "drain" | "error", listener: (() => void) | ((error: Error) => void)) => {
			if (event === "drain") drain = listener as () => void;
		},
		off: () => {},
	};
	let settled = false;
	const pending = writeStdioFrame(writer, new Uint8Array()).then(() => {
		settled = true;
	});
	await Bun.sleep(0);
	expect(settled).toBe(false);
	drain!();
	await pending;
	expect(settled).toBe(true);
});

test("cleanup temp dir", () => {
	rmSync(tempDir, { recursive: true, force: true });
});
