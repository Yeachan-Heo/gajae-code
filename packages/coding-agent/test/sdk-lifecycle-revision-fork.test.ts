import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@gajae-code/utils";
import { openLifecycleSessionManager } from "../src/commands/sdk";
import {
	Broker,
	lifecycleTargetForTest,
	normalizeBrokerInput,
	setPublicationObservationForTest,
} from "../src/sdk/broker/broker";
import {
	deriveLifecycleDeadlines,
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
} from "../src/sdk/broker/lifecycle";
import { BROKER_RUNTIME_REVISE_CAPABILITY_FIELD } from "../src/sdk/host/control/runtime-gate";
import {
	type SessionLifecycleClient,
	type SessionLifecycleClientRequestOptions,
	type SessionLifecycleOperation,
	SessionLifecycleService,
	validateSessionLifecycleMutationRequest,
} from "../src/sdk/lifecycle/service";
import {
	type CapturedSessionTranscriptSnapshot,
	type SessionEntry,
	SessionManager,
	SessionManagerTestHooks,
} from "../src/session/session-manager";

type ForkFixture = {
	cwd: string;
	agentDir: string;
	file: string;
	bytes: Uint8Array<ArrayBuffer>;
	rootId: string;
	selectedId: string;
	currentId: string;
	snapshot: CapturedSessionTranscriptSnapshot;
};

async function forkFixture(cwd: string): Promise<ForkFixture> {
	const agentDir = path.join(cwd, "agent");
	const source = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	let rootId: string;
	let selectedId: string;
	let currentId: string;
	let file: string;
	try {
		rootId = source.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
		selectedId = source.appendMessage({ role: "user", content: "older revision", timestamp: 2 });
		source.branch(rootId);
		currentId = source.appendMessage({ role: "user", content: "current revision", timestamp: 3 });
		await source.ensureOnDisk();
		await source.flush();
		file = source.getSessionFile()!;
		expect(source.getLeafId()).toBe(currentId);
	} finally {
		await source.close();
	}
	const capture = SessionManager.captureTranscriptStrict(file);
	if (capture.kind !== "captured") throw new Error(`Capture failed: ${capture.reason}`);
	return {
		cwd,
		agentDir,
		file,
		rootId,
		selectedId,
		currentId,
		bytes: new Uint8Array(await Bun.file(file).bytes()),
		snapshot: capture.snapshot,
	};
}

async function exists(file: string): Promise<boolean> {
	return fs.access(file).then(
		() => true,
		() => false,
	);
}

function launchRequest(fixture: ForkFixture, sourceEntryId?: string | null): SessionLifecycleLaunchRequest {
	const identity = fixture.snapshot.identity;
	return {
		operation: "session.fork",
		sessionId: "fork-destination",
		cwd: fixture.cwd,
		stateRoot: path.join(fixture.cwd, ".gjc", "state"),
		...deriveLifecycleDeadlines(Date.now(), 4_000),
		sourceSessionId: identity.sessionId,
		sourceSessionPath: fixture.file,
		sourceSessionIdentity: {
			dev: identity.dev.toString(),
			ino: identity.ino.toString(),
			size: identity.size,
			mtimeMs: identity.mtimeMs,
			mtimeNs: identity.mtimeNs.toString(),
			sha256: identity.sha256,
		},
		...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
	};
}

const actor = { id: "external-client", namespace: "sdk-test" };

class RecordingLifecycleClient implements SessionLifecycleClient {
	readonly calls: Array<{ operation: SessionLifecycleOperation; input: Record<string, unknown> }> = [];

	async global(
		operation: SessionLifecycleOperation,
		input: Record<string, unknown>,
		_options: SessionLifecycleClientRequestOptions,
	): Promise<unknown> {
		this.calls.push({ operation, input });
		return { ok: true, result: { sessionId: "fork-destination" } };
	}
}

