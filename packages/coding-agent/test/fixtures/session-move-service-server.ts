import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2];

function sendMcp(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runMcp(): Promise<void> {
	let roots: Array<{ uri: string; name?: string }> = [];
	const rootsReady = Promise.withResolvers<void>();
	const rootRequestId = "fixture-roots-list";
	for await (const line of consoleLines()) {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (message.id === rootRequestId && typeof message.result === "object" && message.result !== null) {
			const result = message.result as { roots?: Array<{ uri: string; name?: string }> };
			roots = result.roots ?? [];
			rootsReady.resolve();
			continue;
		}
		if (message.method === "initialize") {
			const params = message.params as { protocolVersion?: string } | undefined;
			sendMcp({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: params?.protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "session-move-fixture", version: "1" },
				},
			});
			continue;
		}
		if (message.method === "notifications/initialized") {
			sendMcp({ jsonrpc: "2.0", id: rootRequestId, method: "roots/list", params: {} });
			continue;
		}
		if (message.method === "tools/list") {
			sendMcp({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					tools: [
						{
							name: "root_probe",
							description: "Report the process cwd, its marker file, and the MCP roots/list response.",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				},
			});
			continue;
		}
		if (message.method === "tools/call") {
			await Promise.race([rootsReady.promise, Bun.sleep(2_000)]);
			const marker = (await Bun.file(path.join(process.cwd(), "workspace.txt")).text()).trim();
			sendMcp({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					content: [
						{
							type: "text",
							text: JSON.stringify({ cwd: process.cwd(), marker, roots }),
						},
					],
				},
			});
		}
	}
}

async function* consoleLines(): AsyncGenerator<string> {
	let pending = "";
	for await (const chunk of process.stdin) {
		pending += Buffer.from(chunk).toString("utf8");
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			const line = pending.slice(0, newline).trim();
			pending = pending.slice(newline + 1);
			if (line) yield line;
		}
	}
}

function sendLsp(message: Record<string, unknown>): void {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

async function runLsp(): Promise<void> {
	let workspaceRoot = process.cwd();
	let buffer = Buffer.alloc(0);
	for await (const chunk of process.stdin) {
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
		for (;;) {
			const boundary = buffer.indexOf("\r\n\r\n");
			if (boundary < 0) break;
			const header = buffer.subarray(0, boundary).toString("ascii");
			const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
			if (!Number.isSafeInteger(length) || length < 0) process.exit(1);
			const end = boundary + 4 + length;
			if (buffer.length < end) break;
			const message = JSON.parse(buffer.subarray(boundary + 4, end).toString("utf8")) as {
				id?: string | number;
				method?: string;
				params?: Record<string, unknown>;
			};
			buffer = buffer.subarray(end);
			if (message.method === "initialize") {
				const rootUri = message.params?.rootUri;
				if (typeof rootUri === "string") workspaceRoot = fileURLToPath(rootUri);
				sendLsp({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						capabilities: { definitionProvider: true, textDocumentSync: 1 },
						serverInfo: { name: "session-move-fixture", version: "1" },
					},
				});
			} else if (message.method === "initialized") {
				sendLsp({
					jsonrpc: "2.0",
					method: "$/progress",
					params: { token: "fixture-load", value: { kind: "begin" } },
				});
				sendLsp({
					jsonrpc: "2.0",
					method: "$/progress",
					params: { token: "fixture-load", value: { kind: "end" } },
				});
			} else if (
				["textDocument/didOpen", "textDocument/didChange", "textDocument/didSave"].includes(message.method ?? "")
			) {
				const document = message.params?.textDocument as { uri?: string; version?: number } | undefined;
				if (document?.uri) {
					sendLsp({
						jsonrpc: "2.0",
						method: "textDocument/publishDiagnostics",
						params: {
							uri: document.uri,
							version: document.version,
							diagnostics: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
									severity: 2,
									source: "session-move-fixture",
									message: `fixture workspace ${workspaceRoot}`,
								},
							],
						},
					});
				}
			} else if (message.method === "textDocument/definition") {
				sendLsp({
					jsonrpc: "2.0",
					id: message.id,
					result: [
						{
							uri: pathToFileURL(path.join(workspaceRoot, "definition.move")).href,
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
						},
					],
				});
			} else if (message.method === "shutdown") {
				sendLsp({ jsonrpc: "2.0", id: message.id, result: null });
			} else if (message.method === "exit") {
				process.exit(0);
			}
		}
	}
}

if (mode === "mcp") await runMcp();
else if (mode === "lsp") await runLsp();
else process.exitCode = 2;
