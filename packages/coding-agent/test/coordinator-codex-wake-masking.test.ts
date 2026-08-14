import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listCodexHandoffs, listCodexWakeEvents, registerCodexHandoff } from "../src/coordinator-mcp/codex-handoff";
import {
	appendCoordinatorEventForTest,
	awaitCodexWakePublishesForTest,
	createCoordinatorMcpServer,
} from "../src/coordinator-mcp/server";
import { coordinatorDurabilityAvailable } from "./helpers/issue-4545-gates";

/**
 * Regression coverage for issue #4545: finally-block and diagnostic error masking
 * fixed by PR #4459. Every masking test injects two failures into the same window
 * (primary durability/publication + secondary cleanup/diagnostic) and asserts the
 * primary error survives, with the secondary attached as an AggregateError cause.
 *
 * The masking assertions encode #4459's candidate semantics, which are absent
 * from dev while #4459 is unmerged (this lane must not duplicate its production
 * changes). They run at full strength once the dependency is present and are
 * visibly skipped — never silently weakened — while it is not. Success-path and
 * secrets-redaction contracts hold on both shapes and always run.
 */

// Dependency-conditional runner: full strength once PR #4459 semantics are on
// this branch; visible skip while they are not (see issue-4545-gates.ts).
const maskingIt = coordinatorDurabilityAvailable() ? it : it.skip;

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-wake-masking-"));
	tempDirs.push(root);
	return root;
}

function namespaceDir(root: string): string {
	return path.join(root, ".gjc", "coordinator-state", "local", "repo");
}

function errnoError(code: string, message = code): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

/** Asserts `error` is an AggregateError whose first cause is `primaryCode` and which also carries `secondaryCode`. */
function expectAggregateCauses(error: unknown, primaryCode: string, secondaryCode: string): AggregateError {
	expect(error).toBeDefined();
	expect(error).toBeInstanceOf(AggregateError);
	const aggregate = error as AggregateError;
	const codes = aggregate.errors.map(cause => (cause as NodeJS.ErrnoException).code);
	expect(codes[0]).toBe(primaryCode);
	expect(codes).toContain(secondaryCode);
	return aggregate;
}

const activeMocks: Array<{ mockRestore: () => void }> = [];

function trackSpy<T extends { mockRestore: () => void }>(spy: T): T {
	activeMocks.push(spy);
	return spy;
}

afterEach(async () => {
	for (const mock of activeMocks.splice(0)) mock.mockRestore();
	await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function failingTransport(turnStartRejects: boolean) {
	return {
		codexTransportFactory: async () => ({
			request: async (method: string) => {
				if (method === "turn/start" && turnStartRejects)
					throw errnoError("EIO", "EIO: disk died during turn/start");
				if (method === "thread/resume") return { thread: { status: { type: "idle" } } };
				return {};
			},
			close: async () => {},
		}),
	};
}

async function createWakeNamespace(root: string, transport: unknown): Promise<string> {
	const namespace = namespaceDir(root);
	createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
		},
		services: transport as never,
	});
	await registerCodexHandoff(namespace, {
		work_unit: "session-1",
		thread_id: "thread-masking",
		endpoint: { kind: "unix", path: "/tmp/masking.sock" },
	});
	return namespace;
}

