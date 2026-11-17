import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import * as sdk from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import { openNativeSession } from "../src/native-session";
import type { DesktopFrame, DesktopProject, DesktopRequest, DesktopSession } from "../src/protocol";

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
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-connect-")));
	const cwd = path.join(root, "project");
	const dataDir = path.join(root, "app");
	const agentDir = path.join(dataDir, "agent");
	await fs.mkdir(cwd);
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	await Bun.write(path.join(agentDir, "config.yml"), JSON.stringify({
		recipe: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false },
		tools: { discoveryMode: "off" },
	}));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing fixture model");
	const results: sdk.CreateAgentSessionResult[] = [];
	const options = {
		cwd, agentDir, model, extensions: [], skills: [], rules: [], contextFiles: [],
		promptTemplates: [], slashCommands: [], disableExtensionDiscovery: true,
		enableMcpAutoload: false, enableLsp: false, skipPythonPreflight: true,
		deferOptionalModelRefresh: true, deferMemoryBackendStartup: true,
		asyncJobs: "none" as const, toolNames: [],
	};
	const frames: DesktopFrame[] = [];
	const host = new DesktopHost({
		dataDir, emit: frame => frames.push(frame),
		createSession: async input => {
			const result = await sdk.createAgentSession({ ...input, ...options });
			results.push(result);
			return result;
		},
	});
	await host.initialize();
	const call = async <T = unknown>(method: DesktopRequest["method"], params: Record<string, unknown>): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle({ id, method, params });
		const frame = frames.findLast(item => item.type === "response" && item.id === id);
		if (frame?.type !== "response") throw new Error("Missing response");
		if (!frame.ok) throw new Error(frame.error);
		return frame.result as T;
	};
	// The baseline registry can retain TERM even after stop/join. Cleanup records that
	// refusal, rather than bypassing native disposal authorization to make fixtures pass.
	let retained = false;
	cleanups.push(async () => {
		if (retained) await expect(host.close()).rejects.toThrow("Desktop shutdown failed to clean up all SDK resources");
		else await host.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return { root, cwd, dataDir, agentDir, host, options, results, call, expectRetained: () => { retained = true; } };
}

async function terminalConversation(f: {
	cwd: string; agentDir: string;
	call<T>(method: DesktopRequest["method"], params: Record<string, unknown>): Promise<T>;
}) {
	// A pre-native terminal transcript has no enrollment marker. Two exact branches
	// make its legacy tail require both explicit selection and row-bound attestation.
	const destination = SessionManager.managedDestination(f.cwd, f.agentDir);
	const sessionId = crypto.randomUUID();
	const file = path.join(destination.directory, `${sessionId}.jsonl`);
	const leaf = "terminal-second";
	await Bun.write(file, [
		{ type: "session", version: 5, id: sessionId, cwd: f.cwd, timestamp: new Date().toISOString() },
		...["terminal-first", leaf].map(id => ({
			type: "message", id, parentId: null, timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "from the terminal" }], timestamp: Date.now() },
		})),
	].map(item => JSON.stringify(item)).join("\n") + "\n");
	const resolved = sdk.resolveEmbeddedResumeCheckpoint(file);
	if (resolved.kind !== "resolved") throw new Error(resolved.reason);
	const project = await f.call<DesktopProject>("project.open", { path: f.cwd });
	return { file, leaf, sessionId, project, checkpoint: resolved.checkpoint };
}

interface Connected { kind: "connected"; session: DesktopSession }

test("discovered terminal conversation connects with native ownership and the native interaction bridge", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	expect(f.host.snapshot().sessions.find(item => item.id === t.sessionId)?.ownership).toBeUndefined();
	const interaction = vi.spyOn(sdk, "currentEmbeddedInteraction");
	const connected = await f.call<Connected>("session.connect", {
		sessionId: t.sessionId,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
		legacyAttestation: { snapshotDigest: t.checkpoint.snapshotDigest, acknowledged: true },
	});
	expect(connected).toMatchObject({ kind: "connected" });
	expect(connected.session.ownership).toBe("native");
	expect(connected.session.connectionState).toBe("connected");
	expect(connected.session.messages.some(item => item.text === "from the terminal")).toBe(true);
	const selected = await f.call<DesktopSession>("session.select", { sessionId: t.sessionId });
	expect(selected.ownership).toBe("native");
	const result = f.results.at(-1)!;
	// Questions travel through the SDK's registered interaction service, not a raw UI writer.
	expect(result.session.sessionManager.getSessionOwnerEvidence()?.policy.kind).toBe("exclusive_native");
	const registered = interaction.mock.results.at(-1)?.value as sdk.EmbeddedWorkSource["interaction"] | undefined;
	if (!registered) throw new Error("Missing registered native interaction service");
	const answer = registered.service.ui.input("Native question");
	await Promise.resolve();
	const question = f.host.snapshot().sessions.find(item => item.id === t.sessionId)?.question;
	if (!question) throw new Error("Native interaction did not reach the desktop");
	await f.call<unknown>("question.answer", { sessionId: t.sessionId, questionId: question.id, value: "native answer" });
	expect(await answer).toBe("native answer");
	expect(await f.call<unknown>("session.disconnect", { sessionId: t.sessionId })).toEqual({ kind: "disconnected" });
	expect(f.host.snapshot().sessions.find(item => item.id === t.sessionId)?.ownership).toBeUndefined();
});

