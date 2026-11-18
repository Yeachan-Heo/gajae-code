import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import * as sdk from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import { ManagedSession } from "../src/managed-session";
import { HISTORY_LIMIT } from "../src/message-projection";
import { openNativeSession } from "../src/native-session";
import type {
	DesktopFrame,
	DesktopHistory,
	DesktopProject,
	DesktopProjectRefreshResult,
	DesktopRequest,
	DesktopSession,
	DesktopSnapshot,
} from "../src/protocol";

let environment: NodeJS.ProcessEnv;
let previousAgentDir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	environment = { ...process.env };
	previousAgentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	process.env.GJC_NO_TITLE = "1";
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
});
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(previousAgentDir);
	}
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-discovery-refresh-")));
	const cwd = path.join(root, "project");
	const dataDir = path.join(root, "app");
	const agentDir = path.join(dataDir, "agent");
	await fs.mkdir(cwd);
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			tools: { discoveryMode: "off" },
		}),
	);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing fixture model");
	const frames: DesktopFrame[] = [];
	const host = new DesktopHost({
		dataDir,
		emit: frame => frames.push(frame),
		createSession: input =>
			sdk.createAgentSession({
				...input,
				// Provider affinity is deliberately distinct from the transcript identity.
				providerSessionId: crypto.randomUUID(),
				model,
				extensions: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				disableExtensionDiscovery: true,
				enableMcpAutoload: false,
				enableLsp: false,
				skipPythonPreflight: true,
				deferOptionalModelRefresh: true,
				deferMemoryBackendStartup: true,
				toolNames: [],
			}),
	});
	await host.initialize();
	cleanups.push(async () => {
		await host.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const call = async <T = unknown>(method: DesktopRequest["method"], params: Record<string, unknown>): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle({ id, method, params });
		const response = frames.findLast(frame => frame.type === "response" && frame.id === id);
		if (response?.type !== "response") throw new Error("Missing response");
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	const persist = async (text: string) => {
		const id = crypto.randomUUID();
		const file = path.join(SessionManager.managedDestination(cwd, agentDir).directory, `${id}.jsonl`);
		const leaf = "terminal-leaf";
		await Bun.write(
			file,
			`${[
				{ type: "session", version: 5, id, cwd, timestamp: new Date().toISOString() },
				{
					type: "message",
					id: leaf,
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
				},
			]
				.map(row => JSON.stringify(row))
				.join("\n")}\n`,
		);
		const resolved = sdk.resolveEmbeddedResumeCheckpoint(file);
		if (resolved.kind !== "resolved") throw new Error(resolved.reason);
		return { id, file, leaf, checkpoint: resolved.checkpoint };
	};
	return { host, call, persist, frames, cwd, dataDir, agentDir };
}

async function enteredBeforeSettling(entered: Promise<void>, pending: Promise<unknown>) {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Discovery did not start")), 2_000);
	try {
		await Promise.race([
			entered,
			deadline.promise,
			pending.then(() => {
				throw new Error("Discovery settled early");
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test("discovered rows refuse mutations before and after disk selection, then allow the same call after native connect", async () => {
	const h = await fixture();
	const terminal = await h.persist("Terminal history");
	await h.call("project.open", { path: h.cwd });
	const params = { sessionId: terminal.id, title: "Admitted title" };
	const before = await Bun.file(terminal.file).text();
	expect(h.host.snapshot().sessions[0]).toMatchObject({
		readOnly: true,
		readOnlyReason: expect.stringContaining("session.connect"),
	});
	await expect(h.call("session.rename", params)).rejects.toThrow("read-only");
	const resume = vi.spyOn(sdk.lifecycle.AgentDirSessionLifecycleService.prototype, "resume");
	const admission = vi.spyOn(sdk, "createEmbeddedAgentSession");
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.readOnly).toBe(true);
	expect(selected.observation).toMatchObject({
		source: "disk",
		checkpointKind: "tail_unambiguous",
		selectionRequired: false,
	});
	expect(selected.messages.some(message => message.text === "Terminal history")).toBe(true);
	expect(selected.controlGeneration).toBeNull();
	expect(resume).not.toHaveBeenCalled();
	expect(admission).not.toHaveBeenCalled();
	const control = vi.spyOn(ManagedSession.prototype, "control");
	for (const method of [
		"session.rename",
		"model.set",
		"prompt",
		"abort",
		"session.delete",
		"tools.set",
		"command.run",
		"settings.set",
	] as const) {
		await expect(
			h.call(method, {
				sessionId: terminal.id,
				text: "Must not run",
				sessionGeneration: selected.controlGeneration,
			}),
		).rejects.toThrow("read-only");
	}
	expect(control).not.toHaveBeenCalled();
	expect(await Bun.file(terminal.file).text()).toBe(before);
	const connected = await h.call<{ kind: string; session: DesktopSession }>("session.connect", {
		sessionId: terminal.id,
		selection: { snapshotDigest: terminal.checkpoint.snapshotDigest, targetLeafId: terminal.leaf },
		legacyAttestation: { snapshotDigest: terminal.checkpoint.snapshotDigest, acknowledged: true },
	});
	expect(connected).toMatchObject({ kind: "connected" });
	expect(connected.session.readOnly).toBeUndefined();
	expect(
		await h.call("abort", {
			sessionId: terminal.id,
			sessionGeneration: connected.session.controlGeneration,
		}),
	).toBeNull();
	await h.call("session.rename", params);
	expect(h.host.snapshot().sessions[0]?.title).toBe("Admitted title");
	expect(await Bun.file(terminal.file).text()).toContain("Admitted title");
	expect(await h.call<{ kind: string }>("session.disconnect", { sessionId: terminal.id })).toEqual({
		kind: "disconnected",
	});
	expect(h.host.snapshot().sessions[0]?.readOnly).toBe(true);
	await expect(h.call("session.rename", params)).rejects.toThrow("read-only");
	const persisted = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(persisted.observation).toMatchObject({ source: "disk", selectionRequired: false });
	expect(persisted.messages.some(message => message.text === "Terminal history")).toBe(true);
	expect(resume).not.toHaveBeenCalled();
});

test("resident references remain explicit unresolved messages in ordered disk observations without hiding readable neighbors", async () => {
	const h = await fixture();
	const terminal = await h.persist("Readable before");
	const reference = `blob:sha256:${"a".repeat(64)}`;
	await Bun.write(
		terminal.file,
		(await Bun.file(terminal.file).text()) +
			[
				{
					type: "message",
					id: "resident-entry",
					parentId: terminal.leaf,
					timestamp: new Date().toISOString(),
					message: {
						role: "user",
						content: [{ type: "image", mimeType: "image/png", data: reference }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					id: "readable-after",
					parentId: "resident-entry",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: "Readable after" }], timestamp: Date.now() },
				},
			]
				.map(row => JSON.stringify(row))
				.join("\n") +
			"\n",
	);
	await h.call("project.open", { path: h.cwd });
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.messages.map(message => message.text)).toEqual(["Readable before", "Readable after"]);
	expect(selected.observation).toMatchObject({
		source: "disk",
		unresolvedCount: 1,
		sequence: [
			{ kind: "content", entryId: terminal.leaf },
			{ kind: "unresolved", entryId: "resident-entry", reason: "resident_payload_unavailable" },
			{ kind: "content", entryId: "readable-after" },
		],
	});
	expect(selected.historyTruncated).toBe(true);
	expect(JSON.stringify(selected)).not.toContain(reference);
	const history = await h.call<DesktopHistory>("history.get", { sessionId: terminal.id });
	expect(history.observation?.unresolvedCount).toBe(1);
	expect(history.observation?.sequence).toEqual(selected.observation?.sequence);
	expect(history.truncated).toBe(true);
});

test("SDK disk observation returns exact identity, refuses foreign context and revalidates moved captures", async () => {
	const h = await fixture();
	const terminal = await h.persist("Exact snapshot");
	const input = { file: terminal.file, cwd: h.cwd, sessionId: terminal.id };
	const observed = sdk.observeEmbeddedTranscript(input);
	expect(observed.kind).toBe("observed");
	if (observed.kind !== "observed") throw new Error(observed.reason);
	expect(observed.identity.sha256).toBe(terminal.checkpoint.snapshotDigest);
	expect(observed.identity.sessionId).toBe(terminal.id);
	expect(observed.selectionRequired).toBe(false);
	expect(observed.messages).toHaveLength(1);
	expect(sdk.observeEmbeddedTranscript({ ...input, sessionId: crypto.randomUUID() })).toEqual({
		kind: "refused",
		reason: "context_mismatch",
	});
	await Bun.write(
		terminal.file,
		(await Bun.file(terminal.file).text()) +
			JSON.stringify({
				type: "message",
				id: "other-root",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text: "Other branch" }], timestamp: Date.now() },
			}) +
			"\n",
	);
	const ambiguous = sdk.observeEmbeddedTranscript(input);
	expect(ambiguous).toMatchObject({ kind: "observed", selectionRequired: true, messages: [] });
	const capture = SessionManager.captureTranscriptStrict;
	vi.spyOn(SessionManager, "captureTranscriptStrict").mockImplementation((...args) => {
		const result = capture(...args);
		if (result.kind === "captured") {
			const materialize = result.snapshot.materialize.bind(result.snapshot);
			result.snapshot.materialize = () => {
				const bytes = materialize();
				fsSync.renameSync(terminal.file, `${terminal.file}.moved`);
				return bytes;
			};
		}
		return result;
	});
	expect(sdk.observeEmbeddedTranscript(input)).toEqual({ kind: "refused", reason: "stale_snapshot" });
});

test("selecting another surface's owned transcript observes disk without weakening ownership refusals", async () => {
	const h = await fixture();
	const terminal = await h.persist("Owned terminal");
	const owner = await openNativeSession({
		options: {
			cwd: h.cwd,
			agentDir: h.agentDir,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMcpAutoload: false,
			enableLsp: false,
			skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
			deferMemoryBackendStartup: true,
			toolNames: [],
		},
		storage: { managed: true },
		file: terminal.file,
		selection: { snapshotDigest: terminal.checkpoint.snapshotDigest, targetLeafId: terminal.leaf },
		legacyAttestation: { snapshotDigest: terminal.checkpoint.snapshotDigest, acknowledged: true },
	});
	if (owner.kind !== "opened") throw new Error(`External owner failed: ${owner.kind}`);
	cleanups.push(async () => {
		expect(await owner.session.disconnect()).toEqual({ kind: "disconnected" });
	});
	const resolved = sdk.resolveEmbeddedResumeCheckpoint(terminal.file);
	if (resolved.kind !== "resolved") throw new Error(resolved.reason);
	const id = terminal.id;
	await h.call("project.open", { path: h.cwd });
	const selected = await h.call<DesktopSession>("session.select", { sessionId: id });
	expect(selected.readOnly).toBe(true);
	expect(
		await h.call<{ kind: string; reason: string }>("session.connect", {
			sessionId: id,
			selection: {
				snapshotDigest: resolved.checkpoint.snapshotDigest,
				targetLeafId: resolved.checkpoint.leafEntryId,
			},
			legacyAttestation: { snapshotDigest: resolved.checkpoint.snapshotDigest, acknowledged: true },
		}),
	).toEqual({ kind: "refused", reason: "authority_lost_unresolved" });
	const create = sdk.createEmbeddedAgentSession;
	function refuse(input: sdk.NativeEmbeddedAgentSessionOptions): Promise<sdk.NativeEmbeddedOpenResult>;
	function refuse(input: sdk.EmbeddedAgentSessionOptions): Promise<sdk.EmbeddedAgentSessionResult>;
	async function refuse(
		input: sdk.NativeEmbeddedAgentSessionOptions | sdk.EmbeddedAgentSessionOptions,
	): Promise<sdk.NativeEmbeddedOpenResult | sdk.EmbeddedAgentSessionResult> {
		return "native" in input ? { kind: "refused", reason: "owned_by_other" } : create(input);
	}
	vi.spyOn(sdk, "createEmbeddedAgentSession").mockImplementation(refuse);
	expect(await h.call<{ kind: string; reason: string }>("session.connect", { sessionId: id })).toEqual({
		kind: "refused",
		reason: "owned_by_other",
	});
});

test("explicit refresh throttles rapid requests for 30 seconds and scans again at the boundary", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
	let now = Math.ceil(performance.now());
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions");
	const first = await h.persist("First refreshed row");
	await h.call("project.refresh", { projectId: project.id });
	const second = await h.persist("Second refreshed row");
	for (let i = 0; i < 3; i++) {
		const throttled = await h.call<DesktopProjectRefreshResult>("project.refresh", { projectId: project.id });
		expect(throttled).toMatchObject({ kind: "throttled", retryAfter: 30_000 });
	}
	expect(listing).toHaveBeenCalledTimes(1);
	expect(h.host.snapshot().sessions.map(row => row.id)).toEqual([first.id]);
	now += 29_999;
	expect(await h.call<DesktopProjectRefreshResult>("project.refresh", { projectId: project.id })).toMatchObject({
		kind: "throttled",
		retryAfter: 1,
	});
	expect(listing).toHaveBeenCalledTimes(1);
	now += 1;
	const result = await h.call<DesktopProjectRefreshResult>("project.refresh", { projectId: project.id });
	expect(listing).toHaveBeenCalledTimes(2);
	expect(result.kind).toBe("refreshed");
	expect(result.snapshot.sessions.map(row => row.id)).toEqual([first.id, second.id]);
});

