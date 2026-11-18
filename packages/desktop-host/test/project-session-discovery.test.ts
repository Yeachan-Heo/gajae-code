import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import * as sdk from "@gajae-code/coding-agent/sdk";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import { openNativeSession } from "../src/native-session";
import {
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	parseRequest,
} from "../src/protocol";

let environment: NodeJS.ProcessEnv;
let previousAgentDir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	environment = { ...process.env };
	previousAgentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
});
afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(previousAgentDir);
	}
});

async function waitForEntry(entered: Promise<void>, operation: Promise<unknown>): Promise<void> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error("Deferred SDK operation did not enter")), 2_000);
	try {
		await Promise.race([
			entered,
			operation.then(() => {
				throw new Error("SDK operation settled before entering the deferred observation");
			}),
			expired.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function fixture() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-discovery-")));
	const dataDir = path.join(directory, "app");
	const agentDir = path.join(dataDir, "agent");
	const projectDir = path.join(directory, "project");
	await fs.mkdir(projectDir);
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	setAgentDir(agentDir);
	await setModelPresetRegistryDisabled({ agentDir, disabled: true });
	const frames: DesktopFrame[] = [];
	const created: CreateAgentSessionResult[] = [];
	const managers: SessionManager[] = [];
	const createHost = () =>
		new DesktopHost({
			dataDir,
			emit: frame => frames.push(frame),
			createSession: async options => {
				const result = await createAgentSession({
					...options,
					model: getBundledModel("anthropic", "claude-sonnet-4-5"),
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
				});
				created.push(result);
				return result;
			},
		});
	let host = createHost();
	cleanups.push(async () => {
		await host.close();
		await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
		for (const manager of managers) await manager.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (response?.type !== "response") throw new Error("Missing response");
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	const persist = async (title: string, cwd = projectDir, keepOpen = false) => {
		await fs.mkdir(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		managers.push(manager);
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Message for ${title}` }],
			timestamp: Date.now(),
		});
		await manager.setSessionName(title, "user");
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing persisted session");
		const id = manager.getSessionId();
		const bytes = await Bun.file(file).text();
		if (!keepOpen) {
			const membership = manager.getOwnerMembership();
			if (!membership) throw new Error("Missing fixture cooperative owner membership");
			const closed = await manager.flushAndCloseStrict();
			if (closed.kind !== "closed") throw new Error(`Fixture strict close failed: ${JSON.stringify(closed)}`);
			expect(manager.retireCooperativeOwnerAfterClose(membership)).toBe(true);
		}
		return { id, file, bytes };
	};
	return {
		call,
		persist,
		created,
		dataDir,
		projectDir,
		agentDir,
		snapshot: () => host.snapshot(),
		restart: async () => {
			await host.close();
			await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
			host = createHost();
			await host.initialize();
		},
	};
}

test("discovers exact-project SDK sessions in creation order without opening or modifying them", async () => {
	const h = await fixture();
	const first = await h.persist("First terminal conversation");
	const second = await h.persist("Second terminal conversation");
	await h.persist("Nested project", path.join(h.projectDir, "nested"));
	await h.persist("Sibling project", path.join(h.projectDir, "..", "sibling"));
	// A project-local candidate with a foreign header is not authority for this project.
	await Bun.write(
		path.join(h.projectDir, ".gjc", "sessions", "foreign.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: crypto.randomUUID(),
			cwd: path.dirname(h.projectDir),
			timestamp: new Date().toISOString(),
		})}\n`,
	);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => [session.id, session.projectId, session.title])).toEqual([
		[first.id, project.id, "First terminal conversation"],
		[second.id, project.id, "Second terminal conversation"],
	]);
	expect(h.created).toHaveLength(0);
	expect(await Bun.file(first.file).text()).toBe(first.bytes);
	expect(await Bun.file(second.file).text()).toBe(second.bytes);
	const catalog = await Bun.file(path.join(h.dataDir, "catalog.json")).text();
	expect(catalog).not.toContain(first.file);
	expect(JSON.stringify(h.snapshot().sessions)).not.toContain(h.agentDir);
});

test("refreshes an existing registration idempotently and preserves desktop-owned sessions", async () => {
	const h = await fixture();
	const first = await h.persist("Terminal conversation");
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const desktop = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const second = await h.persist("New terminal conversation");
	const reopened = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	await h.call("project.open", { path: h.projectDir });
	expect(reopened.id).toBe(project.id);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, desktop.id, second.id]);
	expect(h.created).toHaveLength(1);
	const selected = await h.call<DesktopSession>("session.select", { sessionId: desktop.id });
	expect(selected.id).toBe(desktop.id);
});

