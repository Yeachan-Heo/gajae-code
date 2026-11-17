import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai";
import type { Model } from "@gajae-code/ai/core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	captureSessionView,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	getSessionMessageEntryId,
	restoreSessionView,
	type SdkSessionView,
} from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import {
	type DesktopFrame,
	type DesktopHistory,
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

async function fixture(model?: Model) {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-shared-store-")));
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
	const createSession = async (options: CreateAgentSessionOptions) => {
		const result = await createAgentSession({
			...options,
			extensions: [],
			...(model
				? {
						model,
						systemPrompt: ["Test"],
						toolNames: [],
						skills: [],
						rules: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMcpAutoload: false,
						enableLsp: false,
						skipPythonPreflight: true,
						deferOptionalModelRefresh: true,
					}
				: {}),
		});
		if (model) {
			result.session.modelRegistry.authStorage.setRuntimeApiKey(model.provider, "fixture-only");
			result.session.settings.set("compaction.enabled", false);
			result.session.settings.set("retry.enabled", false);
			result.session.settings.set("async.enabled", false);
		}
		created.push(result);
		return result;
	};
	const createHost = () => new DesktopHost({ dataDir, emit: frame => frames.push(frame), createSession });
	let host = createHost();
	await host.initialize();
	cleanups.push(async () => {
		await host.close();
		await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
		for (const manager of managers) await manager.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const frame = frames.findLast(item => item.type === "response" && item.id === id);
		if (frame?.type !== "response") throw new Error(`Missing response for ${method}`);
		if (!frame.ok) throw new Error(frame.error);
		return frame.result as T;
	};
	return {
		call,
		created,
		dataDir,
		agentDir,
		projectDir,
		snapshot: () => host.snapshot(),
		restart: async () => {
			await host.close();
			await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
			host = createHost();
			await host.initialize();
		},
		close: () => host.close(),
		track: (manager: SessionManager) => {
			managers.push(manager);
			return manager;
		},
	};
}

interface SharedCatalog {
	version: 1;
	projects: DesktopProject[];
	sessions: Array<{
		id: string;
		projectId: string;
		title: string;
		starred: boolean;
		file: string;
		scope: "desktop" | "managed";
		sessionId: string;
		createdAt?: number;
		view?: SdkSessionView;
	}>;
}

async function readCatalog(dataDir: string): Promise<SharedCatalog> {
	return Bun.file(path.join(dataDir, "catalog.json")).json();
}

async function controlledFixture(handler?: () => Promise<void>) {
	process.env.GJC_NO_TITLE = "1";
	const api = `desktop-exact-view-${crypto.randomUUID()}`;
	const model = createMockModel({
		provider: "desktop-exact-view-fixture",
		handler: async () => {
			await handler?.();
			return { content: ["controlled answer"] };
		},
	});
	Object.defineProperty(model, "api", { value: api });
	registerCustomApi(api, model.stream, api);
	cleanups.push(async () => unregisterCustomApis(api));
	const h = await fixture(model);
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const session = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const sdk = () => {
		const current = h.created.at(-1)?.session;
		if (!current) throw new Error("Missing real SDK session");
		return current;
	};
	const lastUser = () => {
		const message = sdk().messages.findLast(message => message.role === "user");
		const entryId = message && getSessionMessageEntryId(message);
		if (!entryId) throw new Error("Missing persisted prompt entry");
		return entryId;
	};
	return { ...h, project, session, sdk, model, lastUser };
}

/** The terminal's own resume path, used here as the other surface of the shared store. */
async function resumeAsTerminal(file: string, cwd: string, agentDir: string) {
	return SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
}

test("exact old, revised and continued views survive fresh host and SDK owners without provider calls", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "original prompt" });
	const original = h.lastUser();
	await h.call("prompt", { sessionId, text: "original continuation" });
	const oldView = captureSessionView(h.sdk());
	await h.call("prompt", { sessionId, editEntryId: original, text: "revised prompt" });
	const revised = h.lastUser();
	const revisedView = captureSessionView(h.sdk());
	await h.call("prompt", { sessionId, text: "revised continuation" });
	await h.call("session.rename", { sessionId, title: "Kept title" });
	await h.call("session.star", { sessionId, starred: true });
	const continuedView = captureSessionView(h.sdk());
	const catalogBefore = await readCatalog(h.dataDir);
	const rowBefore = catalogBefore.sessions[0]!;
	const transcript = h.sdk().sessionFile!;
	const bytes = await Bun.file(transcript).text();
	const calls = h.model.calls.length;

	// The old branch is not the last physical branch in the JSONL file.
	await h.call("session.revision", { sessionId, entryId: original });
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(oldView);
	const retired = h.sdk();
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(retired.isDisposed).toBe(true);
	expect(h.sdk()).not.toBe(retired);
	expect(captureSessionView(h.sdk())).toEqual(oldView);
	const oldHistory = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(JSON.stringify(oldHistory.messages)).toContain("original continuation");
	expect(JSON.stringify(oldHistory.messages)).not.toContain("revised prompt");
	expect(h.model.calls).toHaveLength(calls);

	await h.call("session.revision", { sessionId, entryId: revised });
	expect(captureSessionView(h.sdk())).toEqual(continuedView);
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(captureSessionView(h.sdk())).toEqual(continuedView);
	const continuedHistory = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(JSON.stringify(continuedHistory.messages)).toContain("revised continuation");
	expect(JSON.stringify(continuedHistory.messages)).not.toContain("original continuation");
	expect(h.model.calls).toHaveLength(calls);

	// Ordinary app continuation must replace, not keep pinning, the restored cursor.
	await h.call("prompt", { sessionId, text: "new settled continuation" });
	const latest = captureSessionView(h.sdk());
	expect(latest).not.toEqual(continuedView);
	expect(latest).not.toEqual(revisedView);
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(latest);
	const callsAfterContinuation = h.model.calls.length;
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(captureSessionView(h.sdk())).toEqual(latest);
	expect(h.model.calls).toHaveLength(callsAfterContinuation);
	const row = (await readCatalog(h.dataDir)).sessions[0]!;
	expect({ ...row, view: undefined }).toEqual({ ...rowBefore, view: undefined });
	expect(row.id).toBe(sessionId);
	expect(row.sessionId).toBe(oldView.sessionId);
	expect((await Bun.file(transcript).text()).startsWith(bytes)).toBe(true);
	expect(h.snapshot().sessions.map(item => item.id)).toEqual([sessionId]);
});

