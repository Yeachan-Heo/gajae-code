import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import * as sdk from "@gajae-code/coding-agent/sdk";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	captureSessionView,
	createAgentSession,
	getSessionMessageEntryId,
	restoreSessionView,
	type SdkSessionView,
} from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import {
	type DesktopDisconnectResult,
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
	let openHold: { entered: () => void; release: Promise<void> } | undefined;
	const createSession = async (options: CreateAgentSessionOptions) => {
		const hold = openHold;
		openHold = undefined;
		if (hold) {
			hold.entered();
			await hold.release;
		}
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
	// The broker's live-owner answer: transcript ids a terminal holds open, or a broker that fails.
	const liveOwners = new Set<string>();
	let brokerFails = false;
	let brokerHold: Promise<void> | undefined;
	const ownerLookups: string[] = [];
	const liveOwnerClient = {
		global: async (_operation: string, input: Record<string, unknown>) => {
			ownerLookups.push(String(input.resolveSessionId));
			// A hold applies to the next lookup only; later lookups answer at once.
			const hold = brokerHold;
			brokerHold = undefined;
			await hold;
			if (brokerFails) throw new Error("broker connection refused");
			return {
				ok: true,
				result: {
					indexSeq: 1,
					sessions: [...liveOwners].map(sessionId => ({ sessionId, live: true })),
					warnings: [],
				},
			};
		},
	};
	const createHost = () =>
		new DesktopHost({ dataDir, emit: frame => frames.push(frame), createSession, liveOwnerClient });
	let host = createHost();
	await host.initialize();
	cleanups.push(async () => {
		await host.close();
		await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
		for (const manager of managers) await manager.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = async <T>(
		method: DesktopRequest["method"],
		params: Record<string, unknown> = {},
		id: string = crypto.randomUUID(),
	): Promise<T> => {
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
		frames,
		/** Waits for the workspace refresh a bootstrap started in the background. */
		refreshed: () => host.workspacesRefreshed(),
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
		liveOwners,
		ownerLookups,
		failBroker: (fails: boolean) => {
			brokerFails = fails;
		},
		/** Holds the next SDK session the Host opens until `release` is called. */
		holdOpen: () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			openHold = { entered: () => entered.resolve(), release: release.promise };
			return { entered: entered.promise, release: () => release.resolve() };
		},
		/** Holds the next broker answer until the returned release is called; it reads the owners then. */
		holdBroker: () => {
			const held = Promise.withResolvers<void>();
			brokerHold = held.promise;
			return () => held.resolve();
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
		viewTail?: string | null;
		disconnected?: true;
	}>;
}

async function readCatalog(dataDir: string): Promise<SharedCatalog> {
	return Bun.file(path.join(dataDir, "catalog.json")).json();
}

async function controlledFixture(handler?: (signal?: AbortSignal) => Promise<void>) {
	process.env.GJC_NO_TITLE = "1";
	const api = `desktop-exact-view-${crypto.randomUUID()}`;
	const model = createMockModel({
		provider: "desktop-exact-view-fixture",
		handler: async (_context, options) => {
			await handler?.(options?.signal);
			// A call stopped while held ends as aborted, as a provider would.
			return { content: ["controlled answer"], ...(options?.signal?.aborted ? { delayMs: 1 } : {}) };
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

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 1_000 && !check(); i++) await Bun.sleep(5);
	if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

/** The terminal's own resume path, used here as the other surface of the shared store. */
async function resumeAsTerminal(file: string, cwd: string, agentDir: string) {
	return SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
}

/** One complete turn written by the terminal: its prompt and a finished answer. */
async function continueInTerminal(
	file: string,
	cwd: string,
	agentDir: string,
	track: (manager: SessionManager) => SessionManager,
) {
	const terminal = track(await resumeAsTerminal(file, cwd, agentDir));
	const prompt = terminal.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continued in the terminal" }],
		timestamp: Date.now(),
	});
	const answer: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "answered in the terminal" }],
		api: "openai-completions",
		provider: "terminal-fixture",
		model: "terminal-model",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const tail = terminal.appendMessage(answer);
	await terminal.flush();
	expect(await terminal.closeStrict()).toMatchObject({ kind: "closed" });
	return { prompt, tail };
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
	expect({ ...row, view: undefined, viewTail: undefined }).toEqual({
		...rowBefore,
		view: undefined,
		viewTail: undefined,
	});
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
		await Bun.write(
			path.join(h.dataDir, "catalog.json"),
			JSON.stringify({ ...catalog, sessions: [{ ...row, view }] }),
		);
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

test("a saved view does not hide turns the terminal appended after it", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const saved = captureSessionView(h.sdk());
	const transcript = h.sdk().sessionFile!;
	await h.call("project.close", { projectId: h.project.id });
	expect((await readCatalog(h.dataDir)).sessions[0]?.view).toEqual(saved);
	const { tail } = await continueInTerminal(transcript, h.projectDir, h.agentDir, h.track);
	const calls = h.model.calls.length;
	await h.restart();
	await h.call("project.open", { path: h.projectDir });
	await h.call("session.select", { sessionId });
	// The reopened conversation lands where the terminal left it, not on the older saved cursor.
	expect(captureSessionView(h.sdk())).toEqual({ sessionId: saved.sessionId, leafEntryId: tail });
	const history = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(history.messages.map(message => message.text)).toEqual([
		"app turn",
		"controlled answer",
		"continued in the terminal",
		"answered in the terminal",
	]);
	expect(h.model.calls).toHaveLength(calls);
	// The next app prompt continues the terminal's turn instead of branching beside it.
	await h.call("prompt", { sessionId, text: "app continues" });
	// SDK bookkeeping may sit between them; the terminal's answer is still the prompt's ancestor.
	expect(
		h
			.sdk()
			.sessionManager.getBranch(h.lastUser())
			.map(entry => entry.id),
	).toContain(tail);
	const continued = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(continued.messages.map(message => message.text)).toEqual([
		"app turn",
		"controlled answer",
		"continued in the terminal",
		"answered in the terminal",
		"app continues",
		"controlled answer",
	]);
});

/** Turns a saved row into one written before tails were recorded: the view stays, its tail goes. */
async function forgetRecordedTail(h: { dataDir: string }, view?: SdkSessionView) {
	const catalog = await readCatalog(h.dataDir);
	delete catalog.sessions[0]!.viewTail;
	if (view) catalog.sessions[0]!.view = view;
	await Bun.write(path.join(h.dataDir, "catalog.json"), JSON.stringify(catalog));
}

test("a row saved before tails were recorded opens at a continuation appended after its position", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const saved = captureSessionView(h.sdk());
	const transcript = h.sdk().sessionFile!;
	await h.close();
	await forgetRecordedTail(h);
	const { tail } = await continueInTerminal(transcript, h.projectDir, h.agentDir, h.track);
	await h.restart();
	await h.call("session.select", { sessionId });
	// The saved position was the end of the transcript then; the terminal's turn came after it.
	expect(captureSessionView(h.sdk())).toEqual({ sessionId: saved.sessionId, leafEntryId: tail });
	const history = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(history.messages.map(message => message.text)).toContain("continued in the terminal");
	// The next save records where the conversation now is, never the stale position.
	await h.close();
	const row = (await readCatalog(h.dataDir)).sessions[0];
	expect(row?.view).toEqual({ sessionId: saved.sessionId, leafEntryId: tail });
	expect(row?.viewTail).toBe(tail);
});

test("a row saved before tails were recorded keeps an older revision the user chose", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "original prompt" });
	const original = h.lastUser();
	await h.call("prompt", { sessionId, editEntryId: original, text: "revised prompt" });
	// The user went back to the original revision; the newest entry is on the revised branch.
	await h.call("session.revision", { sessionId, entryId: original });
	const older = captureSessionView(h.sdk());
	await h.close();
	await forgetRecordedTail(h);
	await h.restart();
	await h.call("session.select", { sessionId });
	expect(captureSessionView(h.sdk())).toEqual(older);
	const history = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(JSON.stringify(history.messages)).toContain("original prompt");
	expect(JSON.stringify(history.messages)).not.toContain("revised prompt");
});