test("keeps discovered references across close, reopen and host restart", async () => {
	const h = await fixture();
	const first = await h.persist("Before close");
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	await h.call("project.close", { projectId: project.id });
	expect(h.snapshot().sessions).toEqual([]);
	await h.restart();
	expect(h.snapshot().projects).toEqual([]);
	const second = await h.persist("While closed");
	const reopened = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	expect(reopened.id).toBe(project.id);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, second.id]);
	await h.restart();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, second.id]);
	expect(h.created).toHaveLength(0);
});

test("serializes discovery refresh with close and reopen of the same project", async () => {
	const h = await fixture();
	const first = await h.persist("Existing conversation");
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const second = await h.persist("Discovered during refresh");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const list = sdk.listEmbeddedProjectSessions;
	const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementation(async (...args) => {
		entered.resolve();
		await release.promise;
		return list(...args);
	});
	const refresh = h.call("project.open", { path: h.projectDir });
	const pending: Promise<unknown>[] = [refresh];
	try {
		await waitForEntry(entered.promise, refresh);
		expect(listing.mock.calls[0]?.[0]).toEqual({
			cwd: project.path,
			agentDir: h.agentDir,
			directory: path.join(h.dataDir, "sessions", project.id),
		});
		const close = h.call("project.close", { projectId: project.id });
		const reopen = h.call<DesktopProject>("project.open", { path: h.projectDir });
		pending.push(close, reopen);
		release.resolve();
		await refresh;
		await close;
		expect((await reopen).id).toBe(project.id);
		expect(h.snapshot().projects.map(item => item.id)).toEqual([project.id]);
		expect(h.snapshot().sessions.map(session => session.id)).toEqual([first.id, second.id]);
		expect(h.created).toHaveLength(0);
	} finally {
		release.resolve();
		await Promise.allSettled(pending);
		listing.mockRestore();
	}
});

for (const afterReopen of [false, true]) {
	test(`does not publish a disk observation that finishes ${afterReopen ? "after project reopen" : "during project close"}`, async () => {
		const h = await fixture();
		const terminal = await h.persist("Delayed terminal attachment");
		const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const list = sdk.listEmbeddedProjectSessions;
		const listing = vi.spyOn(sdk, "listEmbeddedProjectSessions").mockImplementationOnce(async options => {
			const inventory = await list(options);
			entered.resolve();
			await release.promise;
			return inventory;
		});
		const selecting = h.call("session.select", { sessionId: terminal.id });
		const pending: Promise<unknown>[] = [selecting];
		try {
			await waitForEntry(entered.promise, selecting);
			const closing = h.call("project.close", { projectId: project.id });
			pending.push(closing);
			const deadline = Date.now() + 2_000;
			while (h.snapshot().projects.some(item => item.id === project.id)) {
				if (Date.now() >= deadline) throw new Error("Project did not publish its closed fence");
				await Bun.sleep(5);
			}
			await closing;
			if (afterReopen) {
				await h.call("project.open", { path: h.projectDir });
				expect(h.snapshot().projects.map(item => item.id)).toEqual([project.id]);
			}
			release.resolve();
			await expect(selecting).rejects.toThrow("changed while observing history");
			if (!afterReopen) await h.call("project.open", { path: h.projectDir });
			expect(await Bun.file(terminal.file).text()).toBe(terminal.bytes);
			expect(h.snapshot().sessions.find(item => item.id === terminal.id)?.observation).toBeUndefined();
			expect(h.created).toHaveLength(0);
			expect(h.snapshot().sessions.find(item => item.id === terminal.id)?.controlGeneration).toBeNull();
		} finally {
			// Even a failed entry/fence assertion must unblock host.close in afterEach.
			release.resolve();
			await Promise.allSettled(pending);
			listing.mockRestore();
		}
	});
}

test("surfaces an SDK disk selection failure before the deferred observation barrier", async () => {
	const h = await fixture();
	const terminal = await h.persist("Unavailable attachment");
	await h.call("project.open", { path: h.projectDir });
	const entered = Promise.withResolvers<void>();
	const opening = vi.spyOn(sdk, "observeEmbeddedTranscript").mockImplementation(() => {
		throw new Error("Early selection failure");
	});
	const selecting = h.call("session.select", { sessionId: terminal.id });
	try {
		await expect(waitForEntry(entered.promise, selecting)).rejects.toThrow("Early selection failure");
		expect(h.created).toHaveLength(0);
		expect(await Bun.file(terminal.file).text()).toBe(terminal.bytes);
		expect(h.snapshot().sessions[0]?.controlGeneration).toBeNull();
	} finally {
		await Promise.allSettled([selecting]);
		opening.mockRestore();
	}
});