test("a busy continuation cannot overwrite the saved selection and its settled ACK advances it", async () => {
	let block = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await controlledFixture(async () => {
		if (!block) return;
		entered.resolve();
		await release.promise;
	});
	cleanups.push(async () => release.resolve());
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "selected before pending run" });
	const selected = captureSessionView(h.sdk());
	block = true;
	const pending = h.call("prompt", { sessionId, text: "not settled yet" });
	try {
		await entered.promise;
		expect(h.sdk().isStreaming).toBe(true);
		expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(selected);
		await h.call("session.select", { sessionId });
		expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(selected);
	} finally {
		release.resolve();
		await pending;
	}
	const settled = captureSessionView(h.sdk());
	expect(settled).not.toEqual(selected);
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(settled);
	const calls = h.model.calls.length;
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(captureSessionView(h.sdk())).toEqual(settled);
	expect(h.model.calls).toHaveLength(calls);
});

test("settled public SDK appends are captured during host teardown", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "first app turn" });
	await h.sdk().prompt("settled append before shutdown");
	await h.sdk().waitForIdle();
	const expected = captureSessionView(h.sdk());
	const calls = h.model.calls.length;
	await h.close();
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(expected);
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(captureSessionView(h.sdk())).toEqual(expected);
	expect(h.model.calls).toHaveLength(calls);
});

test("an exact revised answer without a continuation survives recreation", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "before edit" });
	const original = h.lastUser();
	await h.call("prompt", { sessionId, editEntryId: original, text: "after edit" });
	const revised = captureSessionView(h.sdk());
	const bytes = await Bun.file(h.sdk().sessionFile!).text();
	const calls = h.model.calls.length;
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(captureSessionView(h.sdk())).toEqual(revised);
	expect(h.model.calls).toHaveLength(calls);
	expect(await Bun.file(h.sdk().sessionFile!).text()).toBe(bytes);
	const history = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(JSON.stringify(history.messages)).toContain("after edit");
	expect(JSON.stringify(history.messages)).not.toContain("before edit");
});

test("a tracked null root remains exact instead of reopening the latest answer", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "retained but not viewed" });
	const root = { sessionId: h.sdk().sessionId, leafEntryId: null };
	await restoreSessionView(h.sdk(), root);
	await h.call("session.star", { sessionId, starred: true });
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(root);
	const bytes = await Bun.file(h.sdk().sessionFile!).text();
	const calls = h.model.calls.length;
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(captureSessionView(h.sdk())).toEqual(root);
	expect(await h.call<DesktopHistory>("history.get", { sessionId })).toMatchObject({ total: 0 });
	expect(await Bun.file(h.sdk().sessionFile!).text()).toBe(bytes);
	expect(h.model.calls).toHaveLength(calls);
});

