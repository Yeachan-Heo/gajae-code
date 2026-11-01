import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import { ManagedSession } from "../src/managed-session";
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
				throw new Error("SDK operation settled before entering the deferred attachment");
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
				const result = await createAgentSession({ ...options, extensions: [] });
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
		if (!response || response.type !== "response") throw new Error("Missing response");
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
		if (!keepOpen) await manager.close();
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
	const list = SessionManager.listManagedForResumePickerReadOnly;
	const listing = vi.spyOn(SessionManager, "listManagedForResumePickerReadOnly").mockImplementation(async (...args) => {
		entered.resolve();
		await release.promise;
		return list(...args);
	});
	const refresh = h.call("project.open", { path: h.projectDir });
	const pending: Promise<unknown>[] = [refresh];
	try {
		await waitForEntry(entered.promise, refresh);
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
	test(`does not publish an SDK attachment that finishes ${afterReopen ? "after project reopen" : "during project close"}`, async () => {
		const h = await fixture();
		const terminal = await h.persist("Delayed terminal attachment");
		const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const opening = vi.spyOn(ManagedSession.prototype, "open").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const detached = vi.spyOn(ManagedSession.prototype, "close").mockResolvedValue(undefined);
		// Exercise a real late completion beyond the close budget without waiting
		// fifteen seconds. The project must fence it even after closed is cleared.
		const budget = afterReopen ? vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(AbortSignal.abort()) : undefined;
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
			const reopening = h.call("project.open", { path: h.projectDir });
			pending.push(reopening);
			if (afterReopen) {
				await closing;
				await reopening;
				expect(h.snapshot().projects.map(item => item.id)).toEqual([project.id]);
			}
			release.resolve();
			await expect(selecting).rejects.toThrow("closed while connecting");
			await closing;
			await reopening;
			expect(detached).toHaveBeenCalledTimes(1);
			expect(h.created).toHaveLength(0);
			expect(h.snapshot().sessions.find(item => item.id === terminal.id)?.controlGeneration).toBeNull();
		} finally {
			// Even a failed entry/fence assertion must unblock host.close in afterEach.
			release.resolve();
			await Promise.allSettled(pending);
			budget?.mockRestore();
			opening.mockRestore();
			detached.mockRestore();
		}
	});
}

test("surfaces an SDK selection failure before the deferred attachment barrier", async () => {
	const h = await fixture();
	const terminal = await h.persist("Unavailable attachment");
	await h.call("project.open", { path: h.projectDir });
	const entered = Promise.withResolvers<void>();
	const opening = vi.spyOn(ManagedSession.prototype, "open").mockRejectedValue(new Error("Early selection failure"));
	const selecting = h.call("session.select", { sessionId: terminal.id });
	try {
		await expect(waitForEntry(entered.promise, selecting)).rejects.toThrow("Early selection failure");
	} finally {
		await Promise.allSettled([selecting]);
		opening.mockRestore();
	}
});