describe("captured lifecycle entry-scoped forks", () => {
	it("selects a non-current branch leaf without copying the active sibling or mutating the source", async () => {
		using root = TempDir.createSync("gjc-revision-fork-");
		const fixture = await forkFixture(root.path());
		try {
			const result = await SessionManager.forkFromCaptured(
				fixture.snapshot,
				fixture.cwd,
				path.join(root.path(), "fork"),
				"copy-retain",
				"enabled",
				fixture.selectedId,
			);
			expect(result.kind).toBe("forked");
			if (result.kind !== "forked") throw new Error(result.reason);
			try {
				expect(result.manager.getBranch().map(entry => entry.id)).toEqual([fixture.rootId, fixture.selectedId]);
				expect(result.manager.getEntry(fixture.currentId)).toBeUndefined();
				expect(result.manager.getSessionId()).not.toBe(fixture.snapshot.identity.sessionId);
				expect(result.manager.getHeader()?.parentSession).toBe(fixture.snapshot.identity.sessionId);
				expect(result.manager.getSessionFile()).not.toBe(fixture.file);
				await result.manager.flush();
				const reopened = await SessionManager.open(
					result.manager.getSessionFile()!,
					path.join(root.path(), "fork"),
				);
				try {
					expect(reopened.getBranch().map(entry => entry.id)).toEqual([fixture.rootId, fixture.selectedId]);
					expect(reopened.getEntry(fixture.currentId)).toBeUndefined();
				} finally {
					await reopened.close();
				}
			} finally {
				await result.manager.close();
			}
			expect(await Bun.file(fixture.file).bytes()).toEqual(fixture.bytes);
			expect(fixture.snapshot.revalidate()).toEqual({ kind: "valid" });
		} finally {
			fixture.snapshot.close();
		}
	});

	it("forks an empty root, and retains all branches when selection is omitted", async () => {
		using root = TempDir.createSync("gjc-root-edit-fork-");
		const fixture = await forkFixture(root.path());
		try {
			for (const selection of [null, undefined]) {
				const destination = path.join(root.path(), selection === null ? "root-fork" : "full-fork");
				const result = await SessionManager.forkFromCaptured(
					fixture.snapshot,
					fixture.cwd,
					destination,
					"copy-retain",
					"shadow",
					selection,
				);
				if (result.kind !== "forked") throw new Error(result.reason);
				try {
					if (selection === null) {
						expect(result.manager.getBranch()).toEqual([]);
						expect(result.manager.getLeafId()).toBeNull();
						await result.manager.flush();
						const reopened = await SessionManager.open(result.manager.getSessionFile()!, destination);
						try {
							expect(reopened.getBranch()).toEqual([]);
						} finally {
							await reopened.close();
						}
					} else {
						expect(result.manager.getBranch().map(entry => entry.id)).toEqual([
							fixture.rootId,
							fixture.currentId,
						]);
						expect(result.manager.getEntry(fixture.selectedId)?.parentId).toBe(fixture.rootId);
					}
				} finally {
					await result.manager.close();
				}
			}
			expect(await Bun.file(fixture.file).bytes()).toEqual(fixture.bytes);
		} finally {
			fixture.snapshot.close();
		}
	});

	it("rejects invalid IDs, missing targets, cyclic or broken ancestry, and duplicate entry identity before publication", async () => {
		using root = TempDir.createSync("gjc-invalid-revision-fork-");
		for (const scenario of ["invalid", "missing", "cycle", "broken", "duplicate"] as const) {
			const file = path.join(root.path(), `${scenario}.jsonl`);
			const entry = (id: string, parentId: string | null): SessionEntry => ({
				type: "message",
				id,
				parentId,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: id, timestamp: 1 },
			});
			const entries =
				scenario === "cycle"
					? [entry("a", "b"), entry("b", "a")]
					: scenario === "broken"
						? [entry("a", "absent-parent")]
						: scenario === "duplicate"
							? [entry("a", null), entry("a", null)]
							: [entry("a", null)];
			await Bun.write(
				file,
				`${[
					{ type: "session", version: 5, id: "source", cwd: root.path(), timestamp: new Date(0).toISOString() },
					...entries,
				]
					.map(value => JSON.stringify(value))
					.join("\n")}\n`,
			);
			const bytes = await Bun.file(file).bytes();
			const captured = SessionManager.captureTranscriptStrict(file);
			if (captured.kind !== "captured") throw new Error(captured.reason);
			try {
				const result = await SessionManager.forkFromCaptured(
					captured.snapshot,
					root.path(),
					path.join(root.path(), `fork-${scenario}`),
					"copy-retain",
					"shadow",
					scenario === "invalid" ? "" : scenario === "missing" ? "missing" : "a",
				);
				expect(result).toMatchObject({ kind: "error", reason: "malformed" });
				expect(await exists(path.join(root.path(), `fork-${scenario}`))).toBe(false);
				expect(await Bun.file(file).bytes()).toEqual(bytes);
			} finally {
				captured.snapshot.close();
			}
		}
	});

	it("rejects source identity replacement even when the selected path is unchanged", async () => {
		using root = TempDir.createSync("gjc-revision-source-race-");
		const fixture = await forkFixture(root.path());
		try {
			const replacement = `${fixture.file}.replacement`;
			await Bun.write(replacement, fixture.bytes);
			await fs.rename(replacement, fixture.file);
			const result = await SessionManager.forkFromCaptured(
				fixture.snapshot,
				fixture.cwd,
				path.join(root.path(), "fork"),
				"copy-retain",
				"shadow",
				fixture.selectedId,
			);
			expect(result).toMatchObject({ kind: "error", reason: "identity-mismatch" });
			expect(await exists(path.join(root.path(), "fork"))).toBe(false);
			expect(await Bun.file(fixture.file).bytes()).toEqual(fixture.bytes);
		} finally {
			fixture.snapshot.close();
		}
	});

	it("never falls back to a full bounded fork for oversized branch or root selection", async () => {
		using root = TempDir.createSync("gjc-oversized-revision-fork-");
		const fixture = await forkFixture(root.path());
		try {
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
			for (const mode of ["enabled", "auto", "shadow"] as const) {
				for (const sourceEntryId of [fixture.selectedId, null]) {
					const result = await SessionManager.forkFromCaptured(
						fixture.snapshot,
						fixture.cwd,
						path.join(root.path(), "fork"),
						"copy-retain",
						mode,
						sourceEntryId,
					);
					expect(result).toEqual({ kind: "error", reason: "oversized", size: fixture.snapshot.identity.size });
				}
			}
			expect(await exists(path.join(root.path(), "fork"))).toBe(false);
			expect(await Bun.file(fixture.file).bytes()).toEqual(fixture.bytes);
		} finally {
			SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
			fixture.snapshot.close();
		}
	});
});