test("requires the rendered native generation for writes and never reconnects to satisfy a stale control", async () => {
	const availableModel = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!availableModel) throw new Error("Missing fixture model");
	process.env.GJC_NO_TITLE = "1";
	const h = await fixture();
	const terminal = await h.persist("Generation-owned controls");
	await h.call("project.open", { path: h.projectDir });
	const writes: Array<{ method: DesktopRequest["method"]; input: Record<string, unknown> }> = [
		{ method: "model.set", input: { modelId: "anthropic/claude-sonnet-4-5" } },
		{ method: "thinking.set", input: { level: "off" } },
		{ method: "prompt", input: { text: "Only the rendered owner may receive this" } },
		{ method: "abort", input: {} },
	];
	const admission = vi.spyOn(sdk, "createEmbeddedAgentSession");
	for (const selected of [false, true]) {
		if (selected) await h.call("session.select", { sessionId: terminal.id });
		for (const sessionGeneration of [undefined, null, "7", -1, 7.5, 7])
			for (const { method, input } of writes)
				await expect(h.call(method, { sessionId: terminal.id, sessionGeneration, ...input })).rejects.toThrow(
					"read-only",
				);
	}
	expect(admission).not.toHaveBeenCalled();
	expect(h.created).toHaveLength(0);
	expect(await Bun.file(terminal.file).text()).toBe(terminal.bytes);
	const connect = async () => {
		const resolved = sdk.resolveEmbeddedResumeCheckpoint(terminal.file);
		if (resolved.kind !== "resolved") throw new Error(resolved.reason);
		// SDK-persisted fixtures have an enrolled, explicitly retired owner, not a legacy row.
		const result = await h.call<{ kind: "connected"; session: DesktopSession } | { kind: "refused"; reason: string }>(
			"session.connect",
			{
				sessionId: terminal.id,
				selection: {
					snapshotDigest: resolved.checkpoint.snapshotDigest,
					targetLeafId: resolved.checkpoint.leafEntryId,
				},
			},
		);
		if (result.kind !== "connected") throw new Error(`Native fixture connect failed: ${JSON.stringify(result)}`);
		return result.session;
	};
	const connected = await connect();
	const generation = connected.controlGeneration;
	if (generation === null) throw new Error("Missing native control generation");
	const owner = h.created.at(-1)?.session;
	if (!owner) throw new Error("Missing native SDK owner");
	// Isolated mode removes inherited keys. Seed the real temporary credential
	// store rather than fabricating model availability or skipping auth preflight.
	await owner.modelRegistry.authStorage.set(availableModel.provider, {
		type: "api_key", key: "fixture-anthropic-key",
	});
	if (!owner.modelRegistry.find(availableModel.provider, availableModel.id, owner.credentialSessionId))
		throw new Error("Generation fixture model is absent from the actual registered catalog");
	if (!await owner.modelRegistry.getApiKey(availableModel, owner.credentialSessionId))
		throw new Error("Generation fixture has no isolated credential for its model");
	const sdkGeneration = owner.sessionLifecycle.generation;
	const connectedBytes = await Bun.file(terminal.file).text();
	const promotion = vi.spyOn(owner.sessionManager, "promoteDefaultModelSelection");
	const model = vi.spyOn(owner, "setDefaultModelSelection");
	const thinking = vi.spyOn(owner, "setThinkingLevelForControl").mockResolvedValue(undefined);
	const prompt = vi.spyOn(owner, "prompt").mockResolvedValue(undefined);
	const abort = vi.spyOn(owner, "abort").mockResolvedValue(undefined);
	for (const sessionGeneration of [
		undefined,
		null,
		"7",
		-1,
		generation - 1,
		generation + 1,
		7.5,
		Number.MAX_SAFE_INTEGER + 1,
	])
		for (const { method, input } of writes)
			await expect(h.call(method, { sessionId: terminal.id, sessionGeneration, ...input })).rejects.toThrow(
				"SDK owner changed",
			);
	for (const spy of [model, thinking, prompt, abort]) expect(spy).not.toHaveBeenCalled();
	expect(await Bun.file(terminal.file).text()).toBe(connectedBytes);
	for (const { method, input } of writes) {
		try {
			await h.call(method, { sessionId: terminal.id, sessionGeneration: generation, ...input });
		} catch (error) {
			const result = model.mock.results.at(-1);
			const outcome = result?.type === "return" ? await Promise.allSettled([result.value]) : undefined;
			const promotions = promotion.mock.results.map(result => {
				if (result.type !== "return") return { type: result.type, error: String(result.value) };
				const value = result.value;
				return { kind: value.kind, error: "error" in value ? value.error?.stack : undefined };
			});
			throw new Error(`${method}: ${String(error)}; model producer outcome: ${JSON.stringify(outcome)}; transcript promotions: ${JSON.stringify(promotions)}`);
		}
	}
	expect(model).toHaveBeenCalledTimes(1);
	expect(thinking).toHaveBeenCalledTimes(1);
	expect(prompt).toHaveBeenCalledTimes(1);
	expect(abort).toHaveBeenCalledTimes(1);
	for (const spy of [promotion, model, thinking, prompt, abort]) spy.mockRestore();
	expect(await h.call<{ kind: string }>("session.disconnect", { sessionId: terminal.id })).toEqual({
		kind: "disconnected",
	});
	const admissions = admission.mock.calls.length;
	for (const { method, input } of writes)
		await expect(h.call(method, { sessionId: terminal.id, sessionGeneration: generation, ...input })).rejects.toThrow(
			"read-only",
		);
	expect(admission).toHaveBeenCalledTimes(admissions);
	const reconnected = await connect();
	expect(h.created.at(-1)?.session.sessionLifecycle.generation).toBe(sdkGeneration);
	expect(reconnected.controlGeneration).not.toBeNull();
	expect(reconnected.controlGeneration).not.toBe(generation);
	for (const { method, input } of writes)
		await expect(h.call(method, { sessionId: terminal.id, sessionGeneration: generation, ...input })).rejects.toThrow(
			"SDK owner changed",
		);
});