test("an unchanged refresh scans without enqueuing another catalog replacement", async () => {
	const h = await fixture();
	const terminal = await h.persist("Already listed");
	const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
	const catalog = Bun.file(path.join(h.dataDir, "catalog.json"));
	const before = await catalog.text();
	const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions");
	const rename = vi.spyOn(fs, "rename");

	const result = await h.call<DesktopProjectRefreshResult>("project.refresh", { projectId: project.id });
	expect(result.kind).toBe("refreshed");
	expect(result.snapshot.sessions.map(row => row.id)).toEqual([terminal.id]);
	expect(listing).toHaveBeenCalledTimes(1);
	expect(rename.mock.calls.some(([, destination]) => destination === catalog.name)).toBe(false);
	expect(await catalog.text()).toBe(before);
});

test("overlapping explicit refreshes join one in-flight scan", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
	const terminal = await h.persist("Concurrent discovery");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const list = sdk.listEmbeddedProjectSessions;
	const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementation(async options => {
		entered.resolve();
		await release.promise;
		return list(options);
	});
	const first = h.call<DesktopProjectRefreshResult>("project.refresh", { projectId: project.id });
	const pending: Promise<unknown>[] = [first];
	try {
		await enteredBeforeSettling(entered.promise, first);
		const second = h.call<DesktopProjectRefreshResult>("project.refresh", { projectId: project.id });
		pending.push(second);
		await Bun.sleep(5);
		expect(listing).toHaveBeenCalledTimes(1);
		release.resolve();
		expect((await first).snapshot.sessions.map(row => row.id)).toEqual([terminal.id]);
		expect(await second).toEqual(await first);
		expect(listing).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await Promise.allSettled(pending);
	}
});

