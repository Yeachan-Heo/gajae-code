import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../create-app-server";

const tempDir = mkdtempSync(join(tmpdir(), "gjc-app-server-assembly-"));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
	b ? (JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>) : undefined;

test("createAppServer: production wiring with built-in handlers registered", async () => {
	const server = createAppServer();
	expect(server.registry.has("fs/readFile")).toBe(true);
	expect(server.registry.has("config/read")).toBe(true);
	expect(server.registry.has("model/list")).toBe(true);
});

test("createAppServer: end-to-end initialize + fs/readFile through production pipeline", async () => {
	const path = join(tempDir, "prod-test.txt");
	writeFileSync(path, "production wiring works");
	const server = createAppServer();
	// Initialize handshake
	await server.process(
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0.0"}}}'),
	);
	await server.process(enc('{"method":"initialized"}'));
	// fs/readFile through the production pipeline
	const result = await server.process(enc(`{"id":2,"method":"fs/readFile","params":{"path":"${path}"}}`));
	const parsed = dec(result.response)!;
	expect(parsed.id).toBe(2);
	const res = parsed.result as Record<string, unknown>;
	expect(Buffer.from(res.dataBase64 as string, "base64").toString()).toBe("production wiring works");
});

test("createAppServer: config/read returns codexHome populated", async () => {
	const server = createAppServer();
	await server.process(
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0.0"}}}'),
	);
	await server.process(enc('{"method":"initialized"}'));
	const result = await server.process(enc('{"id":2,"method":"config/read","params":{}}'));
	const parsed = dec(result.response)!;
	const res = parsed.result as Record<string, unknown>;
	const config = res.config as Record<string, unknown>;
	expect(typeof config.codexHome).toBe("string");
});

test("createAppServer: each connection gets independent state", async () => {
	const a = createAppServer();
	const b = createAppServer();
	a.process(enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1.0.0"}}}'));
	expect(a.state.initialized).toBe(false); // needs initialized notification
	expect(b.state.initialized).toBe(false);
	a.process(enc('{"method":"initialized"}'));
	expect(a.state.initialized).toBe(true);
	expect(b.state.initialized).toBe(false); // independent
});

test("cleanup", async () => {
	rmSync(tempDir, { recursive: true, force: true });
});