test("a row saved before tails were recorded at the empty root opens at the newest entry", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const shown = captureSessionView(h.sdk());
	await h.close();
	await forgetRecordedTail(h, { sessionId: shown.sessionId, leafEntryId: null });
	await h.restart();
	await h.call("session.select", { sessionId });
	// The empty root is an ancestor of every entry, so the turns after it are shown.
	expect(captureSessionView(h.sdk())).toEqual(shown);
});

test("a released row saved before tails were recorded shows the terminal's continuation read-only", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const transcript = h.sdk().sessionFile!;
	await h.call("session.disconnect", { sessionId });
	await h.close();
	await forgetRecordedTail(h);
	await continueInTerminal(transcript, h.projectDir, h.agentDir, h.track);
	await h.restart();
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	expect(selected.connection).toEqual({ state: "disconnected" });
	expect(selected.messages.map(message => message.text)).toContain("continued in the terminal");
});

test("a recorded tail needs a saved view and an entry id", async () => {
	const h = await controlledFixture();
	await h.call("prompt", { sessionId: h.session.id, text: "app turn" });
	await h.close();
	const catalog = await readCatalog(h.dataDir);
	const row = catalog.sessions[0]!;
	expect(typeof row.viewTail).toBe("string");
	for (const invalid of [
		{ ...row, viewTail: 17 },
		{ ...row, view: undefined },
	]) {
		await Bun.write(path.join(h.dataDir, "catalog.json"), JSON.stringify({ ...catalog, sessions: [invalid] }));
		await expect(h.restart()).rejects.toThrow("Invalid saved session view");
	}
});