for (const reopen of [false, true]) {
	test(`discovery started before project close publishes nothing${reopen ? " even after reopening" : ""}`, async () => {
		const h = await fixture();
		const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
		const terminal = await h.persist("Stale scan only");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const list = sdk.listEmbeddedProjectSessions;
		vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementationOnce(async options => {
			const result = await list(options);
			entered.resolve();
			await release.promise;
			return result;
		});
		const refreshing = h.call("project.refresh", { projectId: project.id });
		try {
			await enteredBeforeSettling(entered.promise, refreshing);
			await h.call("project.close", { projectId: project.id });
			await fs.rm(terminal.file);
			if (reopen) await h.call("project.open", { path: h.cwd });
			const snapshots = h.frames.filter(frame => frame.type === "snapshot").length;
			release.resolve();
			await expect(refreshing).rejects.toThrow("Workspace changed while refreshing discovery");
			expect(h.host.snapshot().sessions).toEqual([]);
			expect(h.frames.filter(frame => frame.type === "snapshot")).toHaveLength(snapshots);
			const catalog = await Bun.file(path.join(h.dataDir, "catalog.json")).text();
			expect(catalog).not.toContain(terminal.id);
		} finally {
			release.resolve();
			await Promise.allSettled([refreshing]);
		}
	});
}