test("connect refuses an unattested legacy tail without admitting a writer", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	expect(t.checkpoint.kind).toBe("legacy_tail");
	const before = await Bun.file(t.file).text();
	const count = f.results.length;
	expect(await f.call<unknown>("session.connect", {
		sessionId: t.sessionId,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
	})).toEqual({ kind: "refused", reason: "legacy_attestation_required", checkpoint: t.checkpoint });
	expect(await Bun.file(t.file).text()).toBe(before);
	expect(f.results.length).toBe(count);
	expect(await f.call<unknown>("session.connect", {
		sessionId: t.sessionId,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
		legacyAttestation: { snapshotDigest: "another-row", acknowledged: true },
	})).toEqual({ kind: "refused", reason: "legacy_attestation_required", checkpoint: t.checkpoint });
});

test("connect refuses when the transcript moves between strict capture and native creation", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	const create = sdk.createEmbeddedAgentSession;
	function moved(input: sdk.NativeEmbeddedAgentSessionOptions): Promise<sdk.NativeEmbeddedOpenResult>;
	function moved(input: sdk.EmbeddedAgentSessionOptions): Promise<sdk.EmbeddedAgentSessionResult>;
	async function moved(input: sdk.NativeEmbeddedAgentSessionOptions | sdk.EmbeddedAgentSessionOptions): Promise<sdk.NativeEmbeddedOpenResult | sdk.EmbeddedAgentSessionResult> {
		if ("native" in input) {
			await fs.appendFile(t.file, "\n");
			return create(input);
		}
		return create(input);
	}
	const factory = vi.spyOn(sdk, "createEmbeddedAgentSession").mockImplementation(moved);
	const opened = await openNativeSession({
		options: f.options, storage: { managed: true }, file: t.file,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
		legacyAttestation: { snapshotDigest: t.checkpoint.snapshotDigest, acknowledged: true },
	});
	expect(opened).toEqual({ kind: "refused", reason: "stale_snapshot" });
	expect(factory).toHaveBeenCalledTimes(1);
});

test("disconnect consents to exactly the SDK blocker targets and joins its owned question", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	const interaction = vi.spyOn(sdk, "currentEmbeddedInteraction");
	await f.call<Connected>("session.connect", {
		sessionId: t.sessionId,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
		legacyAttestation: { snapshotDigest: t.checkpoint.snapshotDigest, acknowledged: true },
	});
	const registered = interaction.mock.results.at(-1)?.value as sdk.EmbeddedWorkSource["interaction"] | undefined;
	if (!registered) throw new Error("Missing native interaction");
	const answer = registered.service.ui.input("Owned question");
	const consent = vi.spyOn(sdk, "consentEmbeddedDisconnect");
	const disconnected = await f.call<unknown>("session.disconnect", { sessionId: t.sessionId });
	expect(disconnected).toEqual({ kind: "disconnected" });
	expect(await answer).toBeUndefined();
	expect(consent).toHaveBeenCalledTimes(1);
	const work = consent.mock.calls[0]![2].work;
	if (!work) throw new Error("Disconnect did not carry work consent");
	expect(work.inventory.blockers).toHaveLength(1);
	expect(work.targets).toEqual(work.inventory.blockers.map(blocker => blocker.target!));
	expect(work.targets[0]?.kind).toBe("request");
});

test("disconnect reports a targetless owned blocker without minting empty consent", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	await f.call<Connected>("session.connect", {
		sessionId: t.sessionId,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
		legacyAttestation: { snapshotDigest: t.checkpoint.snapshotDigest, acknowledged: true },
	});
	const prepare = sdk.prepareEmbeddedDisconnect;
	const preparation = vi.spyOn(sdk, "prepareEmbeddedDisconnect").mockImplementation(async (handle, op) => {
		const prepared = await prepare(handle, op);
		if (!prepared.inventory) throw new Error("Missing real inventory");
		return { ...prepared, inventory: {
			...prepared.inventory,
			blockers: [{ kind: "hidden_context", id: t.sessionId, reason: "hidden_next_turn_context" }],
		} };
	});
	const consent = vi.spyOn(sdk, "consentEmbeddedDisconnect");
	expect(await f.call<unknown>("session.disconnect", { sessionId: t.sessionId })).toEqual({
		kind: "blocked", state: "checkpoint_incomplete", blockers: ["owned_work:hidden_context"],
	});
	expect(consent).not.toHaveBeenCalled();
	expect(f.results.at(-1)!.session.sessionManager.getStrictCloseState().kind).toBe("none_started");
	preparation.mockRestore();
	expect(await f.call<unknown>("session.disconnect", { sessionId: t.sessionId })).toEqual({ kind: "disconnected" });
});