test("Done means a turn ended in this app run; opening, selecting or renaming never changes status", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	const status = () => h.snapshot().sessions.find(session => session.id === sessionId)?.status;
	expect(status()).toBe("idle");
	await h.call("prompt", { sessionId, text: "a turn in this run" });
	expect(status()).toBe("done");
	// Closing the workspace unloads the conversation; what happened in this run still holds.
	await h.call("project.close", { projectId: h.project.id });
	await h.call("project.open", { path: h.projectDir });
	expect(status()).toBe("done");
	await h.call("session.select", { sessionId });
	expect(status()).toBe("done");
	await h.restart();
	expect(status()).toBe("idle");
	// A conversation with history is still idle when it is merely loaded.
	await h.call("session.select", { sessionId });
	expect(status()).toBe("idle");
	await h.call("session.rename", { sessionId, title: "Renamed after restart" });
	expect(status()).toBe("idle");
	await h.call("session.select", { sessionId });
	expect(status()).toBe("idle");
});

const sideBySide = ["app turn", "controlled answer", "continued in the terminal", "answered in the terminal"] as const;

test("an open conversation the terminal continued reloads before the next prompt, which continues it", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const stale = h.sdk();
	const { tail } = await continueInTerminal(stale.sessionFile!, h.projectDir, h.agentDir, h.track);
	const calls = h.model.calls.length;
	await h.call("prompt", { sessionId, text: "after the terminal" });
	await stale.awaitDisposeCompletion();
	expect(stale.isDisposed).toBe(true);
	expect(h.model.calls).toHaveLength(calls + 1);
	expect(
		h
			.sdk()
			.sessionManager.getBranch(h.lastUser())
			.map(entry => entry.id),
	).toContain(tail);
	const history = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(history.messages.map(message => message.text)).toEqual([
		...sideBySide,
		"after the terminal",
		"controlled answer",
	]);
	await h.call("prompt", { sessionId, text: "and again" });
	expect(h.model.calls).toHaveLength(calls + 2);
	expect(h.snapshot().deliveries.every(receipt => receipt.disposition === "completed")).toBe(true);
	expect(h.snapshot().sessions[0]?.error).toBeUndefined();
	await h.close();
});

test("selecting an open conversation the terminal continued shows the terminal's turns", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const stale = h.sdk();
	await continueInTerminal(stale.sessionFile!, h.projectDir, h.agentDir, h.track);
	await h.call("session.select", { sessionId });
	expect(h.sdk()).not.toBe(stale);
	expect(h.snapshot().sessions[0]?.messages.map(message => message.text)).toEqual([...sideBySide]);
	await h.close();
});

test("concurrent requests after another process appended share one reopened copy", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const stale = h.sdk();
	await continueInTerminal(stale.sessionFile!, h.projectDir, h.agentDir, h.track);
	const opened = h.created.length;
	const selections = await Promise.all([
		h.call<DesktopSession>("session.select", { sessionId }),
		h.call<DesktopSession>("session.select", { sessionId }),
	]);
	// Both answer from the reopened copy, never from the retired one or a half-open row.
	for (const selected of selections) expect(selected.messages.map(message => message.text)).toEqual([...sideBySide]);
	expect(h.created).toHaveLength(opened + 1);
	expect(h.sdk()).not.toBe(stale);
	await h.call("prompt", { sessionId, text: "on the reopened copy" });
	expect(h.created).toHaveLength(opened + 1);
	expect(
		h
			.snapshot()
			.sessions[0]?.messages.map(message => message.text)
			.slice(0, 4),
	).toEqual([...sideBySide]);
	await h.close();
});

test("a write the store still refuses returns the text, reloads and says what happened in plain words", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const stale = h.sdk();
	await continueInTerminal(stale.sessionFile!, h.projectDir, h.agentDir, h.track);
	// The other process wins the race: it appends after the app's check, before the app's write.
	const read = sdk.readEmbeddedTranscriptTail;
	const unmoved = vi.spyOn(sdk, "readEmbeddedTranscriptTail").mockImplementation(async session => {
		const tail = await read(session);
		return tail && { committed: tail.held, held: tail.held };
	});
	const calls = h.model.calls.length;
	try {
		await expect(h.call("prompt", { sessionId, text: "stale write" })).rejects.toThrow("changed in another window");
	} finally {
		unmoved.mockRestore();
	}
	// Nothing reached the provider, so the app restores the text instead of guessing.
	expect(h.model.calls).toHaveLength(calls);
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "refused" });
	expect(h.sdk()).not.toBe(stale);
	expect(h.snapshot().sessions[0]?.messages.map(message => message.text)).toEqual([...sideBySide]);
	await h.call("prompt", { sessionId, text: "sent again" });
	expect(h.model.calls).toHaveLength(calls + 1);
	await h.close();
});