test("host shutdown fences an in-flight discovery from publishing into a retired generation", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
	const terminal = await h.persist("Host generation changed");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const list = sdk.listEmbeddedProjectSessions;
	vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementationOnce(async options => {
		const result = await list(options);
		entered.resolve();
		await release.promise;
		return result;
	});
	const refreshing = h.call("project.refresh", { projectId: project.id });
	try {
		await enteredBeforeSettling(entered.promise, refreshing);
		const closing = h.host.close();
		const snapshots = h.frames.filter(frame => frame.type === "snapshot").length;
		release.resolve();
		await expect(refreshing).rejects.toThrow("Workspace changed while refreshing discovery");
		await closing;
		expect(h.frames.filter(frame => frame.type === "snapshot")).toHaveLength(snapshots);
		expect(await Bun.file(path.join(h.dataDir, "catalog.json")).text()).not.toContain(terminal.id);
	} finally {
		release.resolve();
		await Promise.allSettled([refreshing]);
	}
});

for (const retirement of ["close", "reopen", "shutdown"] as const) {
	for (const method of ["session.select", "history.get"] as const) {
		test(`captured ${method} cannot publish after queued ${retirement} before dispatcher continuation`, async () => {
			const h = await fixture();
			const terminal = await h.persist("Captured but retired");
			const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
			const before = await Bun.file(terminal.file).text();
			const observe = sdk.observeEmbeddedTranscript;
			let retiring: Promise<unknown> | undefined;
			let snapshots = 0;
			vi.spyOn(sdk, "observeEmbeddedTranscript").mockImplementationOnce(input => {
				const observed = observe(input);
				if (observed.kind !== "observed") throw new Error(observed.reason);
				if (retirement === "shutdown") {
					// close marks retirement synchronously, then joins this very request.
					// Let dispatch reject before awaiting that join to avoid a cycle.
					retiring = h.host.close();
					snapshots = h.frames.filter(frame => frame.type === "snapshot").length;
					return observed;
				}
				// A real promise pauses async-return assimilation after capture, before dispatch.
				retiring = (async () => {
					await h.call("project.close", { projectId: project.id });
					if (retirement === "reopen") await h.call("project.open", { path: h.cwd });
				})();
				const held = retiring.then(() => {
					snapshots = h.frames.filter(frame => frame.type === "snapshot").length;
					return observed;
				});
				return Object.assign(held, observed);
			});
			await expect(h.call(method, { sessionId: terminal.id })).rejects.toThrow("changed while observing history");
			await retiring;
			expect(h.frames.filter(frame => frame.type === "snapshot")).toHaveLength(snapshots);
			expect(await Bun.file(terminal.file).text()).toBe(before);
			if (retirement === "reopen")
				expect(h.host.snapshot().sessions[0]).toMatchObject({ controlGeneration: null, readOnly: true });
			expect(h.host.snapshot().sessions.every(row => row.observation === undefined)).toBe(true);
		});
	}
}

