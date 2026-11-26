import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as path from "node:path";
import { type ptree, TempDir } from "@gajae-code/utils";
import { ensureFileOpen, OPEN_FILE_IDLE_MS, refreshFile, syncContent } from "../src/lsp/client";
import type { LspClient, ServerConfig } from "../src/lsp/types";
import { fileToUri } from "../src/lsp/utils";

const TEST_SERVER: ServerConfig = {
	command: "test-lsp",
	fileTypes: ["ts"],
	rootMarkers: [],
};

interface SentMessage {
	method: string;
	uri: string;
}

/**
 * A client whose server stdin records every JSON-RPC message gjc writes.
 * With `backpressure`, each write completes on a later timer tick, like a full pipe.
 */
function createRecordingClient(
	cwd: string,
	options: { backpressure?: boolean } = {},
): { client: LspClient; sent: SentMessage[] } {
	const sent: SentMessage[] = [];
	const stdin = {
		write(chunk: string): number | Promise<number> {
			const body = JSON.parse(chunk.slice(chunk.indexOf("\r\n\r\n") + 4)) as {
				method: string;
				params: { textDocument: { uri: string } };
			};
			sent.push({ method: body.method, uri: body.params.textDocument.uri });
			return options.backpressure ? Bun.sleep(1).then(() => chunk.length) : chunk.length;
		},
		flush(): void {},
	};
	const client: LspClient = {
		name: "test-lsp",
		cwd,
		config: TEST_SERVER,
		proc: { stdin } as unknown as ptree.ChildProcess<"pipe">,
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
	return { client, sent };
}

describe("LSP open document release", () => {
	let tempDir: TempDir;
	let now: number;

	function advance(ms: number): void {
		now += ms;
		setSystemTime(new Date(now));
	}

	async function writeSource(name: string): Promise<string> {
		const filePath = path.join(tempDir.path(), name);
		await Bun.write(filePath, `export const ${name.replace(/\W/g, "_")} = 1;\n`);
		return filePath;
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-lsp-document-release-");
		now = Date.parse("2026-01-01T00:00:00Z");
		setSystemTime(new Date(now));
	});

	afterEach(() => {
		setSystemTime();
		tempDir.removeSync();
	});

	it("closes documents unused for the idle window before opening another, and drops their diagnostics", async () => {
		const { client, sent } = createRecordingClient(tempDir.path());
		const stale = await writeSource("stale.ts");
		const recent = await writeSource("recent.ts");
		const next = await writeSource("next.ts");

		await ensureFileOpen(client, stale);
		advance(OPEN_FILE_IDLE_MS - 60_000);
		await ensureFileOpen(client, recent);
		client.diagnostics.set(fileToUri(stale), { diagnostics: [], version: 1 });
		advance(60_000);
		sent.length = 0;

		await ensureFileOpen(client, next);

		expect(sent).toEqual([
			{ method: "textDocument/didClose", uri: fileToUri(stale) },
			{ method: "textDocument/didOpen", uri: fileToUri(next) },
		]);
		expect([...client.openFiles.keys()]).toEqual([fileToUri(recent), fileToUri(next)]);
		expect(client.diagnostics.has(fileToUri(stale))).toBe(false);
	});

	it("closes each idle document once when several documents open concurrently", async () => {
		const { client, sent } = createRecordingClient(tempDir.path(), { backpressure: true });
		const staleA = await writeSource("staleA.ts");
		const staleB = await writeSource("staleB.ts");
		const first = await writeSource("first.ts");
		const second = await writeSource("second.ts");

		await ensureFileOpen(client, staleA);
		await ensureFileOpen(client, staleB);
		advance(OPEN_FILE_IDLE_MS);
		sent.length = 0;

		await Promise.all([ensureFileOpen(client, first), ensureFileOpen(client, second)]);

		const closed = sent.filter(message => message.method === "textDocument/didClose").map(message => message.uri);
		expect(closed.sort()).toEqual([fileToUri(staleA), fileToUri(staleB)].sort());
		expect([...client.openFiles.keys()].sort()).toEqual([fileToUri(first), fileToUri(second)].sort());
	});

	it("keeps a document open while gjc operations keep using it", async () => {
		const { client, sent } = createRecordingClient(tempDir.path());
		const used = await writeSource("used.ts");
		const synced = await writeSource("synced.ts");

		await ensureFileOpen(client, used);
		await syncContent(client, synced, "export const synced = 2;\n");
		advance(OPEN_FILE_IDLE_MS - 1_000);
		await refreshFile(client, used);
		await syncContent(client, synced, "export const synced = 3;\n");
		advance(OPEN_FILE_IDLE_MS - 1_000);
		sent.length = 0;

		await ensureFileOpen(client, await writeSource("other.ts"));

		expect(sent.map(message => message.method)).toEqual(["textDocument/didOpen"]);
		expect(client.openFiles.has(fileToUri(used))).toBe(true);
		expect(client.openFiles.has(fileToUri(synced))).toBe(true);
	});

	it("closes an open document whose file was deleted when it is refreshed", async () => {
		const { client, sent } = createRecordingClient(tempDir.path());
		const deleted = await writeSource("deleted.ts");
		await ensureFileOpen(client, deleted);
		await Bun.file(deleted).delete();
		sent.length = 0;

		await refreshFile(client, deleted);

		expect(sent).toEqual([{ method: "textDocument/didClose", uri: fileToUri(deleted) }]);
		expect(client.openFiles.has(fileToUri(deleted))).toBe(false);
	});
});