test("a running turn is never reloaded under it; the stale copy is replaced once the turn settles", async () => {
	let hold = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await controlledFixture(async () => {
		if (!hold) return;
		entered.resolve();
		await release.promise;
	});
	cleanups.push(async () => release.resolve());
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	hold = true;
	const running = h.call("prompt", { sessionId, text: "held turn" });
	void running.catch(() => {});
	await entered.promise;
	const live = h.sdk();
	await continueInTerminal(live.sessionFile!, h.projectDir, h.agentDir, h.track);
	await h.call("session.select", { sessionId });
	expect(h.sdk()).toBe(live);
	release.resolve();
	await expect(running).rejects.toThrow("changed in another window");
	// The provider was already asked, so the outcome stays uncertain rather than refused.
	expect(h.snapshot().deliveries.at(-1)?.disposition).not.toBe("refused");
	expect(h.sdk()).not.toBe(live);
	const texts = h.snapshot().sessions[0]?.messages.map(message => message.text);
	expect(texts).toContain("held turn");
	expect(texts?.slice(-2)).toEqual(["continued in the terminal", "answered in the terminal"]);
	await h.close();
});

test("a refused write whose reload cannot reopen says so, and selecting again retries", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const stale = h.sdk();
	await continueInTerminal(stale.sessionFile!, h.projectDir, h.agentDir, h.track);
	const read = sdk.readEmbeddedTranscriptTail;
	const unmoved = vi.spyOn(sdk, "readEmbeddedTranscriptTail").mockImplementation(async session => {
		const tail = await read(session);
		return tail && { committed: tail.held, held: tail.held };
	});
	const reopen = vi.spyOn(sdk, "createEmbeddedAgentSession").mockRejectedValueOnce(new Error("reopen refused"));
	let message = "";
	try {
		await h.call("prompt", { sessionId, text: "stale write" }).catch((error: Error) => {
			message = error.message;
		});
	} finally {
		unmoved.mockRestore();
		reopen.mockRestore();
	}
	expect(message).toContain("changed in another window");
	expect(message).toContain("could not reload it");
	expect(message).not.toContain("reloaded it");
	// The receipt never claims a reload either; it only says why the text came back.
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "refused" });
	expect(h.snapshot().deliveries.at(-1)?.error).not.toContain("reload");
	await h.call("session.select", { sessionId });
	expect(h.sdk()).not.toBe(stale);
	expect(h.snapshot().sessions[0]?.messages.map(message => message.text)).toEqual([...sideBySide]);
	await h.close();
});

test("a reload that cannot reopen still shows the conversation, and selecting again retries", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const stale = h.sdk();
	const file = stale.sessionFile!;
	const before = await Bun.file(file).text();
	// A newer terminal appended an entry this build cannot open (a writer refuses the file), though
	// the conversation in it can still be read.
	const tail = h.sdk().sessionManager.getEntries().at(-1)!.id;
	await fs.appendFile(
		file,
		`${JSON.stringify({ type: "future_entry_kind", id: "0f0f0f0f", parentId: tail, timestamp: new Date().toISOString() })}\n`,
	);
	await expect(h.call("session.select", { sessionId })).rejects.toThrow();
	await stale.awaitDisposeCompletion();
	// The transcript stays on screen, read from the file, rather than an empty conversation.
	expect(h.snapshot().sessions[0]?.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	// Once the file can be opened again, selecting reopens a writer.
	await Bun.write(file, before);
	const reopened = await h.call<DesktopSession>("session.select", { sessionId });
	expect(h.sdk()).not.toBe(stale);
	expect(reopened.connection).toEqual({ state: "connected" });
	expect(reopened.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	await h.call("prompt", { sessionId, text: "after the retry" });
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "completed" });
	await h.close();
});

test("a refused write hands back queued input it can never send, then reloads", async () => {
	let hold = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await controlledFixture(async () => {
		if (!hold) return;
		hold = false;
		entered.resolve();
		await release.promise;
	});
	cleanups.push(async () => release.resolve());
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	hold = true;
	const running = h.call("prompt", { sessionId, text: "held turn" });
	void running.catch(() => {});
	await entered.promise;
	const live = h.sdk();
	await continueInTerminal(live.sessionFile!, h.projectDir, h.agentDir, h.track);
	await h.call("prompt", { sessionId, text: "queued behind", deliverAs: "followUp" });
	const queued = h.snapshot().deliveries.at(-1)!;
	expect(queued.disposition).toBe("queued");
	release.resolve();
	let message = "";
	await running.catch((error: Error) => {
		message = error.message;
	});
	expect(message).toContain("changed in another window");
	expect(message).toContain("reloaded it");
	// The refused copy could never write the queued message; `refused` returns it to the composer.
	expect(h.snapshot().deliveries.find(receipt => receipt.id === queued.id)?.disposition).toBe("refused");
	expect(h.sdk()).not.toBe(live);
	expect(h.snapshot().sessions[0]?.queued).toBeUndefined();
	expect(
		h
			.snapshot()
			.sessions[0]?.messages.map(message => message.text)
			.slice(-2),
	).toEqual(["continued in the terminal", "answered in the terminal"]);
	await h.close();
});