test("overlapping histories pair messages and observation metadata from each request's capture", async () => {
	const h = await fixture();
	const terminal = await h.persist("Snapshot A");
	await h.call("project.open", { path: h.cwd });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const observe = sdk.observeEmbeddedTranscript;
	vi.spyOn(sdk, "observeEmbeddedTranscript").mockImplementationOnce(input => {
		const observed = observe(input);
		if (observed.kind !== "observed") throw new Error(observed.reason);
		entered.resolve();
		return Object.assign(
			release.promise.then(() => observed),
			observed,
		);
	});
	const first = h.call<DesktopHistory>("history.get", { sessionId: terminal.id });
	try {
		await enteredBeforeSettling(entered.promise, first);
		const manager = await SessionManager.open(terminal.file, SessionManager.managedDestination(h.cwd, h.agentDir));
		try {
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Snapshot B" }],
				timestamp: Date.now(),
			});
			await manager.flush();
		} finally {
			await manager.close();
		}
		const second = await h.call<DesktopHistory>("history.get", { sessionId: terminal.id });
		release.resolve();
		const original = await first;
		expect(original.messages.map(message => message.text)).toEqual(["Snapshot A"]);
		expect(original.observation?.snapshotDigest).toBe(terminal.checkpoint.snapshotDigest);
		expect(original.observation?.sequence).toEqual([{ kind: "content", entryId: terminal.leaf }]);
		expect(second.messages.map(message => message.text)).toEqual(["Snapshot A", "Snapshot B"]);
		expect(second.observation?.snapshotDigest).not.toBe(original.observation?.snapshotDigest);
		expect(second.observation?.sequence).toHaveLength(2);
	} finally {
		release.resolve();
		await Promise.allSettled([first]);
	}
});