test("missing and foreign exact-view targets fail without publishing latest or changing saved intent", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "first transcript" });
	const firstSdk = h.sdk();
	const firstView = captureSessionView(firstSdk);
	const other = await h.call<DesktopSession>("session.create", { projectId: h.project.id });
	await h.call("prompt", { sessionId: other.id, text: "foreign transcript" });
	const foreign = captureSessionView(h.sdk());
	await h.close();
	const catalog = await readCatalog(h.dataDir);
	const row = catalog.sessions.find(item => item.id === sessionId)!;
	const transcript = firstSdk.sessionFile!;
	const bytes = await Bun.file(transcript).text();
	const calls = h.model.calls.length;
	for (const leafEntryId of ["missing-entry", foreign.leafEntryId]) {
		row.view = { ...firstView, leafEntryId };
		await Bun.write(path.join(h.dataDir, "catalog.json"), JSON.stringify(catalog));
		await h.restart();
		await expect(h.call("session.select", { sessionId })).rejects.toThrow();
		const failed = h.created.at(-1)!.session;
		await failed.awaitDisposeCompletion();
		expect(failed.isDisposed).toBe(true);
		expect((await readCatalog(h.dataDir)).sessions.find(item => item.id === sessionId)?.view).toEqual(row.view);
		expect(h.snapshot().sessions.find(item => item.id === sessionId)?.messages).toEqual([]);
		expect(await Bun.file(transcript).text()).toBe(bytes);
		expect(h.model.calls).toHaveLength(calls);
		await h.close();
	}
});

test("persisted view shape and catalog or actual SDK identity mismatches are rejected", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "identity stays exact" });
	await h.close();
	const catalog = await readCatalog(h.dataDir);
	const row = catalog.sessions[0]!;
	const saved = row.view!;
	const calls = h.model.calls.length;
	for (const view of [
		{ sessionId: saved.sessionId },
		{ ...saved, leafEntryId: 17 },
		{ ...saved, authority: true },
		{ ...saved, sessionId: crypto.randomUUID() },
	]) {
		await Bun.write(path.join(h.dataDir, "catalog.json"), JSON.stringify({ ...catalog, sessions: [{ ...row, view }] }));
		await expect(h.restart()).rejects.toThrow();
		const persisted = await Bun.file(path.join(h.dataDir, "catalog.json")).json();
		expect(persisted.sessions[0].view).toEqual(view);
	}
	// Matching catalog strings still cannot authorize a foreign actual SDK identity.
	const forgedId = crypto.randomUUID();
	const forged = { ...row, sessionId: forgedId, view: { ...saved, sessionId: forgedId } };
	await Bun.write(path.join(h.dataDir, "catalog.json"), JSON.stringify({ ...catalog, sessions: [forged] }));
	await h.restart();
	await expect(h.call("session.select", { sessionId })).rejects.toThrow();
	expect((await readCatalog(h.dataDir)).sessions[0]).toEqual(forged);
	expect(h.model.calls).toHaveLength(calls);
});

test("a new conversation is stored where the terminal reads it, not in a private directory", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const session = await h.call<DesktopSession>("session.create", { projectId: project.id });

	const catalog: { sessions: Array<{ id: string; file?: string; scope?: string; sessionId?: string }> } =
		await Bun.file(path.join(h.dataDir, "catalog.json")).json();
	const entry = catalog.sessions.find(item => item.id === session.id);
	if (!entry?.file) throw new Error("Catalog entry has no transcript reference");
	expect(entry.scope).toBe("managed");
	const transcript = path.join(h.agentDir, "sessions", entry.file);
	expect(await Bun.file(transcript).exists()).toBe(true);
	// The private transcript root stays empty: one conversation, one file.
	const privateFiles = await fs
		.readdir(path.join(h.dataDir, "sessions"), { recursive: true })
		.catch(() => [] as string[]);
	expect(privateFiles.filter(file => String(file).endsWith(".jsonl"))).toEqual([]);
	expect(await h.call<DesktopHistory>("history.get", { sessionId: session.id })).toMatchObject({ total: 0 });
	// The terminal's own read-only picker inventory now lists this conversation.
	if (!entry.sessionId) throw new Error("Catalog entry did not record its SDK transcript identity");
	const inventory = await SessionManager.listManagedForResumePickerReadOnly(h.projectDir, h.agentDir);
	expect(inventory.filter(item => item.id === entry.sessionId)).toHaveLength(1);
});