test("deleting a conversation removes its delivery receipts, including after a restart", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const receipt = h.snapshot().deliveries.find(item => item.sessionId === sessionId);
	expect(receipt?.disposition).toBe("completed");
	await h.call("session.delete", { sessionId });
	expect(h.snapshot().deliveries.filter(item => item.sessionId === sessionId)).toEqual([]);
	const published = h.frames.findLast(frame => frame.type === "snapshot");
	expect(
		published?.type === "snapshot" && published.snapshot.deliveries.some(item => item.sessionId === sessionId),
	).toBe(false);
	// The app may still acknowledge the record it held for that conversation.
	await h.call("delivery.ack", { deliveryId: receipt!.id });
	await h.restart();
	expect(h.snapshot().deliveries.filter(item => item.sessionId === sessionId)).toEqual([]);
});

/** Holds the next provider call until released or stopped. */
function heldTurn() {
	let hold = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const handler = async (signal?: AbortSignal) => {
		if (!hold) return;
		hold = false;
		entered.resolve();
		const stopped = Promise.withResolvers<void>();
		signal?.addEventListener("abort", () => stopped.resolve(), { once: true });
		await Promise.race([release.promise, stopped.promise]);
	};
	return { arm: () => (hold = true), entered: entered.promise, release: () => release.resolve(), handler };
}

test("Disconnect releases the app's writer without deleting; Connect reopens at the terminal's tail", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const live = h.sdk();
	const file = live.sessionFile!;
	const result = await h.call<DesktopDisconnectResult>("session.disconnect", { sessionId });
	expect(result.disconnected).toBe(true);
	expect(result.disconnected && result.session.connection).toEqual({ state: "disconnected" });
	await live.awaitDisposeCompletion();
	expect(live.isDisposed).toBe(true);
	expect(await Bun.file(file).exists()).toBe(true);
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([sessionId]);
	// History comes from the transcript; no read opens a writer.
	const opened = h.created.length;
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	expect(selected.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	expect(selected.controlGeneration).toBeNull();
	const page = await h.call<DesktopHistory>("history.get", { sessionId });
	expect(page.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	await h.call("activity.get", { sessionId });
	await h.call("settings.get", { sessionId });
	expect(h.created).toHaveLength(opened);
	// A prompt is refused before anything reaches the provider; its text returns to the composer.
	const calls = h.model.calls.length;
	await expect(h.call("prompt", { sessionId, text: "while disconnected" })).rejects.toThrow("Connect");
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "refused" });
	await expect(h.call("session.rename", { sessionId, title: "renamed" })).rejects.toThrow("Connect");
	expect(h.model.calls).toHaveLength(calls);
	// The terminal continues; selecting again shows its turns, still read-only.
	const { tail } = await continueInTerminal(file, h.projectDir, h.agentDir, h.track);
	const reread = await h.call<DesktopSession>("session.select", { sessionId });
	expect(reread.messages.map(message => message.text)).toEqual([...sideBySide]);
	expect(h.created).toHaveLength(opened);
	// Connect reopens through the normal path, at the terminal's tail.
	const connected = await h.call<DesktopSession>("session.connect", { sessionId });
	expect(connected.connection).toEqual({ state: "connected" });
	expect(h.created).toHaveLength(opened + 1);
	expect(captureSessionView(h.sdk()).leafEntryId).toBe(tail);
	await h.call("prompt", { sessionId, text: "back in the app" });
	expect(h.model.calls).toHaveLength(calls + 1);
	expect(
		h
			.sdk()
			.sessionManager.getBranch(h.lastUser())
			.map(entry => entry.id),
	).toContain(tail);
	await h.close();
});

test("a disconnected conversation stays disconnected across a restart and opens no writer", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	await h.call("session.disconnect", { sessionId });
	expect((await readCatalog(h.dataDir)).sessions[0]).toMatchObject({ disconnected: true });
	await h.restart();
	const opened = h.created.length;
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "disconnected" });
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	expect(selected.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	expect(h.created).toHaveLength(opened);
	await h.call("session.connect", { sessionId });
	expect((await readCatalog(h.dataDir)).sessions[0]).not.toHaveProperty("disconnected");
	await h.restart();
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "connected" });
});

test("Disconnect during a turn asks first, then stops it like Stop before releasing the writer", async () => {
	const held = heldTurn();
	const h = await controlledFixture(held.handler);
	cleanups.push(async () => held.release());
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	held.arm();
	const running = h.call("prompt", { sessionId, text: "held turn" });
	void running.catch(() => {});
	await held.entered;
	await h.call("prompt", { sessionId, text: "queued behind", deliverAs: "followUp" });
	const live = h.sdk();
	const asked = await h.call<DesktopDisconnectResult>("session.disconnect", { sessionId });
	expect(asked).toEqual({ disconnected: false, confirm: { running: true, queued: 1 } });
	expect(live.isDisposed).toBe(false);
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "connected" });
	const confirmed = await h.call<DesktopDisconnectResult>("session.disconnect", { sessionId, confirm: true });
	expect(confirmed.disconnected).toBe(true);
	await running;
	// The stopped prompt and the queued follow-up end exactly as a user Stop leaves them: the
	// prompt that ran is cancelled, and the follow-up that never ran is handed back to the composer.
	const [held_, queued] = h.snapshot().deliveries.slice(-2);
	expect(held_?.disposition).toBe("cancelled");
	expect(queued?.disposition).toBe("removed");
	await live.awaitDisposeCompletion();
	expect(live.isDisposed).toBe(true);
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "disconnected" });
	expect(h.snapshot().sessions[0]?.status).not.toBe("running");
	await h.close();
});