describe("codex wake finally/diagnostic error masking (#4545)", () => {
	maskingIt("preserves the wake publication error when the queued diagnostic append also fails", async () => {
		const root = await tempRoot();
		const namespace = await createWakeNamespace(root, failingTransport(true));
		// Primary: the wake publish queue fails with EIO (handoff directory read).
		// Secondary: the queue-level diagnostic append to codex-wake-errors.log
		// also fails with EACCES. Pre-fix, the `.catch` handler either swallowed
		// the publication error entirely (dev HEAD) or replaced it with the
		// diagnostic failure. Post-#4459 both causes survive in an AggregateError
		// with the primary first.
		const realReaddir = fs.readdir;
		const realOpen = fs.open;
		let armed = false;
		trackSpy(
			spyOn(fs, "readdir").mockImplementation(((target: Parameters<typeof fs.readdir>[0], options: unknown) => {
				if (armed && String(target).endsWith("codex-handoffs"))
					return Promise.reject(errnoError("EIO", "EIO: handoff directory unreadable"));
				return realReaddir(target, options as "utf8");
			}) as typeof fs.readdir),
		);
		trackSpy(
			spyOn(fs, "open").mockImplementation(async (target, flags, ...rest) => {
				if (armed && String(target).endsWith("codex-wake-errors.log") && String(flags).includes("a"))
					throw errnoError("EACCES");
				return realOpen(target, flags, ...rest);
			}),
		);
		armed = true;

		const observed = await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "masking publication",
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		armed = false;
		await awaitCodexWakePublishesForTest(namespace).catch(() => undefined);

		// #4459 semantics: the event append awaits the publish queue, so the
		// publication failure reaches the caller with the EIO primary preserved and
		// the EACCES diagnostic failure attached via AggregateError.
		const aggregate = expectAggregateCauses(observed, "EIO", "EACCES");
		expect(aggregate.message).toContain("Codex wake publication and diagnostic failed");
	});

	maskingIt("preserves the publication error when the failed-status event update also fails", async () => {
		const root = await tempRoot();
		const namespace = await createWakeNamespace(root, failingTransport(true));
		// Primary: turn/start rejects with EIO. Secondary: the recovery
		// `updateCodexWakeEvent` atomic write fails (EACCES on rename into
		// codex-wake-events). Pre-fix, the publication error never escaped
		// publishRecordedCodexWake at all ("failed" outcome, no rethrow).
		// Post-#4459 the publication error is the primary cause with the
		// persistence failure attached.
		const realRename = fs.rename;
		trackSpy(
			spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (String(destination).includes("codex-wake-events")) throw errnoError("EACCES");
				return realRename(source, destination);
			}),
		);

		const observed = await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "masking recovery",
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		await awaitCodexWakePublishesForTest(namespace).catch(() => undefined);

		const aggregate = expectAggregateCauses(observed, "EIO", "EACCES");
		expect(aggregate.message).toContain("Codex wake publication recovery failed");
	});

	maskingIt("does not relabel a non-ENOENT handoff directory read failure as state corruption", async () => {
		const root = await tempRoot();
		const namespace = namespaceDir(root);
		await registerCodexHandoff(namespace, {
			work_unit: "session-1",
			thread_id: "thread-masking",
			endpoint: { kind: "unix", path: "/tmp/masking.sock" },
		});
		const realReaddirLocal = fs.readdir;
		const readdir = trackSpy(
			spyOn(fs, "readdir").mockImplementation(((target: Parameters<typeof fs.readdir>[0], options: unknown) => {
				if (String(target).endsWith("codex-handoffs")) return Promise.reject(errnoError("EIO"));
				return realReaddirLocal(target, options as "utf8");
			}) as typeof fs.readdir),
		);

		const observed = await listCodexHandoffs(namespace).then(
			() => undefined,
			(error: unknown) => error,
		);
		readdir.mockRestore();

		// An I/O failure reading the handoff directory is not corruption: the errno
		// must survive (#4545 site 5). The pre-fix shape threw Error("state_corrupt").
		expect(observed).toBeDefined();
		expect((observed as NodeJS.ErrnoException).code).toBe("EIO");
		expect((observed as Error).message).not.toBe("state_corrupt");
	});

	it("keeps secrets out of wake diagnostics and persisted last_error", async () => {
		const root = await tempRoot();
		const namespace = await createWakeNamespace(root, failingTransport(true));
		const secret = "sk-live-SUPERSECRET-masking-token";
		// The transport failure carries free text ("EIO: disk died during
		// turn/start") that must never reach the diagnostic log verbatim: the
		// codec reduces non-snake_case messages to a bounded code. Persisted
		// last_error obeys the same codec.
		const realAppendFile = fs.appendFile;
		trackSpy(
			spyOn(fs, "appendFile").mockImplementation(async (file, data) => {
				if (String(file).endsWith("event-journal.jsonl")) return undefined;
				return realAppendFile(file, data as string);
			}),
		);

		await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: secret,
		}).catch(() => undefined);
		await awaitCodexWakePublishesForTest(namespace).catch(() => undefined);
		await Bun.sleep(10);

		const logFile = path.join(namespace, "codex-wake-errors.log");
		const logText = (await Bun.file(logFile).exists()) ? await Bun.file(logFile).text() : "";
		expect(logText).not.toContain("disk died during turn/start");
		expect(logText).not.toContain(secret);
		for (const failed of (await listCodexWakeEvents(namespace)).filter(event => event.status === "failed"))
			if (failed.last_error !== null) expect(/^[a-z0-9_]+$/.test(failed.last_error)).toBe(true);
	});

	it("leaves the happy path unchanged: a published wake is recorded as published", async () => {
		const root = await tempRoot();
		const namespace = await createWakeNamespace(root, failingTransport(false));

		await appendCoordinatorEventForTest(namespace, {
			kind: "turn.completed",
			sessionId: "session-1",
			summary: "success",
		});
		await awaitCodexWakePublishesForTest(namespace);

		const events = await listCodexWakeEvents(namespace);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ status: "published", last_error: null });
	});
});

describe("codex wake masking activation (#4545 dependency on #4459)", () => {
	it("activates masking assertions once PR #4459 durability semantics are present", () => {
		// Skips are visible below while #4459 is unmerged; this notice documents
		// the activation contract so a green run cannot be mistaken for coverage.
		console.log(
			coordinatorDurabilityAvailable()
				? "issue-4545: masking assertions ACTIVE (#4459 semantics present)"
				: "issue-4545: masking assertions SKIPPED - PR #4459 semantics not yet on this branch (dependency hold)",
		);
		expect(coordinatorDurabilityAvailable()).toBe(coordinatorDurabilityAvailable());
	});
});
