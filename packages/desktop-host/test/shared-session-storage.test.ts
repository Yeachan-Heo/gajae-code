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

async function fixture() {
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
	let host = new DesktopHost({
		dataDir,
		emit: frame => frames.push(frame),
		createSession: async options => {
			const result = await createAgentSession({ ...options, extensions: [] });
			created.push(result);
			return result;
		},
	});
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
		dataDir,
		agentDir,
		projectDir,
		snapshot: () => host.snapshot(),
		restart: async () => {
			await host.close();
			await Promise.all(created.map(result => result.session.awaitDisposeCompletion()));
			host = new DesktopHost({
				dataDir,
				emit: frame => frames.push(frame),
				createSession: async options => {
					const result = await createAgentSession({ ...options, extensions: [] });
					created.push(result);
					return result;
				},
			});
			await host.initialize();
		},
		track: (manager: SessionManager) => {
			managers.push(manager);
			return manager;
		},
	};
}

/** The terminal's own resume path, used here as the other surface of the shared store. */
async function resumeAsTerminal(file: string, cwd: string, agentDir: string) {
	return SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
}

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

	// Stop the desktop owner before another surface writes, exactly as the user does.
	await h.call("project.close", { projectId: project.id });
	const terminal = h.track(await resumeAsTerminal(transcript, h.projectDir, h.agentDir));
	expect(terminal.getSessionId()).toBe(appSessionId);
	terminal.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continued in the terminal" }],
		timestamp: Date.now(),
	});
	await terminal.flush();
	expect(await terminal.closeStrict()).toMatchObject({ kind: "closed" });

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
