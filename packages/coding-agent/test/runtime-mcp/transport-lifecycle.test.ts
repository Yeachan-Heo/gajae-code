import { afterEach, describe, expect, test } from "bun:test";
import { liveOwnedProcessCount } from "../../src/runtime/process-lifecycle";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";
import { StdioTransport } from "../../src/runtime-mcp/transports/stdio";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await server.stop(true);
	}
});

describe("MCP stdio transport lifecycle", () => {
	test("close and reconnect dispose the old owned child tree", async () => {
		const before = liveOwnedProcessCount();
		const pidFile = `/tmp/gjc-mcp-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`;
		const command = [
			"node",
			"-e",
			`const fs=require('fs'); const cp=require('child_process'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(()=>{},1000);`,
		];
		const transport = new StdioTransport({ command: command[0], args: command.slice(1), timeout: 500 });
		await transport.connect();
		await waitFor(() => Bun.file(pidFile).exists());
		const oldChildPid = Number(await Bun.file(pidFile).text());
		expect(isAlive(oldChildPid)).toBe(true);

		await transport.close();
		await waitFor(() => !isAlive(oldChildPid));
		expect(liveOwnedProcessCount()).toBe(before);

		await Bun.write(pidFile, "");
		await transport.connect();
		await waitFor(async () => {
			const text = await Bun.file(pidFile)
				.text()
				.catch(() => "");
			return Number(text) > 0;
		});
		const newChildPid = Number(await Bun.file(pidFile).text());
		expect(newChildPid).not.toBe(oldChildPid);
		expect(isAlive(oldChildPid)).toBe(false);
		await transport.close();
		await waitFor(() => !isAlive(newChildPid));
	});
});

describe("MCP HTTP transport lifecycle", () => {
	test("request timeout covers hanging response bodies after headers", async () => {
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 100 });
		await transport.connect();
		await expect(transport.request("tools/list")).rejects.toThrow("Request timeout after 100ms");
		await transport.close();
	});

	test("per-request SSE closes after matching response", async () => {
		let nextId: string | number = "1";
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			async fetch(req) {
				const request = (await req.json()) as { id?: string | number };
				nextId = request.id ?? nextId;
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: {"jsonrpc":"2.0","id":${JSON.stringify(nextId)},"result":{"ok":true}}\n\n`,
							),
						);
						controller.close();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 1_000 });
		await transport.connect();
		await expect(transport.request("tools/list")).resolves.toEqual({ ok: true });

		await transport.close();
	});

	test("failed GET SSE listener cancels the response body", async () => {
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				const stream = new ReadableStream({
					start(controller) {
						controller.close();
					},
				});
				return new Response(stream, { status: 500 });
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 1_000 });
		await transport.connect();
		await transport.startSSEListener();

		await transport.close();
	});
});