/** The SDK transcript identity the broker would list for the row. */
async function transcriptId(h: { dataDir: string }): Promise<string> {
	return (await readCatalog(h.dataDir)).sessions[0]!.sessionId;
}

test("a conversation a terminal has open is shown read-only and taken back once the terminal closes", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	await h.restart();
	const owner = await transcriptId(h);
	h.liveOwners.add(owner);
	const opened = h.created.length;
	// A settings read is the first request to find the other owner: it answers with the app's settings.
	expect(Array.isArray(await h.call("settings.get", { sessionId }))).toBe(true);
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "elsewhere" });
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	expect(selected.connection).toEqual({ state: "elsewhere" });
	expect(selected.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	expect(h.ownerLookups).toContain(owner);
	// Nothing opened a writer, and nothing can be sent.
	expect(h.created).toHaveLength(opened);
	const calls = h.model.calls.length;
	await expect(h.call("prompt", { sessionId, text: "while the terminal has it" })).rejects.toThrow("terminal");
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "refused" });
	await expect(h.call("session.delete", { sessionId })).rejects.toThrow("terminal");
	expect(h.snapshot().sessions).toHaveLength(1);
	// Checking again while the terminal still has it is an answer, not an error.
	const still = await h.call<DesktopSession>("session.connect", { sessionId });
	expect(still.connection).toEqual({ state: "elsewhere" });
	expect(h.created).toHaveLength(opened);
	expect(h.model.calls).toHaveLength(calls);
	// The terminal closes: selecting takes the conversation back through the normal open.
	h.liveOwners.delete(owner);
	const back = await h.call<DesktopSession>("session.select", { sessionId });
	expect(back.connection).toEqual({ state: "connected" });
	expect(h.created).toHaveLength(opened + 1);
	await h.call("prompt", { sessionId, text: "after the terminal closed" });
	expect(h.model.calls).toHaveLength(calls + 1);
	await h.close();
});

test("Connect on a disconnected conversation the terminal still has open waits for it, read-only", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	await h.call("session.disconnect", { sessionId });
	const owner = await transcriptId(h);
	h.liveOwners.add(owner);
	// The terminal may be writing it: the app refuses to delete it underneath.
	await expect(h.call("session.delete", { sessionId })).rejects.toThrow("terminal");
	const opened = h.created.length;
	const waiting = await h.call<DesktopSession>("session.connect", { sessionId });
	expect(waiting.connection).toEqual({ state: "elsewhere" });
	expect(h.created).toHaveLength(opened);
	h.liveOwners.delete(owner);
	expect((await h.call<DesktopSession>("session.connect", { sessionId })).connection).toEqual({ state: "connected" });
	expect(h.created).toHaveLength(opened + 1);
	await h.close();
});

test("an unreachable broker never blocks opening; the app opens writable as before", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	await h.restart();
	h.failBroker(true);
	const opened = h.created.length;
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	expect(selected.connection).toEqual({ state: "connected" });
	expect(h.created).toHaveLength(opened + 1);
	await h.close();
});

test("a terminal that opens the conversation between two prompts makes the next prompt step aside", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const live = h.sdk();
	// Moments later a terminal resumes the same transcript; the app has not written since.
	h.liveOwners.add(await transcriptId(h));
	const calls = h.model.calls.length;
	await expect(h.call("prompt", { sessionId, text: "right after" })).rejects.toThrow("terminal");
	expect(h.model.calls).toHaveLength(calls);
	// Refused before anything ran, so the app hands the text back to the composer.
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "refused" });
	await live.awaitDisposeCompletion();
	expect(live.isDisposed).toBe(true);
	const shown = h.snapshot().sessions[0];
	expect(shown?.connection).toEqual({ state: "elsewhere" });
	expect(shown?.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	await h.close();
});

test("selecting an idle conversation a terminal has since opened shows it read-only", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const live = h.sdk();
	h.liveOwners.add(await transcriptId(h));
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	expect(selected.connection).toEqual({ state: "elsewhere" });
	expect(selected.messages.map(message => message.text)).toEqual(["app turn", "controlled answer"]);
	await live.awaitDisposeCompletion();
	expect(live.isDisposed).toBe(true);
	await h.close();
});

for (const broker of ["failing", "silent"] as const)
	test(`a ${broker} broker never holds up or refuses a prompt; it runs as before`, async () => {
		const h = await controlledFixture();
		const sessionId = h.session.id;
		await h.call("prompt", { sessionId, text: "app turn" });
		const lookups = h.ownerLookups.length;
		if (broker === "failing") h.failBroker(true);
		// A silent broker never answers this lookup.
		else h.holdBroker();
		const started = performance.now();
		await h.call("prompt", { sessionId, text: "despite the broker" });
		// The app asked before writing, and went ahead when no answer came.
		expect(h.ownerLookups.length).toBeGreaterThan(lookups);
		expect(performance.now() - started).toBeLessThan(1_500);
		expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "completed" });
		expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "connected" });
		await h.close();
	});

