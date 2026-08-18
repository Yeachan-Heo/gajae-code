/**
 * Lifecycle smoke over raw ACP stdio.
 *
 * `initialize` advertises `sessionCapabilities` for list/fork/resume/close/delete,
 * but the pinned upstream `acp-core-v1` corpus exercises none of them, so the
 * advertised surface has no release-gate coverage. This closes that hole by
 * driving the credential-free conformance fixture over real JSON-RPC frames.
 *
 * Excluded from default `bun test` discovery via `bunfig.toml`
 * `[test] pathIgnorePatterns` because it spawns a broker plus a session host and
 * costs tens of seconds; it is a *dedicated-only* test (see ci-dev-affected.ts
 * DEDICATED_ONLY_TESTS), so the fresh-process shard inventory skips it too.
 * Naming this path on the command line does NOT re-include it -- `bun test
 * <path>` filters files that were already discovered, so a pruned file can never
 * match. The only way in is to override that list with `--path-ignore-patterns`,
 * which is exactly what the canonical dedicated argv
 * (ci-dev-affected.ts dedicatedTestCommand) does; every planner and CI route
 * runs the suite through that argv, never a bare `bun test <file>`.
 *
 * Deliberately NOT covered: the unknown-session error *shape*. `close`/`delete` on
 * an unowned session no-op by design -- `AcpAgent.closeSession` documents "only
 * connection-owned sessions may reach broker lifecycle control" -- while
 * `resume`/`prompt` reject. Whether that asymmetry and its `-32603` code are
 * right is undecided, and pinning it here would cement an unreviewed contract.
 * The post-close prompt below therefore asserts only that the call is REJECTED,
 * never its code or message, so renaming or re-coding that error stays free.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

setDefaultTimeout(180_000);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const FIXTURE_AGENT = path.join(REPO_ROOT, "packages/coding-agent/scripts/acp-conformance-agent.ts");
const REQUEST_TIMEOUT_MS = 120_000;
const DISPOSE_REQUEST_TIMEOUT_MS = 5_000;
const DISPOSE_EXIT_GRACE_MS = 2_000;
const FIXTURE_READY_TIMEOUT_MS = 30_000;
/** Enough fixture stderr to diagnose a startup or broker failure, not enough to flood CI logs. */
const STDERR_TAIL_LIMIT = 4_000;
/**
 * stdout and stderr are independent streams, so a malformed frame can reach the
 * reader before the stderr chunk explaining it has been drained. Terminal
 * failures wait this long for that drain, because an unexplained failure is the
 * exact thing this client exists to avoid.
 */
const STDERR_DRAIN_MS = 2_000;

interface RpcError {
	code: number;
	message: string;
}

interface RpcFrame {
	jsonrpc?: unknown;
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: RpcError;
}

interface SessionCapabilities {
	list?: unknown;
	fork?: unknown;
	resume?: unknown;
	close?: unknown;
	delete?: unknown;
}

interface InitializeResult {
	agentCapabilities?: { sessionCapabilities?: SessionCapabilities };
}

interface SessionRow {
	sessionId?: unknown;
	cwd?: unknown;
	title?: unknown;
	updatedAt?: unknown;
}

interface PendingRequest {
	method: string;
	resolve(frame: RpcFrame): void;
	reject(error: Error): void;
}

function fixtureEnvironment(cwd: string, ambient: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const home = path.join(cwd, ".acp-fixture-home");
	return {
		PATH: ambient.PATH ?? "",
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_CACHE_HOME: path.join(home, "cache"),
		XDG_STATE_HOME: path.join(home, "state"),
		TMPDIR: cwd,
		GJC_ACP_CONFORMANCE_CWD: cwd,
	};
}

/**
 * The peer answered with a JSON-RPC error frame. Distinct from transport,
 * timeout, framing, and harness failures so a probe that expects a protocol
 * rejection cannot be satisfied by the client simply falling over.
 */
class AcpPeerRejection extends Error {
	readonly code: number;

	constructor(method: string, error: RpcError) {
		super(`ACP request rejected: ${method}: ${error.code} ${error.message}`);
		this.name = "AcpPeerRejection";
		this.code = error.code;
	}
}

/**
 * Minimal newline-delimited JSON-RPC client. Only what the lifecycle surface
 * needs: correlated requests, and a record of which notification methods
 * arrived.
 *
 * Every way the peer can die -- malformed frame, closed stdout, process exit --
 * fails outstanding requests immediately with the captured stderr attached.
 * Without that, a broken fixture surfaces as an opaque two-minute request
 * timeout, which is a poor failure mode for a required CI gate.
 */
