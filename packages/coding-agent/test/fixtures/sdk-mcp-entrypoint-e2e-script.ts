// Entrypoint-level proof: `gjc mcp-serve sdk` speaks JSON-RPC over stdio and its
// session control reaches a recorded SDK WebSocket (no coordinator paths).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// fixtures/ -> test/ -> package root (packages/coding-agent)
const packageRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(packageRoot, "src", "cli.ts");

const repo = await mkdtemp(path.join(tmpdir(), "mcp-sdk-e2e-"));
const received: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;

const cleanup = async () => {
	if (child) {
		try {
			child.kill();
		} catch {
			// already exited
		}
		try {
			await Promise.race([child.exited, Bun.sleep(2_000)]);
		} catch {
			// ignore
		}
		child = undefined;
	}
	if (server) {
		try {
			server.stop(true);
		} catch {
			// ignore
		}
		server = undefined;
	}
	await rm(repo, { recursive: true, force: true });
};

try {
	server = Bun.serve<{ t: string }>({
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

	// Default: package source under test (CI monorepo with natives).
	// Override with GJC_MCP_E2E_BIN for local machines lacking matching natives.
	const explicitBin = process.env.GJC_MCP_E2E_BIN?.trim();
	const spawnCmd =
		explicitBin && explicitBin.length > 0
			? [explicitBin, "mcp-serve", "sdk"]
			: ["bun", "run", cliEntry, "mcp-serve", "sdk"];
	const proc = Bun.spawn(spawnCmd, {
		cwd: repo,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	child = proc;
	proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
	proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
	proc.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gjc_session_query", arguments: { sessionId: "s1", query: "session.metadata" } } })}\n`,
	);
	proc.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gjc_session_global", arguments: { operation: "session.get_endpoint" } } })}\n`,
	);
	await proc.stdin.end();

	// Bound wait: kill the child if it does not exit after stdin EOF so the outer
	// suite never sits on an open stdout pipe for the full 60s.
	const outPromise = new Response(proc.stdout).text();
	const errPromise = new Response(proc.stderr).text();
	const exitState = await Promise.race([
		proc.exited.then(code => ({ kind: "exit" as const, code })),
		Bun.sleep(15_000).then(() => ({ kind: "timeout" as const })),
	]);
	if (exitState.kind === "timeout") {
		try {
			child.kill();
		} catch {
			// ignore
		}
	}
	const [out, err] = await Promise.all([outPromise, errPromise]);
	const exitCode = exitState.kind === "exit" ? exitState.code : await child.exited;
	if (exitState.kind === "timeout") {
		throw new Error(`mcp-serve sdk did not exit within 15s after stdin EOF\nstdout:\n${out}\nstderr:\n${err}`);
	}
	if (exitCode !== 0) {
		throw new Error(`mcp-serve sdk exited ${exitCode}\nstdout:\n${out}\nstderr:\n${err}`);
	}

	const lines = out
		.trim()
		.split("\n")
		.filter(Boolean)
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
} catch (error) {
	await cleanup();
	throw error;
}
await cleanup();