/** A request's own response frame, whether it succeeded or not. */
async function respond(
	h: {
		frames: DesktopFrame[];
		call: (method: DesktopRequest["method"], params?: Record<string, unknown>, id?: string) => Promise<unknown>;
	},
	method: DesktopRequest["method"],
	params: Record<string, unknown>,
) {
	const id = crypto.randomUUID();
	await h.call(method, params, id).catch(() => {});
	return h.frames.findLast(frame => frame.type === "response" && frame.id === id);
}

test("a request that arrives while a Disconnect waits for the conversation to open is refused", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	await h.restart();
	const opening = h.holdOpen();
	const selecting = h.call<DesktopSession>("session.select", { sessionId });
	await opening.entered;
	// Disconnect arrives while the conversation is still opening, then a prompt arrives after it.
	const disconnecting = h.call<DesktopDisconnectResult>("session.disconnect", { sessionId });
	const calls = h.model.calls.length;
	const prompted = respond(h, "prompt", { sessionId, text: "sent after Disconnect" });
	await Bun.sleep(50);
	opening.release();
	await selecting;
	expect((await disconnecting).disconnected).toBe(true);
	expect(await prompted).toMatchObject({ ok: false, deliveryDisposition: "refused" });
	expect(h.model.calls).toHaveLength(calls);
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "disconnected" });
	await h.close();
});

test("a prompt sent just before a Disconnect of an idle conversation never runs in it", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const live = h.sdk();
	// The prompt has been admitted to the conversation but waits for the owner check.
	const releaseBroker = h.holdBroker();
	const lookups = h.ownerLookups.length;
	const calls = h.model.calls.length;
	const prompt = h.call("prompt", { sessionId, text: "sent before disconnect" });
	void prompt.catch(() => {});
	await until(() => h.ownerLookups.length > lookups, "the owner lookup");
	// Nothing runs yet, so Disconnect needs no confirmation.
	const disconnecting = h.call<DesktopDisconnectResult>("session.disconnect", { sessionId });
	releaseBroker();
	expect((await disconnecting).disconnected).toBe(true);
	// Once its check answers it finds the conversation fenced, and is refused before anything runs.
	await expect(prompt).rejects.toThrow("disconnected");
	expect(h.model.calls).toHaveLength(calls);
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "refused" });
	await live.awaitDisposeCompletion();
	expect(live.isDisposed).toBe(true);
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "disconnected" });
	await h.close();
});

test("an owner check that answers after its copy was replaced leaves the new copy and the row alone", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const stale = h.sdk();
	const releaseBroker = h.holdBroker();
	const lookups = h.ownerLookups.length;
	// The prompt's owner check waits for the broker.
	const checking = h.call("prompt", { sessionId, text: "checked late" });
	void checking.catch(() => {});
	await until(() => h.ownerLookups.length > lookups, "the owner lookup");
	// Meanwhile the terminal appends, and a select replaces the stale copy with a fresh one.
	await continueInTerminal(stale.sessionFile!, h.projectDir, h.agentDir, h.track);
	await h.call("session.select", { sessionId });
	const fresh = h.sdk();
	expect(fresh).not.toBe(stale);
	// The late answer says "live", but it was about a copy that is no longer the conversation's.
	h.liveOwners.add(await transcriptId(h));
	releaseBroker();
	await checking;
	expect(fresh.isDisposed).toBe(false);
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "connected" });
	expect(h.snapshot().deliveries.at(-1)).toMatchObject({ sessionId, disposition: "completed" });
	// The fresh copy's own next write checks, and steps aside.
	await expect(h.call("prompt", { sessionId, text: "next" })).rejects.toThrow("terminal");
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "elsewhere" });
	await h.close();
});

test("a turn that starts while the owner check is waiting is not released under it", async () => {
	const held = heldTurn();
	const h = await controlledFixture(held.handler);
	cleanups.push(async () => held.release());
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const live = h.sdk();
	const releaseBroker = h.holdBroker();
	const lookups = h.ownerLookups.length;
	// The first prompt asks the broker, which has not answered yet.
	const checking = h.call("prompt", { sessionId, text: "first after idle" });
	void checking.catch(() => {});
	await until(() => h.ownerLookups.length > lookups, "the owner lookup");
	// A second prompt's own check finds no owner yet, and it starts a turn.
	held.arm();
	const running = h.call("prompt", { sessionId, text: "started meanwhile" });
	await held.entered;
	// Only then does a terminal open the conversation, and the first check answers "live".
	h.liveOwners.add(await transcriptId(h));
	releaseBroker();
	// The check answers "a terminal has it open", but a turn now runs in this copy: it stays, and
	// the first prompt joins that turn as a steer instead of the turn being released under it.
	expect(await checking).toMatchObject({ queued: true });
	expect(live.isDisposed).toBe(false);
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "connected" });
	held.release();
	await running;
	await until(
		() =>
			h
				.snapshot()
				.deliveries.slice(-2)
				.every(receipt => receipt.disposition === "completed"),
		"both prompts to complete",
	);
	// The next prompt checks again at once and steps aside, before anything runs.
	const calls = h.model.calls.length;
	await expect(h.call("prompt", { sessionId, text: "after the turn" })).rejects.toThrow("terminal");
	expect(h.model.calls).toHaveLength(calls);
	await live.awaitDisposeCompletion();
	expect(h.snapshot().sessions[0]?.connection).toEqual({ state: "elsewhere" });
	await h.close();
});