test("requires the rendered managed generation for writes and never reconnects to satisfy a stale control", async () => {
	const h = await fixture();
	const terminal = await h.persist("Generation-owned controls");
	await h.call("project.open", { path: h.projectDir });
	const saved = h.snapshot().sessions.find(item => item.id === terminal.id);
	if (!saved) throw new Error("Missing discovered fixture session");
	let generation = 7;
	let attached = true;
	const opening = vi.spyOn(ManagedSession.prototype, "open").mockResolvedValue(undefined);
	vi.spyOn(ManagedSession.prototype, "refresh").mockResolvedValue(undefined);
	const attachmentDescriptor = Object.getOwnPropertyDescriptor(ManagedSession.prototype, "isAttached");
	const generationDescriptor = Object.getOwnPropertyDescriptor(ManagedSession.prototype, "controlGeneration");
	if (!attachmentDescriptor || !generationDescriptor) throw new Error("Missing attachment fixture properties");
	Object.defineProperties(ManagedSession.prototype, {
		isAttached: { configurable: true, get: () => attached },
		controlGeneration: { configurable: true, get: () => attached ? generation : null },
	});
	cleanups.push(async () => { Object.defineProperties(ManagedSession.prototype, {
		isAttached: attachmentDescriptor, controlGeneration: generationDescriptor,
	}); });
	vi.spyOn(ManagedSession.prototype, "dto").mockImplementation(() => ({ ...saved, controlGeneration: generation }));
	const model = vi.spyOn(ManagedSession.prototype, "setModel").mockResolvedValue(undefined);
	const thinking = vi.spyOn(ManagedSession.prototype, "setThinking").mockResolvedValue(undefined);
	const prompt = vi.spyOn(ManagedSession.prototype, "prompt").mockResolvedValue(undefined);
	const control = vi.spyOn(ManagedSession.prototype, "control").mockResolvedValue(undefined);
	const writes: Array<{ method: DesktopRequest["method"]; input: Record<string, unknown> }> = [
		{ method: "model.set", input: { modelId: "fixture/model" } },
		{ method: "thinking.set", input: { level: "high" } },
		{ method: "prompt", input: { text: "Only the rendered owner may receive this" } },
		{ method: "abort", input: {} },
	];
	// Writes are not permission to create a connection, even with a plausible generation.
	await expect(h.call("model.set", { sessionId: terminal.id, sessionGeneration: generation, modelId: "fixture/model" }))
		.rejects.toThrow("SDK owner changed");
	expect(opening).not.toHaveBeenCalled();
	await h.call("session.select", { sessionId: terminal.id });
	for (const sessionGeneration of [undefined, null, "7", 6, 7.5]) {
		for (const { method, input } of writes) {
			const malformedPrompt = method === "prompt" && sessionGeneration !== undefined && sessionGeneration !== null && (typeof sessionGeneration !== "number" || !Number.isSafeInteger(sessionGeneration));
			await expect(h.call(method, { sessionId: terminal.id, sessionGeneration, ...input })).rejects.toThrow(malformedPrompt ? "Invalid prompt session generation" : "SDK owner changed");
		}
	}
	generation = 8;
	for (const { method, input } of writes)
		await expect(h.call(method, { sessionId: terminal.id, sessionGeneration: 7, ...input })).rejects.toThrow("SDK owner changed");
	expect(model).not.toHaveBeenCalled();
	expect(thinking).not.toHaveBeenCalled();
	expect(prompt).not.toHaveBeenCalled();
	expect(control).not.toHaveBeenCalled();
	for (const { method, input } of writes)
		await h.call(method, { sessionId: terminal.id, sessionGeneration: generation, ...input });
	expect(model).toHaveBeenCalledTimes(1);
	expect(thinking).toHaveBeenCalledTimes(1);
	expect(prompt).toHaveBeenCalledTimes(1);
	expect(control).toHaveBeenCalledTimes(1);
	attached = false;
	for (const { method, input } of writes)
		await expect(h.call(method, { sessionId: terminal.id, sessionGeneration: generation, ...input })).rejects.toThrow("SDK owner changed");
	expect(model).toHaveBeenCalledTimes(1);
	expect(thinking).toHaveBeenCalledTimes(1);
	expect(prompt).toHaveBeenCalledTimes(1);
	expect(control).toHaveBeenCalledTimes(1);
	expect(opening).toHaveBeenCalledTimes(1);
	expect(h.created).toHaveLength(0);
	expect(await Bun.file(terminal.file).text()).toBe(terminal.bytes);
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

test("uses SDK ownership admission rather than a local transcript writer when selecting a discovered session", async () => {
	const h = await fixture();
	const terminal = await h.persist("Still owned by terminal", h.projectDir, true);
	await h.call("project.open", { path: h.projectDir });
	const admission = vi.spyOn(ManagedSession.prototype, "open").mockRejectedValue(new Error("Fixture SDK owner unavailable"));
	await expect(h.call("session.select", { sessionId: terminal.id })).rejects.toThrow("SDK owner unavailable");
	expect(admission).toHaveBeenCalledTimes(1);
	await expect(h.call("session.delete", { sessionId: terminal.id })).rejects.toThrow("does not support desktop session.delete");
	expect(h.created).toHaveLength(0);
	expect(await Bun.file(terminal.file).text()).toBe(terminal.bytes);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([terminal.id]);
});