describe("Broker-owned prompt revision routing", () => {
	it("validates exact bounded revision input without changing user text", () => {
		for (const body of [" edited prompt\n", "x".repeat(65_536), String.fromCodePoint(0x10000).repeat(32_768)]) {
			const input = { sessionId: "revision-session", entryId: "prompt-entry", body };
			expect(normalizeBrokerInput("session.revise", input)).toEqual({ input });
		}
		for (const body of [undefined, null, 1, {}, [], "", " \n\t", "x".repeat(65_537), "\ud800", "\udc00"]) {
			expect(
				normalizeBrokerInput("session.revise", { sessionId: "revision-session", entryId: "prompt", body }),
			).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		}
		for (const entryId of [undefined, null, "", "x".repeat(129), "a\nb", "\ud800"]) {
			expect(
				normalizeBrokerInput("session.revise", { sessionId: "revision-session", entryId, body: "edit" }),
			).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		}
		for (const extra of [
			{ sourceEntryId: null },
			{ rawManager: {} },
			{ [BROKER_RUNTIME_REVISE_CAPABILITY_FIELD]: "forged" },
		]) {
			expect(
				normalizeBrokerInput("session.revise", {
					sessionId: "revision-session",
					entryId: "prompt",
					body: "edit",
					...extra,
				}),
			).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		}
	});

	it("forwards the exact edit to its pinned lifecycle host and fences direct hosts, rotation, and lost publication", async () => {
		using root = TempDir.createSync("gjc-broker-revision-");
		const cwd = await fs.realpath(root.path());
		const agentDir = path.join(cwd, "agent");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "revision-session";
		const lifecycleRequestId = "private-revision-authority";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir });
		const requests: Record<string, unknown>[] = [];
		let fenceOnNextOpen = false;
		let rotateOnNextOpen = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				async open(ws) {
					if (rotateOnNextOpen) {
						rotateOnNextOpen = false;
						await Bun.write(
							endpointPath,
							JSON.stringify({
								sessionId,
								pid: process.pid,
								url: `ws://127.0.0.1:${server.port}`,
								token: "rotated-token",
							}),
						);
					}
					if (fenceOnNextOpen) {
						fenceOnNextOpen = false;
						setPublicationObservationForTest(broker, "absent");
					}
					ws.send(JSON.stringify({ type: "hello" }));
				},
				message(ws, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					requests.push(frame);
					ws.send(
						JSON.stringify({
							id: frame.id,
							ok: true,
							result: {
								accepted: true,
								token: "endpoint-token",
								[BROKER_RUNTIME_REVISE_CAPABILITY_FIELD]: lifecycleRequestId,
							},
						}),
					);
				},
			},
		});
		try {
			await broker.start();
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await Bun.write(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "endpoint-token",
				}),
			);
			const register = async (generation: number, owned: boolean): Promise<void> => {
				await broker.index.append({
					type: "host_registered",
					sessionId,
					locator: { cwd, worktreeRoot: null, stateRoot },
					endpointGeneration: generation,
					pid: process.pid,
					endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
					...(owned ? { lifecycleRequestId } : {}),
				});
				await broker.index.append({
					type: "host_heartbeat",
					sessionId,
					locator: { cwd, worktreeRoot: null, stateRoot },
					endpointGeneration: generation,
					pid: process.pid,
				});
			};
			await register(1, true);
			const input = { sessionId, entryId: "selected-prompt", body: " exact edited prompt\n" };
			for (const key of [undefined, "", "x".repeat(129), "bad\nkey"]) {
				expect(await broker.handleRequest("session.revise", input, key)).toMatchObject({
					ok: false,
					error: { code: "invalid_input" },
				});
			}
			for (const operation of [
				"session.create",
				"session.fork",
				"session.resume",
				"session.close",
				"session.delete",
			]) {
				expect(
					await broker.handleRequest(operation, { sessionId, body: "not a lifecycle launch" }, "unsupported-body"),
				).toMatchObject({ ok: false, error: { code: "invalid_input" } });
			}
			expect(requests).toEqual([]);
			expect(await broker.handleRequest("session.revise", input, "edit-key")).toEqual({
				ok: true,
				result: { accepted: true },
			});
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				type: "control_request",
				operation: "session.revise",
				idempotencyKey: "edit-key",
				input: {
					entryId: input.entryId,
					body: input.body,
					[BROKER_RUNTIME_REVISE_CAPABILITY_FIELD]: lifecycleRequestId,
				},
			});
			expect(requests[0]!.input).not.toHaveProperty("sessionId");
			await register(2, false);
			expect(await broker.handleRequest("session.revise", input, "direct-host")).toMatchObject({
				ok: false,
				error: { code: "operation_prohibited" },
			});
			expect(requests).toHaveLength(1);
			await register(3, true);
			rotateOnNextOpen = true;
			expect(await broker.handleRequest("session.revise", input, "rotated-endpoint")).toMatchObject({
				ok: false,
				error: { code: "endpoint_stale" },
			});
			expect(requests).toHaveLength(1);
			await register(4, true);
			fenceOnNextOpen = true;
			expect(await broker.handleRequest("session.revise", input, "lost-publication")).toMatchObject({
				ok: false,
				error: { code: "unavailable" },
			});
			expect(requests).toHaveLength(1);
		} finally {
			setPublicationObservationForTest(broker, undefined);
			await server.stop(true);
			await broker.stop();
		}
	});
});