test("deleting a shared conversation removes the transcript the terminal would resume", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const session = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const catalog: { sessions: Array<{ id: string; file: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	const transcript = path.join(h.agentDir, "sessions", catalog.sessions[0]!.file);
	expect(await Bun.file(transcript).exists()).toBe(true);
	await h.call("session.delete", { sessionId: session.id });
	expect(await Bun.file(transcript).exists()).toBe(false);
	expect(await SessionManager.listManagedForResumePickerReadOnly(h.projectDir, h.agentDir)).toEqual([]);
	expect(h.snapshot().sessions).toEqual([]);
});

test("the terminal continues an app conversation and the app reopens that continuation", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const session = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const catalog: { sessions: Array<{ id: string; file: string; sessionId?: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	const entry = catalog.sessions[0]!;
	const transcript = path.join(h.agentDir, "sessions", entry.file);
	// The catalog identity is the desktop's own; the transcript identity is the SDK's.
	const appSessionId = entry.sessionId;
	if (!appSessionId) throw new Error("Catalog entry did not record its SDK transcript identity");

	// Empty app sessions must not save a null cursor that would hide the terminal's first turn.
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toBeUndefined();
	// Stop the desktop owner before another surface writes, exactly as the user does.
	await h.call("project.close", { projectId: project.id });
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toBeUndefined();
	const terminal = h.track(await resumeAsTerminal(transcript, h.projectDir, h.agentDir));
	expect(terminal.getSessionId()).toBe(appSessionId);
	terminal.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continued in the terminal" }],
		timestamp: Date.now(),
	});
	await terminal.flush();
	expect(await terminal.closeStrict()).toMatchObject({ kind: "closed" });
	await h.restart();

	const reopened = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	expect(reopened.id).toBe(project.id);
	expect(h.snapshot().sessions.map(item => item.id)).toEqual([session.id]);
	await h.call("session.select", { sessionId: session.id });
	const after: { sessions: Array<{ id: string; sessionId?: string; file?: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	// The continuation kept both identities: desktop catalog id and SDK transcript id.
	expect(after.sessions.find(item => item.id === session.id)?.sessionId).toBe(appSessionId);
	const history = await h.call<DesktopHistory>("history.get", { sessionId: session.id });
	expect(JSON.stringify(history.messages)).toContain("continued in the terminal");
});

test("a fork of a shared conversation lands in the same store and keeps its source", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const source = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const catalog: { sessions: Array<{ id: string; file: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	const sourceTranscript = path.join(h.agentDir, "sessions", catalog.sessions[0]!.file);
	const sourceBytes = await Bun.file(sourceTranscript).text();
	const fork = await h.call<{ cancelled: boolean; session: DesktopSession }>("session.fork", {
		sessionId: source.id,
	});

	const after: { sessions: Array<{ id: string; file?: string; scope?: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	expect(after.sessions).toHaveLength(2);
	for (const entry of after.sessions) {
		expect(entry.scope).toBe("managed");
		if (!entry.file) throw new Error("Fork catalog entry has no transcript reference");
		expect(await Bun.file(path.join(h.agentDir, "sessions", entry.file)).exists()).toBe(true);
	}
	expect(fork.cancelled).toBe(false);
	expect(fork.session.id).not.toBe(source.id);
	expect(h.snapshot().sessions.map(item => item.id)).toEqual([source.id, fork.session.id]);
	expect(await Bun.file(sourceTranscript).text()).toBe(sourceBytes);
});

test("an existing private transcript keeps opening in place after the store change", async () => {
	const h = await fixture();
	const privateDirectory = path.join(h.dataDir, "sessions");
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const legacy = SessionManager.create(
		h.projectDir,
		SessionManager.explicitDestination(path.join(privateDirectory, project.id)),
	);
	h.track(legacy);
	legacy.appendMessage({
		role: "user",
		content: [{ type: "text", text: "written before the store change" }],
		timestamp: Date.now(),
	});
	await legacy.ensureOnDisk();
	await legacy.flush();
	const legacyFile = legacy.getSessionFile();
	if (!legacyFile) throw new Error("Legacy transcript was not persisted");
	await legacy.closeStrict();
	const legacyId = crypto.randomUUID();
	await Bun.write(
		path.join(h.dataDir, "catalog.json"),
		JSON.stringify({
			version: 1,
			projects: [{ id: project.id, name: "project", path: h.projectDir }],
			sessions: [
				{
					id: legacyId,
					projectId: project.id,
					title: "Legacy conversation",
					starred: false,
					file: path.relative(privateDirectory, legacyFile),
				},
			],
		}),
	);
	await h.restart();
	await h.call("project.open", { path: h.projectDir });
	await h.call("session.select", { sessionId: legacyId });
	const history = await h.call<DesktopHistory>("history.get", { sessionId: legacyId });
	expect(JSON.stringify(history.messages)).toContain("written before the store change");
	expect(await Bun.file(legacyFile).exists()).toBe(true);
});

test("a creation interrupted before its transcript was recorded still loads", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	// A crash between the catalog write and the transcript commit leaves this row behind.
	await Bun.write(
		path.join(h.dataDir, "catalog.json"),
		JSON.stringify({
			version: 1,
			projects: [{ id: project.id, name: "project", path: h.projectDir }],
			sessions: [
				{ id: crypto.randomUUID(), projectId: project.id, title: "Interrupted", starred: false, scope: "managed" },
			],
		}),
	);
	await h.restart();
	const reopened = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	expect(reopened.id).toBe(project.id);
	const created = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const after: { sessions: Array<{ id: string; scope?: string; file?: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	expect(after.sessions.find(item => item.id !== created.id)?.scope).toBeUndefined();
	expect(after.sessions.find(item => item.id === created.id)?.scope).toBe("managed");
});

test("a row whose transcript another surface removed can still be deleted", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const session = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const catalog: { sessions: Array<{ id: string; file: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	const transcript = path.join(h.agentDir, "sessions", catalog.sessions[0]!.file);
	await h.call("project.close", { projectId: project.id });
	// The terminal deletes the conversation while the app still holds its row.
	await SessionManager.deleteManagedCandidate(transcript);
	await h.call("project.open", { path: h.projectDir });
	await h.call("session.delete", { sessionId: session.id });
	expect(h.snapshot().sessions).toEqual([]);
	const after: { sessions: unknown[] } = await Bun.file(path.join(h.dataDir, "catalog.json")).json();
	expect(after.sessions).toEqual([]);
});

test("deleting an unopened missing transcript forgets the row without inferring artifact cleanup", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const session = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const manager = h.created[0]!.session.sessionManager;
	const transcript = manager.getSessionFile();
	const artifacts = manager.getArtifactsDir();
	if (!transcript || !artifacts) throw new Error("Expected managed transcript and artifact scope");
	const retained = path.join(artifacts, "retained-output.txt");
	await Bun.write(retained, "owned derived artifact");
	await h.restart();
	await fs.rm(transcript);
	expect(await Bun.file(retained).exists()).toBe(true);
	await h.call("session.delete", { sessionId: session.id });
	// Missing transcript bytes are not deletion authority: the SDK-owned artifacts stay.
	expect(await Bun.file(retained).text()).toBe("owned derived artifact");
	expect(h.snapshot().sessions).toEqual([]);
	const after: { sessions: unknown[] } = await Bun.file(path.join(h.dataDir, "catalog.json")).json();
	expect(after.sessions).toEqual([]);
});

test("deleting a live conversation whose transcript vanished disposes the session it still owns", async () => {
	const h = await fixture();
	const project = await h.call<DesktopProject>("project.open", { path: h.projectDir });
	const session = await h.call<DesktopSession>("session.create", { projectId: project.id });
	const catalog: { sessions: Array<{ id: string; file: string }> } = await Bun.file(
		path.join(h.dataDir, "catalog.json"),
	).json();
	const transcript = path.join(h.agentDir, "sessions", catalog.sessions[0]!.file);
	const owned = h.created[0]!.session;
	expect(owned.isDisposed).toBe(false);
	// Another surface removes the file while this host still owns the live session.
	await fs.rm(transcript);
	await h.call("session.delete", { sessionId: session.id });
	await owned.awaitDisposeCompletion();
	expect(owned.isDisposed).toBe(true);
	expect(h.snapshot().sessions).toEqual([]);
	// The owned SDK session is gone, so its catalog id is no longer addressable.
	await expect(h.call("history.get", { sessionId: session.id })).rejects.toThrow("Session not found");
});