test("limited observed history advertises truncation while preserving its complete captured sequence", async () => {
	const h = await fixture();
	const terminal = await h.persist("First persisted message");
	const manager = await SessionManager.open(terminal.file, SessionManager.managedDestination(h.cwd, h.agentDir));
	try {
		for (let index = 0; index < HISTORY_LIMIT; index++)
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `Persisted message ${index}` }],
				timestamp: Date.now(),
			});
		await manager.flush();
	} finally {
		await manager.close();
	}
	await h.call("project.open", { path: h.cwd });
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.historyTruncated).toBe(true);
	expect(selected.messages).toHaveLength(HISTORY_LIMIT);
	expect(selected.messages[0]?.text).toBe("Persisted message 0");
	expect(selected.observation?.unresolvedCount).toBe(0);
	expect(selected.observation?.sequence).toHaveLength(HISTORY_LIMIT + 1);
	expect(selected.observation?.sequence[0]).toEqual({ kind: "content", entryId: terminal.leaf });
});

test("refresh is additive: preserves user order, missing history and live App rows without persisting reading state", async () => {
	const h = await fixture();
	const first = await h.persist("First terminal row");
	const second = await h.persist("Second terminal row");
	const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
	const app = await h.call<DesktopSession>("session.create", { projectId: project.id });
	await h.call("session.star", { sessionId: app.id, starred: true });
	await h.call("session.rename", { sessionId: app.id, title: "User title" });
	const order = [app.id, second.id, first.id];
	await h.call("session.reorder", { projectId: project.id, ids: order });
	await fs.rm(first.file);
	const third = await h.persist("New history");
	const list = sdk.listEmbeddedProjectSessions;
	vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementation(async options => {
		const result = await list(options);
		return { ...result, managed: result.managed.filter(row => row.id === third.id), local: [] };
	});
	await h.call("project.refresh", { projectId: project.id });
	expect(h.host.snapshot().sessions.map(row => row.id)).toEqual([...order, third.id]);
	expect(h.host.snapshot().sessions[0]).toMatchObject({ id: app.id, title: "User title", starred: true });
	const selected = await h.call<DesktopSession>("session.select", { sessionId: app.id });
	expect(selected.readOnly).toBeUndefined();
	const catalog = await Bun.file(path.join(h.dataDir, "catalog.json")).json();
	expect(catalog.sessions.map((row: { id: string }) => row.id)).toEqual([...order, third.id]);
	expect(JSON.stringify(catalog)).not.toMatch(/scroll|readingPosition/);
});

test("bootstrap discovers new history once per open project and never scans a closed workspace", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
	const terminal = await h.persist("Added while the App was disconnected");
	const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions");
	const initial = await h.call<DesktopSnapshot>("bootstrap", {});
	expect(initial.sessions.map(row => row.id)).toEqual([terminal.id]);
	expect(initial.sessions[0]).toMatchObject({ origin: "external", mode: "readonly", readOnly: true });
	await h.call("bootstrap", {});
	expect(listing).toHaveBeenCalledTimes(1);
	await h.call("project.close", { projectId: project.id });
	const closed = await h.call<DesktopSnapshot>("bootstrap", {});
	expect(closed.projects).toEqual([]);
	expect(closed.sessions).toEqual([]);
	expect(listing).toHaveBeenCalledTimes(1);
});

test("failed bootstrap discovery preserves the catalog instead of treating failure as deletion", async () => {
	const h = await fixture();
	const terminal = await h.persist("Retained history");
	await h.call("project.open", { path: h.cwd });
	vi.spyOn(sdk, "listEmbeddedProjectSessions").mockRejectedValueOnce(new Error("Inventory unavailable"));
	const initial = await h.call<DesktopSnapshot>("bootstrap", {});
	expect(initial.sessions.map(row => row.id)).toEqual([terminal.id]);
	expect(await Bun.file(path.join(h.dataDir, "catalog.json")).text()).toContain(terminal.id);
});

test("refresh refuses unknown and closed projects without scanning or opening them", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.cwd });
	await h.call("project.close", { projectId: project.id });
	const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions");
	await expect(h.call("project.refresh", { projectId: project.id })).rejects.toThrow("Workspace is closed");
	await expect(h.call("project.refresh", { projectId: crypto.randomUUID() })).rejects.toThrow("Project not found");
	expect(listing).not.toHaveBeenCalled();
	expect(h.host.snapshot().projects).toEqual([]);
});