test("sorts an older late discovery before newer desktop sessions across refresh and restart", async () => {
	const h = await fixture();
	const older = await h.persist("Older terminal conversation");
	const held = `${older.file}.held`;
	await fs.rename(older.file, held);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const desktop = await h.call<DesktopSession>("session.create", { projectId: project.id });
	await fs.rename(held, older.file);
	await h.call("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, desktop.id]);
	await h.restart();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, desktop.id]);
	expect(await Bun.file(older.file).text()).toBe(older.bytes);
});

test("late discovery preserves explicit desktop session order across refresh and restart", async () => {
	const h = await fixture();
	const older = await h.persist("Older terminal conversation");
	const held = `${older.file}.held`;
	await fs.rename(older.file, held);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const first = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const second = await h.call<DesktopSession>("session.create", { projectId: project.id });
	await h.call("session.reorder", { projectId: project.id, ids: [second.id, first.id] });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([second.id, first.id]);

	await fs.rename(held, older.file);
	await h.call("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, second.id, first.id]);
	// A repeated refresh must not sort the already persisted, explicitly reordered pair.
	await h.call("project.open", { path: h.projectDir });
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, second.id, first.id]);
	await h.restart();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([older.id, second.id, first.id]);
	expect(await Bun.file(older.file).text()).toBe(older.bytes);
});

test("selection observes another surface's owner without admission; explicit connect preserves refusal", async () => {
	const h = await fixture();
	const terminal = await h.persist("Still owned by terminal");
	const resolved = sdk.resolveEmbeddedResumeCheckpoint(terminal.file);
	if (resolved.kind !== "resolved") throw new Error(resolved.reason);
	const selection = {
		snapshotDigest: resolved.checkpoint.snapshotDigest,
		targetLeafId: resolved.checkpoint.leafEntryId,
	};
	const owner = await openNativeSession({
		options: {
			cwd: h.projectDir,
			agentDir: h.agentDir,
			extensions: [],
			disableExtensionDiscovery: true,
			enableMcpAutoload: false,
			enableLsp: false,
			skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
			deferMemoryBackendStartup: true,
			toolNames: [],
		},
		storage: { managed: true },
		file: terminal.file,
		selection,
	});
	if (owner.kind !== "opened") throw new Error(`External owner failed: ${JSON.stringify(owner)}`);
	cleanups.push(async () => {
		expect(await owner.session.disconnect()).toEqual({ kind: "disconnected" });
	});
	const bytes = await Bun.file(terminal.file).text();
	await h.call("project.open", { path: h.projectDir });
	const admission = vi.spyOn(sdk, "createEmbeddedAgentSession");
	const resume = vi.spyOn(sdk.lifecycle.AgentDirSessionLifecycleService.prototype, "resume");
	const selected = await h.call<DesktopSession>("session.select", { sessionId: terminal.id });
	expect(selected.readOnly).toBe(true);
	expect(selected.controlGeneration).toBeNull();
	expect(admission).not.toHaveBeenCalled();
	expect(resume).not.toHaveBeenCalled();
	await expect(h.call("session.delete", { sessionId: terminal.id })).rejects.toThrow("read-only");
	const current = sdk.resolveEmbeddedResumeCheckpoint(terminal.file);
	if (current.kind !== "resolved") throw new Error(current.reason);
	expect(
		await h.call<{ kind: string; reason: string }>("session.connect", {
			sessionId: terminal.id,
			selection: { snapshotDigest: current.checkpoint.snapshotDigest, targetLeafId: current.checkpoint.leafEntryId },
			legacyAttestation: { snapshotDigest: current.checkpoint.snapshotDigest, acknowledged: true },
		}),
	).toEqual({ kind: "refused", reason: "authority_lost_unresolved" });
	expect(h.created).toHaveLength(0);
	expect(await Bun.file(terminal.file).text()).toBe(bytes);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([terminal.id]);
});