test("Disconnect and Connect never leave a long transcript shrunk to its snapshot share", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const file = h.sdk().sessionFile!;
	for (let index = 0; index < 6; index++) await h.call("session.create", { projectId: h.project.id });
	await h.call("project.close", { projectId: h.project.id });
	const terminal = h.track(await resumeAsTerminal(file, h.projectDir, h.agentDir));
	for (let index = 0; index < 40; index++)
		terminal.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${index} ${"x".repeat(7_000)}` }],
			timestamp: Date.now(),
		});
	await terminal.flush();
	expect(await terminal.closeStrict()).toMatchObject({ kind: "closed" });
	await h.call("project.open", { path: h.projectDir });
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	expect(selected.messages.length).toBeGreaterThan(20);
	// Apply the frames in order, as the app does: a snapshot replaces rows, session frames follow.
	const shownAfter = async (operation: () => Promise<unknown>) => {
		const from = h.frames.length;
		await operation();
		let shown: DesktopSession | undefined;
		for (const frame of h.frames.slice(from)) {
			if (frame.type === "snapshot") shown = frame.snapshot.sessions.find(session => session.id === sessionId);
			if (frame.type === "session" && frame.session.id === sessionId) shown = frame.session;
		}
		return shown;
	};
	const released = await shownAfter(() => h.call("session.disconnect", { sessionId }));
	expect(released?.connection).toEqual({ state: "disconnected" });
	expect(released?.messages.map(message => message.text)).toEqual(selected.messages.map(message => message.text));
	const connected = await shownAfter(() => h.call("session.connect", { sessionId }));
	expect(connected?.connection).toEqual({ state: "connected" });
	expect(connected?.messages.map(message => message.text)).toEqual(selected.messages.map(message => message.text));
	await h.close();
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

test("a workspace refresh never shrinks the open conversation's transcript", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "app turn" });
	const file = h.sdk().sessionFile!;
	for (let index = 0; index < 6; index++) await h.call("session.create", { projectId: h.project.id });
	await h.call("project.close", { projectId: h.project.id });
	// A long history: the snapshot's per-row share cannot carry all of it.
	const terminal = h.track(await resumeAsTerminal(file, h.projectDir, h.agentDir));
	for (let index = 0; index < 40; index++)
		terminal.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${index} ${"x".repeat(7_000)}` }],
			timestamp: Date.now(),
		});
	await terminal.flush();
	expect(await terminal.closeStrict()).toMatchObject({ kind: "closed" });
	await h.call("project.open", { path: h.projectDir });
	const selected = await h.call<DesktopSession>("session.select", { sessionId });
	const from = h.frames.length;
	await h.call("bootstrap");
	await h.refreshed();
	// Apply the frames in order, as the app does: the snapshot replaces rows, session frames follow.
	let shown: DesktopSession | undefined;
	for (const frame of h.frames.slice(from)) {
		if (frame.type === "snapshot") shown = frame.snapshot.sessions.find(session => session.id === sessionId);
		if (frame.type === "session" && frame.session.id === sessionId) shown = frame.session;
	}
	expect(shown?.messages.length).toBeGreaterThan(20);
	expect(shown?.messages).toEqual(selected.messages);
});

test("refreshing the workspace does not list a branch fork's private ancestor as a conversation", async () => {
	const h = await controlledFixture();
	const sessionId = h.session.id;
	await h.call("prompt", { sessionId, text: "first turn" });
	await h.call("prompt", { sessionId, text: "second turn" });
	const fork = await h.call<{ session: DesktopSession }>("session.fork", { sessionId, entryId: h.lastUser() });
	const rows = h.snapshot().sessions.map(session => session.id);
	expect(rows).toEqual([sessionId, fork.session.id]);
	// The SDK keeps the full copy the branch was cut from; only the branch is the user's conversation.
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual(rows);
	await h.restart();
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual(rows);
	// Nor does the copy surface once the branch itself is deleted.
	await h.call("session.delete", { sessionId: fork.session.id });
	await h.call("bootstrap");
	await h.refreshed();
	expect(h.snapshot().sessions.map(session => session.id)).toEqual([sessionId]);
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

test("deleting an unopened missing transcript also removes its SDK artifact directory", async () => {
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
	expect(await Bun.file(retained).exists()).toBe(false);
	await expect(fs.stat(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
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
