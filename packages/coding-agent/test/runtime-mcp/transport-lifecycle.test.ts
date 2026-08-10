import { afterEach, describe, expect, test, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@gajae-code/utils";
import { disposeAllOwnedProcesses, liveOwnedProcessCount } from "../../src/runtime/process-lifecycle";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";
import { StdioTransport } from "../../src/runtime-mcp/transports/stdio";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

function processState(pid: number): string {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "?";
		return `state=${state}`;
	} catch {
		return "gone";
	}
}

/**
 * Whether a pid is alive. A zombie (state Z) is NOT alive: it executes no code
 * and only its reaping remains, which is the parent reaper's job. Counting
 * zombies as alive makes the teardown assertions hostage to an external reaper
 * (PID 1 under shard load), which is exactly what previously timed this test
 * out. Non-Linux falls back to signal-0 probing.
 */
function isAlive(pid: number): boolean {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
			if (state === "Z" || state === "X") return false;
		} catch {
			// No such process (or it raced out of the table).
			return false;
		}
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Wait for the fixture's grandchild pid file. The fixture writes its root pid
 * first and the spawned grandchild pid second, so a timeout here is a fixture
 * readiness failure (root never became ready), not a product teardown failure
 * — the error surfaces the root's live state for diagnosis instead of hanging.
 */
async function waitForPid(childPidFile: string, rootPidFile: string): Promise<number> {
	try {
		// The readiness window is bounded well under the test budget so a dead
		// fixture surfaces the diagnostic below instead of a bare timeout.
		await waitFor(async () => {
			const text = await Bun.file(childPidFile)
				.text()
				.catch(() => "");
			return Number(text) > 0;
		}, 4_000);
		return Number(await Bun.file(childPidFile).text());
	} catch (error) {
		const rootPid = Number(
			(await Bun.file(rootPidFile)
				.text()
				.catch(() => "")) || 0,
		);
		const rootInfo = rootPid > 0 ? `${rootPid} ${processState(rootPid)}` : "no root pid file written";
		throw new Error(
			`fixture readiness failed: grandchild pid file never appeared; root=${rootInfo} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

const servers: Bun.Server<unknown>[] = [];
const STDIO_LIFECYCLE_ISOLATION = "GJC_TEST_MCP_STDIO_LIFECYCLE_ISOLATED";

async function runIsolatedStdioLifecycleTest(): Promise<void> {
	const child = Bun.spawn(
		[process.execPath, "test", import.meta.path, "--test-name-pattern", "close and reconnect dispose"],
		{
			cwd: join(import.meta.dir, "..", ".."),
			env: { ...process.env, [STDIO_LIFECYCLE_ISOLATION]: "1" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}

afterEach(async () => {
	try {
		await Promise.all(servers.splice(0).map(server => server.stop(true)));
	} finally {
		await disposeAllOwnedProcesses();
	}
});

describe("MCP stdio transport lifecycle", () => {
	test("close and reconnect dispose the old owned child tree", async () => {
		vi.restoreAllMocks();
		if (process.env[STDIO_LIFECYCLE_ISOLATION] !== "1") {
			await runIsolatedStdioLifecycleTest();
			return;
		}
		const before = liveOwnedProcessCount();
		const base = `/tmp/gjc-mcp-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const rootPidFile = `${base}.root.pid`;
		const childPidFile = `${base}.child.pid`;
		// The fixture root runs on the already-resident Bun runtime and reports
		// its own pid first and the spawned grandchild pid second, so readiness
		// is observable and distinguishable from the transport's close/reconnect
		// ownership contract below.
		const command = [
			process.execPath,
			join(import.meta.dir, "fixtures", "stdio-process-tree.ts"),
			childPidFile,
			rootPidFile,
		];
		const transport = new StdioTransport({ command: command[0], args: command.slice(1), timeout: 500 });
		await transport.connect();
		const oldChildPid = await waitForPid(childPidFile, rootPidFile);
		expect(isAlive(oldChildPid)).toBe(true);

		await transport.close();
		await waitFor(() => !isAlive(oldChildPid));
		expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);

		await Bun.write(childPidFile, "");
		await transport.connect();
		const newChildPid = await waitForPid(childPidFile, rootPidFile);
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
	test("redacts background SSE parser diagnostics without changing error or close handling", async () => {
		const credential = "sse-query-credential";
		const rawSseMarker = "MALICIOUS_SSE_PAYLOAD_MARKER";
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`data: ${rawSseMarker}\n\n`));
						controller.close();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		servers.push(server);
		const url = `${server.url.href}?access_token=${credential}`;
		const transport = new HttpTransport({ type: "http", url, timeout: 1_000 });
		const errors: Error[] = [];
		let closeCount = 0;
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		let closed = false;

		try {
			transport.onError = error => errors.push(error);
			transport.onClose = () => {
				closeCount += 1;
			};

			await transport.connect();
			await transport.startSSEListener();
			await waitFor(() => errors.length === 1 && closeCount === 1);

			expect(errors[0]).toBeInstanceOf(SyntaxError);
			expect(debugSpy).toHaveBeenCalledTimes(1);
			expect(debugSpy).toHaveBeenCalledWith("HTTP SSE stream error");
			expect(infoSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();

			await transport.close();
			closed = true;
			expect(closeCount).toBe(2);
		} finally {
			try {
				if (!closed) await transport.close();
			} finally {
				vi.restoreAllMocks();
			}
		}
	});
});
