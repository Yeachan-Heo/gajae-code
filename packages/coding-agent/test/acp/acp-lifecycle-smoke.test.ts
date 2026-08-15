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
	id?: number;
	method?: string;
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
	resolve(frame: RpcFrame): void;
	reject(error: Error): void;
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
	/** Every session this client opened, so teardown can close broker-owned hosts it created. */
	readonly #opened = new Set<string>();
	readonly #stderrDone: Promise<void>;
	#stderr = "";
	#nextId = 0;
	#terminalError: Error | undefined;
	#terminated = false;

	constructor(cwd: string) {
		this.#child = Bun.spawn(["bun", FIXTURE_AGENT], {
			cwd: REPO_ROOT,
			env: { ...process.env, GJC_ACP_CONFORMANCE_CWD: cwd },
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
		let frame: RpcFrame;
		try {
			frame = JSON.parse(line) as RpcFrame;
		} catch {
			throw new Error(`unparseable frame: ${line.slice(0, 200)}`);
		}
		const request = typeof frame.id === "number" ? this.#pending.get(frame.id) : undefined;
		if (request) {
			this.#pending.delete(frame.id as number);
			request.resolve(frame);
		} else if (frame.method) this.#notifications.add(frame.method);
	}

	/** Resolves the RPC result, or throws with the peer's error attached. */
	async call(method: string, params: unknown): Promise<unknown> {
		if (this.#terminalError) throw this.#terminalError;

		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
		this.#pending.set(id, { resolve, reject });
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

		const timeout = Bun.sleep(REQUEST_TIMEOUT_MS).then<RpcFrame>(() => {
			throw this.#describe(`ACP request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`);
		});
		const frame = await Promise.race([promise, timeout]);
		if (frame.error) throw new AcpPeerRejection(method, frame.error);
		return frame.result;
	}

	/**
	 * Killing the ACP client does not close broker-owned session hosts: the broker
	 * spawns one `sdk session-host-internal` per session and outlives this process.
	 * Anything still open must be closed explicitly or every run leaks a host, which
	 * accumulates permanently on a long-lived CI runner. Best-effort by design --
	 * teardown must not convert a reaping failure into a test failure that hides the
	 * real one.
	 */
	async dispose(): Promise<void> {
		for (const sessionId of this.#opened) {
			try {
				await this.call("session/close", { sessionId });
			} catch {
				// Already closed, already gone, or the transport is down; the kill below covers it.
			}
		}
		this.#child.kill("SIGTERM");
		await this.#child.exited;
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

		const forkResult = asObject(await client.call("session/fork", { sessionId: createdSessionId, cwd: scratchCwd }));
		const forkedSessionId = sessionIdOf(forkResult);
		client.track(forkedSessionId);

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
	expect(Object.keys(observed.sessionCapabilities).sort()).toEqual(["close", "delete", "fork", "list", "resume"]);
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
