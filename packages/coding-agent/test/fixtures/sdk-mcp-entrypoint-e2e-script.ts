// Entrypoint-level proof: gjc mcp-serve sdk speaks JSON-RPC over stdio and its
// session control reaches a recorded SDK WebSocket (no coordinator paths).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = await mkdtemp(path.join(tmpdir(), "mcp-sdk-e2e-"));
const received: string[] = [];
const server = Bun.serve<{ t: string }>({
	port: 0,
	fetch(req, srv) {
		if (srv.upgrade(req, { data: { t: "x" } })) return undefined;
		return new Response("nf", { status: 404 });
	},
	websocket: {
		open(ws) {
			ws.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "e2e" }));
		},
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as Record<string, unknown>;
			received.push(String(frame.type));
			if (frame.type === "query_request")
				ws.send(
					JSON.stringify({
						type: "query_response",
						id: frame.id,
						ok: true,
						page: { items: [{ sessionId: "s1" }], complete: true, revision: "1" },
					}),
				);
		},
	},
});
await mkdir(path.join(repo, ".gjc", "state", "sdk"), { recursive: true });
await writeFile(
	path.join(repo, ".gjc", "state", "sdk", "s1.json"),
	JSON.stringify({ url: `ws://127.0.0.1:${server.port}`, token: "tok" }),
);
const child = Bun.spawn(["bun", "run", path.resolve("src/cli.ts"), "mcp-serve", "sdk"], {
	cwd: repo,
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});
const writer = child.stdin;
writer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
writer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
writer.write(
	`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gjc_session_query", arguments: { sessionId: "s1", query: "session.metadata" } } })}\n`,
);
writer.write(
	`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gjc_session_global", arguments: { operation: "session.get_endpoint" } } })}\n`,
);
await writer.end();
const out = await new Response(child.stdout).text();
await child.exited;
server.stop(true);
await rm(repo, { recursive: true, force: true });
const lines = out
	.trim()
	.split("\n")
	.map(l => JSON.parse(l));
const byId = Object.fromEntries(lines.map(l => [l.id, l]));
if (byId[1]?.result?.serverInfo?.name !== "gjc-sdk-mcp") throw new Error(`initialize failed: ${out}`);
if (!byId[2]?.result?.tools?.some((t: { name: string }) => t.name === "gjc_session_query"))
	throw new Error("tools/list failed");
const queryText = JSON.parse(byId[3].result.content[0].text);
if (queryText.page?.items?.[0]?.sessionId !== "s1")
	throw new Error(`query did not reach the SDK socket: ${JSON.stringify(queryText)}`);
if (!received.includes("query_request")) throw new Error("no frame reached the recorded WS");
const g02 = JSON.parse(byId[4].result.content[0].text);
if (g02.ok !== false || !String(g02.error?.code ?? "").includes("endpoint_credential"))
	throw new Error(`G02 not rejected: ${JSON.stringify(g02)}`);
console.log("MCP-SDK-E2E-OK frames:", received.join(","));