test("disconnect retains an owner whose final closure cannot be proven", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	await f.call<Connected>("session.connect", {
		sessionId: t.sessionId,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
		legacyAttestation: { snapshotDigest: t.checkpoint.snapshotDigest, acknowledged: true },
	});
	const manager = f.results.at(-1)!.session.sessionManager;
	vi.spyOn(manager, "getResumeClosureEvidence").mockResolvedValue(undefined);
	f.expectRetained();
	expect(await f.call<unknown>("session.disconnect", { sessionId: t.sessionId })).toEqual({
		kind: "blocked", state: "detach_unknown", blockers: ["terminal_retention"],
	});
	const retained = f.host.snapshot().sessions.find(item => item.id === t.sessionId);
	expect(retained?.ownership).toBe("native");
	expect(retained?.connectionState).toBe("detach_unknown");
	expect(await f.call<unknown>("session.disconnect", { sessionId: t.sessionId })).toMatchObject({ kind: "blocked" });
	expect(await f.call<unknown>("session.connect", { sessionId: t.sessionId })).toEqual({
		kind: "refused", reason: f.host.snapshot().sessions.find(item => item.id === t.sessionId)?.connectionState,
	});
});

test("legacy connect surfaces exact candidates and requires a selection even after attestation", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	expect(await f.call<unknown>("session.connect", {
		sessionId: t.sessionId,
		legacyAttestation: { snapshotDigest: t.checkpoint.snapshotDigest, acknowledged: true },
	})).toEqual({ kind: "selector_required", checkpoint: t.checkpoint, candidates: t.checkpoint.candidates });
	expect(f.host.snapshot().sessions.find(item => item.id === t.sessionId)?.ownership).toBeUndefined();
});

test("after a native successor commit, reattachment resolves the successor without re-keying the catalog row", async () => {
	const f = await fixture();
	const t = await terminalConversation(f);
	const create = vi.spyOn(sdk, "createEmbeddedAgentSession");
	await f.call<Connected>("session.connect", {
		sessionId: t.sessionId,
		selection: { snapshotDigest: t.checkpoint.snapshotDigest, targetLeafId: t.leaf },
		legacyAttestation: { snapshotDigest: t.checkpoint.snapshotDigest, acknowledged: true },
	});
	const creations = await Promise.all(create.mock.results.map(item => item.value)) as Array<sdk.NativeEmbeddedOpenResult | sdk.EmbeddedAgentSessionResult>;
	const opened = creations.find((result): result is Extract<sdk.NativeEmbeddedOpenResult, { kind: "opened" }> =>
		"kind" in result && result.kind === "opened");
	if (!opened) throw new Error("Missing admitted native runtime");
	expect((await opened.runtime.session.branch(t.leaf)).kind).toBe("applied");
	const successorId = opened.result.session.sessionManager.getSessionId();
	const successorFile = opened.result.session.sessionManager.getSessionFile();
	expect(successorId).not.toBe(t.sessionId);
	expect(await f.call<unknown>("session.disconnect", { sessionId: t.sessionId })).toEqual({ kind: "disconnected" });
	const row = f.host.snapshot().sessions.find(item => item.id === t.sessionId);
	expect(row?.id).toBe(t.sessionId);
	const catalog = await Bun.file(path.join(f.dataDir, "catalog.json")).json();
	expect(catalog.sessions.find((item: { id: string }) => item.id === t.sessionId)).toMatchObject({
		id: t.sessionId, sessionId: successorId, managed: true,
	});
	// Use the real SDK's exact saved-transcript resolution. Stop only before runtime
	// launch: this test must neither impersonate a CLI nor require a resident daemon.
	const resume = vi.spyOn(sdk.lifecycle.AgentDirSessionLifecycleService.prototype, "resume")
		.mockRejectedValue(new Error("fixture stopped after exact successor resolution"));
	await expect(f.call<unknown>("session.select", { sessionId: t.sessionId })).rejects.toThrow(
		"fixture stopped after exact successor resolution",
	);
	expect(resume).toHaveBeenCalledTimes(1);
	expect(resume.mock.calls[0]![0].target).toMatchObject({ sessionId: successorId, sessionPath: successorFile });
});