describe("SDK lifecycle fork selection", () => {
	it("passes exact history selection through the existing session.fork service", async () => {
		const client = new RecordingLifecycleClient();
		const service = new SessionLifecycleService(client);
		for (const sourceEntryId of ["ancestor", null, undefined]) {
			const target = { cwd: "/repo", sourceSessionId: "source", sourceEntryId };
			expect(
				await service.fork({ actor, capability: "session.fork", requestKey: `fork-${sourceEntryId}`, target }),
			).toMatchObject({ ok: true, operation: "session.fork" });
			expect(client.calls.at(-1)).toEqual({ operation: "session.fork", input: target });
		}
		for (const sourceEntryId of ["", 1, {}, [], "a".repeat(129), "a\nb"]) {
			expect(
				validateSessionLifecycleMutationRequest({
					operation: "session.fork",
					actor,
					capability: "session.fork",
					requestKey: "invalid",
					target: { cwd: "/repo", sourceEntryId },
				}),
			).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		}
		expect(
			validateSessionLifecycleMutationRequest({
				operation: "session.resume",
				actor,
				capability: "session.resume",
				requestKey: "wrong-operation",
				target: { sessionId: "source", sourceEntryId: null },
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	});

	it("validates raw broker selection before effects and rejects selection on resume or delete", () => {
		for (const sourceEntryId of [undefined, null, "ancestor"]) {
			const input = { cwd: "/repo", sourceSessionId: "source", sourceEntryId };
			const normalized = normalizeBrokerInput("session.fork", input);
			if (!("input" in normalized)) throw new Error("Expected a valid fork target.");
			expect(normalized.input.sourceEntryId).toBe(sourceEntryId);
		}
		for (const sourceEntryId of ["", 1, false, {}, [], "a".repeat(129), "a\nb"]) {
			expect(normalizeBrokerInput("session.fork", { cwd: "/repo", sourceEntryId })).toMatchObject({
				ok: false,
				error: { code: "invalid_input" },
			});
		}
		for (const operation of ["session.create", "session.resume", "session.close", "session.delete"]) {
			expect(
				normalizeBrokerInput(operation, { cwd: "/repo", sessionId: "source", sourceEntryId: null }),
			).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		}
	});

	it("rejects body on lifecycle history operations rather than silently ignoring an edit", async () => {
		for (const operation of [
			"session.create",
			"session.fork",
			"session.resume",
			"session.close",
			"session.delete",
			"session.reconcile_uncertain",
		]) {
			expect(normalizeBrokerInput(operation, { cwd: "/repo", sessionId: "source", body: "edit" })).toMatchObject({
				ok: false,
				error: { code: "invalid_input" },
			});
		}
		using root = TempDir.createSync("gjc-rejected-fork-body-");
		const fixture = await forkFixture(root.path());
		try {
			const request = { ...launchRequest(fixture, fixture.selectedId), body: "unsupported edit" };
			expect(() => readSessionLifecycleLaunchRequest(JSON.stringify(request))).toThrow(
				"Lifecycle launch body is unsupported",
			);
			await expect(openLifecycleSessionManager(request, fixture.cwd, fixture.agentDir)).rejects.toThrow(
				"Lifecycle launch body is unsupported",
			);
			expect((await fs.readdir(path.dirname(fixture.file))).filter(name => name.endsWith(".jsonl"))).toEqual([
				path.basename(fixture.file),
			]);
			expect(await Bun.file(fixture.file).bytes()).toEqual(fixture.bytes);
		} finally {
			fixture.snapshot.close();
		}
	});

	it("distinguishes full, root, and different branch targets in broker lifecycle identity", () => {
		const input = { cwd: "/repo", sourceSessionId: "source" };
		const targets = [undefined, null, "branch-a", "branch-b"].map(sourceEntryId =>
			JSON.stringify(lifecycleTargetForTest("session.fork", { ...input, sourceEntryId })),
		);
		expect(new Set(targets).size).toBe(4);
		expect(JSON.parse(targets[1]!)).toHaveProperty("sourceEntryId", null);
		expect(JSON.parse(targets[0]!)).not.toHaveProperty("sourceEntryId");
	});

	it("validates child JSON selection and opens the selected branch or root through the real lifecycle manager", async () => {
		using root = TempDir.createSync("gjc-sdk-revision-fork-");
		const fixture = await forkFixture(root.path());
		try {
			for (const sourceEntryId of [fixture.selectedId, null, undefined]) {
				const request = launchRequest(fixture, sourceEntryId);
				const parsed = readSessionLifecycleLaunchRequest(JSON.stringify(request));
				const opened = await openLifecycleSessionManager(parsed, fixture.cwd, fixture.agentDir);
				const manager = opened.sessionManager;
				if (!manager) throw new Error("Expected persisted lifecycle fork.");
				try {
					expect(manager.getBranch().map(entry => entry.id)).toEqual(
						sourceEntryId === null ? [] : [fixture.rootId, sourceEntryId ?? fixture.currentId],
					);
					if (sourceEntryId === fixture.selectedId) expect(manager.getEntry(fixture.currentId)).toBeUndefined();
					await manager.flush();
					const reopened = await SessionManager.open(
						manager.getSessionFile()!,
						SessionManager.managedDestination(fixture.cwd, fixture.agentDir),
					);
					try {
						expect(reopened.getBranch().map(entry => entry.id)).toEqual(
							sourceEntryId === null ? [] : [fixture.rootId, sourceEntryId ?? fixture.currentId],
						);
					} finally {
						await reopened.close();
					}
				} finally {
					await manager.close();
				}
			}
			const request = launchRequest(fixture, fixture.selectedId);
			for (const sourceEntryId of ["", 1, false, [], {}, "a".repeat(129), "a\nb"]) {
				expect(() => readSessionLifecycleLaunchRequest(JSON.stringify({ ...request, sourceEntryId }))).toThrow(
					"GJC_SDK_LIFECYCLE_REQUEST is invalid.",
				);
			}
			expect(() =>
				readSessionLifecycleLaunchRequest(
					JSON.stringify({ ...request, operation: "session.create", sourceEntryId: null }),
				),
			).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
			expect(() => readSessionLifecycleLaunchRequest("null")).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
			expect(await Bun.file(fixture.file).bytes()).toEqual(fixture.bytes);
		} finally {
			fixture.snapshot.close();
		}
	});

	it("rejects a source replaced after lifecycle capture without publishing a fork", async () => {
		using root = TempDir.createSync("gjc-sdk-revision-race-");
		const fixture = await forkFixture(root.path());
		const originalCapture = SessionManager.captureTranscriptStrict;
		const replacement = `${fixture.file}.replacement`;
		await Bun.write(replacement, fixture.bytes);
		let capturedSnapshot: CapturedSessionTranscriptSnapshot | undefined;
		const capture = spyOn(SessionManager, "captureTranscriptStrict").mockImplementation((file, storage) => {
			const result = originalCapture(file, storage);
			if (result.kind === "captured") capturedSnapshot = result.snapshot;
			return result;
		});
		const forkImplementation = SessionManager.forkFromCaptured;
		const replaceBeforeFork = spyOn(SessionManager, "forkFromCaptured").mockImplementation(async (...args) => {
			await fs.rename(replacement, fixture.file);
			return forkImplementation(...args);
		});
		try {
			await expect(
				openLifecycleSessionManager(launchRequest(fixture, fixture.selectedId), fixture.cwd, fixture.agentDir),
			).rejects.toThrow("Lifecycle saved session authority changed while the session host forked it.");
			expect(replaceBeforeFork).toHaveBeenCalledTimes(1);
			const saved = await fs.readdir(path.dirname(fixture.file));
			expect(saved.filter(name => name.endsWith(".jsonl"))).toEqual([path.basename(fixture.file)]);
			expect(await Bun.file(fixture.file).bytes()).toEqual(fixture.bytes);
		} finally {
			replaceBeforeFork.mockRestore();
			capture.mockRestore();
			capturedSnapshot?.close();
			fixture.snapshot.close();
		}
	});
});