class AcpStdioClient {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #notifications = new Set<string>();
	readonly #notificationFrames: RpcFrame[] = [];
	/** Every session this client opened, so teardown can close broker-owned hosts it created. */
	readonly #opened = new Set<string>();
	readonly #stderrDone: Promise<void>;
	#stderr = "";
	#nextId = 0;
	#terminalError: Error | undefined;
	#terminated = false;

	constructor(cwd: string, command: readonly string[] = ["bun", FIXTURE_AGENT]) {
		this.#child = Bun.spawn([...command], {
			cwd: REPO_ROOT,
			env: fixtureEnvironment(cwd),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#stderrDone = this.#readStderr();
		void this.#readFrames();
		void this.#watchExit();
	}

	get notifications(): string[] {
		return [...this.#notifications].sort();
	}

	get notificationFrames(): readonly RpcFrame[] {
		return this.#notificationFrames;
	}

	async waitForNotification(method: string, timeoutMs: number = FIXTURE_READY_TIMEOUT_MS): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!this.#notifications.has(method) && Date.now() < deadline) {
			if (this.#terminalError) throw this.#terminalError;
			await Bun.sleep(25);
		}
		if (!this.#notifications.has(method))
			throw this.#describe(`ACP fixture did not emit ${method} within ${timeoutMs}ms`);
	}

	/** Records a session so `dispose` can reap it; ids already closed may be re-recorded harmlessly. */
	track(sessionId: string): void {
		this.#opened.add(sessionId);
	}

	#describe(summary: string): Error {
		const tail = this.#stderr.trim();
		return new Error(tail.length > 0 ? `${summary}\n--- fixture stderr ---\n${tail}` : summary);
	}

	/** First terminal cause wins; later ones are consequences of it. */
	async #terminate(summary: string): Promise<void> {
		if (this.#terminated) return;
		this.#terminated = true;
		// Nothing is waiting on a diagnostic during ordinary disposal, so do not
		// stall teardown for a drain no one will read.
		if (this.#pending.size > 0) await Promise.race([this.#stderrDone, Bun.sleep(STDERR_DRAIN_MS)]);
		const error = this.#describe(summary);
		this.#terminalError = error;
		for (const request of this.#pending.values()) request.reject(error);
		this.#pending.clear();
	}

	/** Never rejects: it is awaited as a drain barrier, and a broken stderr must not mask the real cause. */
	async #readStderr(): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of this.#child.stderr) {
				this.#stderr = (this.#stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_LIMIT);
			}
		} catch (cause) {
			this.#stderr = `${this.#stderr}\n<stderr capture failed: ${cause instanceof Error ? cause.message : String(cause)}>`;
		}
	}

	async #watchExit(): Promise<void> {
		const code = await this.#child.exited;
		await this.#terminate(`ACP fixture exited with code ${code} before the request settled`);
	}

	async #readFrames(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of this.#child.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (!line) continue;
					this.#dispatch(line);
				}
			}
			await this.#terminate("ACP fixture closed stdout before the request settled");
		} catch (cause) {
			await this.#terminate(`ACP framing failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	#dispatch(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`unparseable frame: ${line.slice(0, 200)}`);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error(`ACP frame is not an object: ${line.slice(0, 200)}`);
		const frame = parsed as RpcFrame;
		if (frame.jsonrpc !== "2.0") throw new Error(`ACP frame has invalid jsonrpc version: ${line.slice(0, 200)}`);
		if (typeof frame.id === "number") {
			if (!Number.isSafeInteger(frame.id)) throw new Error(`ACP response has invalid id: ${line.slice(0, 200)}`);
			const request = this.#pending.get(frame.id);
			if (!request) throw new Error(`ACP response id ${frame.id} has no pending request`);
			if (typeof frame.method === "string")
				throw new Error(`ACP response for ${request.method} must not include method: ${line.slice(0, 200)}`);
			const hasResult = Object.hasOwn(frame, "result");
			const hasError = Object.hasOwn(frame, "error");
			if (hasResult === hasError)
				throw new Error(`ACP response for ${request.method} must contain exactly one of result or error: ${line.slice(0, 200)}`);
			if (hasError && (frame.error === null || typeof frame.error !== "object" || typeof frame.error.code !== "number" || typeof frame.error.message !== "string"))
				throw new Error(`ACP response for ${request.method} has invalid error: ${line.slice(0, 200)}`);
			this.#pending.delete(frame.id);
			request.resolve(frame);
			return;
		}
		if (typeof frame.method !== "string") throw new Error(`ACP notification has no method: ${line.slice(0, 200)}`);
		if (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))
			throw new Error(`ACP notification must not contain result or error: ${line.slice(0, 200)}`);
		this.#notifications.add(frame.method);
		this.#notificationFrames.push(frame);
	}

	/** Resolves the RPC result, or throws with the peer's error attached. */
	async call(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (this.#terminalError) throw this.#terminalError;

		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
		this.#pending.set(id, { method, resolve, reject });
		try {
			this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			await this.#child.stdin.flush();
		} catch (cause) {
			// The request never reached the peer, so nothing will ever settle it. Drop it
			// and observe its promise before rethrowing, or it becomes an exit-race
			// unhandled rejection.
			this.#pending.delete(id);
			promise.catch(() => undefined);
			reject(new Error(`ACP request could not be sent: ${method}`));
			throw cause;
		}

		const timeout = Bun.sleep(timeoutMs).then<RpcFrame>(() => {
			this.#pending.delete(id);
			throw this.#describe(`ACP request timed out after ${timeoutMs}ms: ${method}`);
		});
		const frame = await Promise.race([promise, timeout]);
		if (frame.error) throw new AcpPeerRejection(method, frame.error);
		return frame.result;
	}

	/**
	 * Killing the ACP client does not close broker-owned session hosts: the broker
	 * spawns one `sdk session-host-internal` per session and outlives this process.
	 * Anything still open must be closed explicitly or every run leaks a host, which
	 * accumulates permanently on a long-lived CI runner. Broker close is the owner
	 * cleanup protocol and must succeed before the fixture can be terminated.
	 */
	async dispose(): Promise<void> {
		await Promise.all([...this.#opened].map(sessionId => this.call("session/close", { sessionId }, DISPOSE_REQUEST_TIMEOUT_MS)));

		let exited = false;
		const exit = this.#child.exited.then(() => {
			exited = true;
		});
		this.#child.kill("SIGTERM");
		await Promise.race([exit, Bun.sleep(DISPOSE_EXIT_GRACE_MS)]);
		if (!exited) {
			this.#child.kill("SIGKILL");
			await exit;
		}
	}
}

function asObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Expected a JSON object, received ${JSON.stringify(value)}`);
	return value as Record<string, unknown>;
}

function sessionIdOf(value: unknown): string {
	const id = asObject(value).sessionId;
	if (typeof id !== "string" || id.length === 0)
		throw new Error(`Expected a sessionId, received ${JSON.stringify(id)}`);
	return id;
}

function rowsOf(value: unknown): SessionRow[] {
	const sessions = asObject(value).sessions;
	return Array.isArray(sessions) ? (sessions as SessionRow[]) : [];
}

/** Everything the lifecycle sequence observed, captured once and asserted per criterion. */
interface LifecycleObservations {
	sessionCapabilities: SessionCapabilities;
	scratchCwd: string;
	createdSessionId: string;
	otherCwd: string;
	otherSessionId: string;
	listedRows: SessionRow[];
	otherCwdRows: SessionRow[];
	resumeResult: Record<string, unknown>;
	forkedSessionId: string;
	forkResult: Record<string, unknown>;
	forkPreservedSourceState: boolean;
	deleteForked: Record<string, unknown>;
	rowsAfterDelete: SessionRow[];
	closeCreated: Record<string, unknown>;
	closeCreatedAgain: Record<string, unknown>;
	promptAfterCloseRejected: boolean;
	resumeAfterClose: Record<string, unknown>;
	closeAfterResume: Record<string, unknown>;
	notifications: string[];
}

let observed: LifecycleObservations;
const scratchDirs: string[] = [];

async function makeScratch(): Promise<string> {
	// The ACP client enforces the session cwd root against the RESOLVED path, and
	// on macOS `mktemp -d` hands back /tmp/... which resolves to /private/tmp/...,
	// so an unresolved path fails client-authority checks.
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-lifecycle-")));
	scratchDirs.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(scratchDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

beforeAll(async () => {
	const scratchCwd = await makeScratch();
	// A second workspace exists solely so the cwd filter has something to exclude:
	// with one session in the index, an implementation ignoring `cwd` entirely would
	// still satisfy a contains-check.
	const otherCwd = await makeScratch();
	const client = new AcpStdioClient(scratchCwd);

	try {
		const init = (await client.call("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
		})) as InitializeResult;

		const created = await client.call("session/new", { cwd: scratchCwd, mcpServers: [] });
		const createdSessionId = sessionIdOf(created);
		client.track(createdSessionId);

		const other = await client.call("session/new", { cwd: otherCwd, mcpServers: [] });
		const otherSessionId = sessionIdOf(other);
		client.track(otherSessionId);

		const listedRows = rowsOf(await client.call("session/list", { cwd: scratchCwd }));
		const otherCwdRows = rowsOf(await client.call("session/list", { cwd: otherCwd }));

		const resumeResult = asObject(
			await client.call("session/resume", { sessionId: createdSessionId, cwd: scratchCwd }),
		);

		await client.call("session/prompt", {
			sessionId: createdSessionId,
			prompt: [{ type: "text", text: "echo lifecycle-fork-source-state" }],
		});
		const forkResult = asObject(await client.call("session/fork", { sessionId: createdSessionId, cwd: scratchCwd }));
		const forkedSessionId = sessionIdOf(forkResult);
		client.track(forkedSessionId);
		await client.call("session/prompt", {
			sessionId: forkedSessionId,
			prompt: [{ type: "text", text: "fork transcript probe" }],
		});
		const forkPreservedSourceState = client.notificationFrames.some(frame =>
			JSON.stringify(frame.params).includes("fork-state-preserved"),
		);

		const deleteForked = asObject(await client.call("session/delete", { sessionId: forkedSessionId }));
		// Re-list so delete is proven by its external postcondition rather than only
		// by the shape of its own response.
		const rowsAfterDelete = rowsOf(await client.call("session/list", { cwd: scratchCwd }));

		const closeCreated = asObject(await client.call("session/close", { sessionId: createdSessionId }));
		const closeCreatedAgain = asObject(await client.call("session/close", { sessionId: createdSessionId }));

		// `session/list` still returns a closed session, so it cannot witness the close.
		// Losing prompt eligibility can. Only a peer-level JSON-RPC rejection counts:
		// a timeout or transport failure is rethrown rather than miscounted as proof,
		// because a recoverable timeout leaves the client usable and would otherwise let
		// this gate pass without close having done anything. The code and message are
		// never inspected, so the disputed unknown-session error shape stays unpinned.
		let promptAfterCloseRejected = false;
		try {
			await client.call("session/prompt", {
				sessionId: createdSessionId,
				prompt: [{ type: "text", text: "post-close liveness probe" }],
			});
		} catch (cause) {
			if (!(cause instanceof AcpPeerRejection)) throw cause;
			promptAfterCloseRejected = true;
		}

		// The real reattachment path: this session is now detached, so resume has to go
		// back through the broker rather than hand back an already-attached handle.
		const resumeAfterClose = asObject(
			await client.call("session/resume", { sessionId: createdSessionId, cwd: scratchCwd }),
		);
		const closeAfterResume = asObject(await client.call("session/close", { sessionId: createdSessionId }));

		observed = {
			sessionCapabilities: init.agentCapabilities?.sessionCapabilities ?? {},
			scratchCwd,
			createdSessionId,
			otherCwd,
			otherSessionId,
			listedRows,
			otherCwdRows,
			resumeResult,
			forkedSessionId,
			forkResult,
			forkPreservedSourceState,
			deleteForked,
			rowsAfterDelete,
			closeCreated,
			closeCreatedAgain,
			promptAfterCloseRejected,
			resumeAfterClose,
			closeAfterResume,
			notifications: client.notifications,
		};
	} finally {
		await client.dispose();
	}
});

test("initialize advertises every session lifecycle capability", () => {
	expect(observed.sessionCapabilities).toEqual(
		expect.objectContaining({ list: expect.anything(), fork: expect.anything(), resume: expect.anything(), close: expect.anything(), delete: expect.anything() }),
	);
});

test("session/new returns a distinct session id per workspace", () => {
	expect(observed.createdSessionId).toMatch(/\S/);
	expect(observed.otherSessionId).toMatch(/\S/);
	expect(observed.otherSessionId).not.toBe(observed.createdSessionId);
});

test("session/list filtered by cwd returns the created session with its identifying fields", () => {
	const row = observed.listedRows.find(candidate => candidate.sessionId === observed.createdSessionId);
	expect(row).toBeDefined();
	expect(row?.cwd).toBe(observed.scratchCwd);
	expect(typeof row?.title).toBe("string");
	expect(typeof row?.updatedAt).toBe("string");
});

test("session/list discriminates on cwd instead of returning every session", () => {
	// Each listing must exclude the other workspace's session; a `cwd` parameter that
	// is accepted and then ignored fails here but would pass a contains-only check.
	expect(observed.listedRows.map(row => row.sessionId)).not.toContain(observed.otherSessionId);
	expect(observed.otherCwdRows.map(row => row.sessionId)).toContain(observed.otherSessionId);
	expect(observed.otherCwdRows.map(row => row.sessionId)).not.toContain(observed.createdSessionId);
});

test("session/resume returns live session state", () => {
	expect(observed.resumeResult).toHaveProperty("configOptions");
	expect(observed.resumeResult).toHaveProperty("modes");
});

test("session/close costs the session its prompt eligibility", () => {
	expect(observed.promptAfterCloseRejected).toBe(true);
});

test("session/resume reattaches a session that was closed", () => {
	expect(observed.resumeAfterClose).toHaveProperty("configOptions");
	expect(observed.resumeAfterClose).toHaveProperty("modes");
	expect(observed.closeAfterResume).toEqual({});
});

test("session/fork mints a session id distinct from its source", () => {
	expect(observed.forkedSessionId).toMatch(/\S/);
	expect(observed.forkedSessionId).not.toBe(observed.createdSessionId);
	expect(observed.forkResult).toHaveProperty("modes");
	expect(observed.forkPreservedSourceState).toBe(true);
});

test("session/delete removes the forked session from the listing", () => {
	expect(observed.deleteForked).toEqual({});
	const remaining = observed.rowsAfterDelete.map(row => row.sessionId);
	expect(remaining).not.toContain(observed.forkedSessionId);
	expect(remaining).toContain(observed.createdSessionId);
});

test("session/close closes the created session", () => {
	expect(observed.closeCreated).toEqual({});
});

test("session/close is idempotent when repeated on the same session", () => {
	expect(observed.closeCreatedAgain).toEqual({});
});

test("the lifecycle sequence streams session updates", () => {
	expect(observed.notifications).toContain("session/update");
});

test("request timeout teardown force-kills a fixture that ignores termination", async () => {
	const cwd = await makeScratch();
	const fixture = path.join(cwd, "hung-acp-fixture.ts");
	await Bun.write(
		fixture,
		[
			'process.on("SIGTERM", () => undefined);',
			'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/ready" }) + "\\n");',
			"await new Promise<void>(() => undefined);",
		].join("\n"),
	);
	const client = new AcpStdioClient(cwd, ["bun", fixture]);
	let disposed = false;

	try {
		await client.waitForNotification("fixture/ready");
		expect(client.notifications).toContain("fixture/ready");
		await expect(client.call("initialize", {}, 50)).rejects.toThrow("ACP request timed out after 50ms");

		const disposeStarted = performance.now();
		await client.dispose();
		disposed = true;
		const disposeElapsed = performance.now() - disposeStarted;
		expect(disposeElapsed).toBeGreaterThanOrEqual(DISPOSE_EXIT_GRACE_MS - 100);
		expect(disposeElapsed).toBeLessThan(DISPOSE_EXIT_GRACE_MS + 2_000);
	} finally {
		if (!disposed) await client.dispose();
	}
});

test("malformed JSON-RPC responses cannot settle lifecycle requests", async () => {
	const cwd = await makeScratch();
	const fixture = path.join(cwd, "malformed-acp-fixture.ts");
	await Bun.write(
		fixture,
		[
			"for await (const _ of process.stdin) {",
			'  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: true }) + "\\n");',
			"  break;",
			"}",
		].join("\n"),
	);
	const client = new AcpStdioClient(cwd, ["bun", fixture]);
	try {
		await expect(client.call("initialize", {})).rejects.toThrow("ACP response for initialize has invalid error");
	} finally {
		await client.dispose();
	}
});

test("fixture child environment excludes ambient credentials", async () => {
	const cwd = await makeScratch();
	const child = Bun.spawn(["bun", "-e", "process.stdout.write(JSON.stringify(process.env))"], {
		cwd: REPO_ROOT,
		env: fixtureEnvironment(cwd, {
			PATH: process.env.PATH,
			GITHUB_TOKEN: "must-not-reach-fixture",
			OPENAI_API_KEY: "must-not-reach-fixture",
			ANTHROPIC_API_KEY: "must-not-reach-fixture",
		}),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await child.exited).toBe(0);
	const environment = JSON.parse(await new Response(child.stdout).text()) as Record<string, string>;
	for (const variable of ["GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
		expect(environment).not.toHaveProperty(variable);
	}
	expect(environment.HOME).toBe(path.join(cwd, ".acp-fixture-home"));
	expect(environment.XDG_CONFIG_HOME).toBe(path.join(cwd, ".acp-fixture-home", "config"));
	expect(environment.TMPDIR).toBe(cwd);
});
