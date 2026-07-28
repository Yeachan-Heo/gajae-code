import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionState } from "../../router/connection-state";
import { processInbound } from "../../server";
import {
	configReadHandler,
	fsCreateDirectoryHandler,
	fsGetMetadataHandler,
	fsReadDirectoryHandler,
	fsReadFileHandler,
	fsRemoveHandler,
	fsWriteFileHandler,
	HandlerRegistry,
	modelListHandler,
	registerBuiltinHandlers,
} from "../../suites/handlers";
import { ThreadRuntimeManager } from "../../thread-runtime/thread-runtime-manager";

const tempDir = mkdtempSync(join(tmpdir(), "gjc-app-server-suites-"));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) =>
	b ? (JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>) : undefined;

test("HandlerRegistry: register, look up, unregister", async () => {
	const reg = new HandlerRegistry();
	reg.register("test/method", () => ({ ok: true, result: 42 }));
	expect(reg.has("test/method")).toBe(true);
	expect(reg.get("test/method")).toBeDefined();
	expect(reg.has("other/method")).toBe(false);
	expect(reg.unregister("test/method")).toBe(true);
	expect(reg.has("test/method")).toBe(false);
});

test("fs/readFile: returns base64 data for a file", async () => {
	const path = join(tempDir, "read-test.txt");
	writeFileSync(path, "hello world");
	const result = await fsReadFileHandler({ path });
	expect(result.ok).toBe(true);
	if (result.ok) {
		const r = result.result as Record<string, unknown>;
		expect(Buffer.from(r.dataBase64 as string, "base64").toString()).toBe("hello world");
	}
});

test("fs/readFile: missing path param returns invalidParams", async () => {
	expect(fsReadFileHandler({})).toMatchObject({ ok: false, errorKey: "invalidParams" });
});

test("fs/readFile: non-existent file returns notFound", async () => {
	expect(fsReadFileHandler({ path: "/nonexistent/file/path" })).toMatchObject({ ok: false, errorKey: "notFound" });
});

test("fs/writeFile: writes base64 data to a file", async () => {
	const path = join(tempDir, "write-test.txt");
	const result = await fsWriteFileHandler({ path, dataBase64: Buffer.from("written content").toString("base64") });
	expect(result.ok).toBe(true);
	const { readFileSync } = require("node:fs");
	expect(readFileSync(path, "utf-8")).toBe("written content");
});

test("fs/writeFile: creates parent directories recursively", async () => {
	const path = join(tempDir, "subdir", "nested", "file.txt");
	const result = await fsWriteFileHandler({ path, dataBase64: "dGVzdA==" });
	expect(result.ok).toBe(true);
});

test("fs/getMetadata: returns file metadata", async () => {
	const path = join(tempDir, "meta-test.txt");
	writeFileSync(path, "content");
	const result = await fsGetMetadataHandler({ path });
	expect(result.ok).toBe(true);
	if (result.ok) {
		const r = result.result as Record<string, unknown>;
		expect(r.isFile).toBe(true);
		expect(r.isDirectory).toBe(false);
		expect(typeof r.createdAtMs).toBe("number");
	}
});

test("fs/readDirectory: lists entries", async () => {
	mkdirSync(join(tempDir, "listdir"), { recursive: true });
	writeFileSync(join(tempDir, "listdir", "file-a.txt"), "a");
	writeFileSync(join(tempDir, "listdir", "file-b.txt"), "b");
	const result = await fsReadDirectoryHandler({ path: join(tempDir, "listdir") });
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect((result.result as { entries: unknown[] }).entries).toHaveLength(2);
	}
});

test("fs/createDirectory: creates a directory", async () => {
	const path = join(tempDir, "created-dir");
	const result = await fsCreateDirectoryHandler({ path });
	expect(result.ok).toBe(true);
});

test("fs/remove: removes a file", async () => {
	const path = join(tempDir, "to-remove.txt");
	writeFileSync(path, "x");
	const result = await fsRemoveHandler({ path });
	expect(result.ok).toBe(true);
});

test("config/read: returns ConfigReadResponse shape with codexHome set to gjc agent dir", async () => {
	const result = await configReadHandler({});
	expect(result.ok).toBe(true);
	if (result.ok) {
		const r = result.result as Record<string, unknown>;
		expect(r).toHaveProperty("config");
		expect(r).toHaveProperty("origins");
		const config = r.config as Record<string, unknown>;
		expect(typeof config.codexHome).toBe("string");
		expect(config.codexHome).toContain("gjc");
	}
});

test("model/list: returns ModelListResponse shape with data array", async () => {
	const result = await modelListHandler({});
	expect(result.ok).toBe(true);
	if (result.ok) {
		const r = result.result as Record<string, unknown>;
		expect(Array.isArray(r.data)).toBe(true);
		expect(r).toHaveProperty("nextCursor");
	}
});

test("registerBuiltinHandlers: registers all built-in methods", async () => {
	const reg = new HandlerRegistry();
	registerBuiltinHandlers(reg);
	expect(reg.has("fs/readFile")).toBe(true);
	expect(reg.has("fs/writeFile")).toBe(true);
	expect(reg.has("config/read")).toBe(true);
	expect(reg.has("model/list")).toBe(true);
	expect(reg.has("skills/list")).toBe(true);
	expect(reg.has("hooks/list")).toBe(true);
});

test("processInbound + handler registry: fs/readFile dispatched through the server", async () => {
	const path = join(tempDir, "dispatch-test.txt");
	writeFileSync(path, "dispatched content");
	const s = new ConnectionState();
	const mgr = new ThreadRuntimeManager();
	const reg = new HandlerRegistry();
	registerBuiltinHandlers(reg);
	// Initialize handshake
	await processInbound(s, mgr, enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'), undefined, "websocket", reg);
	await processInbound(s, mgr, enc('{"method":"initialized"}'), undefined, "websocket", reg);
	// Dispatch fs/readFile through the handler registry
	const result = await processInbound(
		s,
		mgr,
		enc(`{"id":2,"method":"fs/readFile","params":{"path":"${path}"}}`),
		undefined,
		"websocket",
		reg,
	);
	const parsed = dec(result.response)!;
	expect(parsed.id).toBe(2);
	const res = parsed.result as Record<string, unknown>;
	expect(Buffer.from(res.dataBase64 as string, "base64").toString()).toBe("dispatched content");
});

test("processInbound: unregistered method falls through to notSupported", async () => {
	const s = new ConnectionState();
	const mgr = new ThreadRuntimeManager();
	const reg = new HandlerRegistry();
	registerBuiltinHandlers(reg);
	await processInbound(s, mgr, enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'), undefined, "websocket", reg);
	await processInbound(s, mgr, enc('{"method":"initialized"}'), undefined, "websocket", reg);
	const result = await processInbound(
		s,
		mgr,
		enc('{"id":2,"method":"collaborationMode/list","params":{}}'),
		undefined,
		"websocket",
		reg,
	);
	const parsed = dec(result.response)!;
	expect((parsed.error as Record<string, unknown>).code).toBe(-32081);
});

test("cleanup temp dir", async () => {
	rmSync(tempDir, { recursive: true, force: true });
	expect(true).toBe(true);
});
