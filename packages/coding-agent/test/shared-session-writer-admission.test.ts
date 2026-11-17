/**
 * Every writer of an admitted root interactive session honors shared admission (#7837
 * follow-up): once the root's transcript is published (resumed, /resume, or after its
 * first shared publication) a legacy append would bypass the lease a live peer may hold,
 * so it must refuse before any byte. An unpublished successor (/new) still stages. A
 * writer outside admission (an SDK opener) whose append was fenced refuses every later
 * prompt and control with the typed identity rejection before the model runs.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { setPrimaryControlSurface } from "../src/session/primary-control-surface";
import { SessionManager, type SessionDestination } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const stores: AuthStorage[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
// Matched structurally so a reverted source fails each case instead of the whole file.
const refused = { name: "SharedSessionMutationUnsupportedError" };
const fenced = { name: "ManagedAppendIdentityMismatchError", code: "managed_append_identity_mismatch" };

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose().catch(() => undefined);
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

interface Workspace {
	cwd: string;
	agentDir: string;
	auth: AuthStorage;
	destination: SessionDestination;
	registry: ModelRegistry;
}

async function workspace(): Promise<Workspace> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-writer-admission-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	return { cwd, agentDir, auth, destination: SessionManager.managedDestination(cwd, agentDir), registry };
}

function open(ws: Workspace, manager: SessionManager, rootInteractiveSharedAppend: boolean): AgentSession {
	managers.push(manager);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry: ws.registry,
		rootInteractiveSharedAppend,
		thinkingLevel: ThinkingLevel.Off,
	});
	sessions.push(session);
	// Never reach a provider: a prompt that is not refused fails with this sentinel.
	vi.spyOn(session.agent, "prompt").mockRejectedValue(new Error("model must not be called"));
	return session;
}

/** A persisted transcript written by an earlier (now closed) opener. */
async function persistedTranscript(ws: Workspace): Promise<string> {
	const writer = SessionManager.create(ws.cwd, ws.destination);
	writer.appendMessage(user("earlier run"));
	await writer.ensureOnDisk();
	await writer.flush();
	const file = writer.getSessionFile();
	if (!file) throw new Error("Missing transcript");
	await writer.closeStrict();
	return file;
}

/** Legacy writers on a published admitted root refuse and leave the transcript untouched. */
async function expectLegacyWritersRefused(session: AgentSession, file: string) {
	const before = await Bun.file(file).text();
	const manager = session.sessionManager;
	expect(() => manager.appendMessage(user("legacy append"))).toThrow(expect.objectContaining(refused));
	expect(() => manager.appendCustomEntry("legacy", { value: 1 })).toThrow(expect.objectContaining(refused));
	expect(() => session.setConfiguredModelChain("default", ["anthropic/claude-sonnet-4-5"], "modelRoles")).toThrow(
		expect.objectContaining(refused),
	);
	await manager.flush();
	expect(await Bun.file(file).text()).toBe(before);
}

describe("admitted root writers on a published transcript", () => {
	it("refuses legacy writes on a resumed transcript before its first shared publication", async () => {
		const ws = await workspace();
		const file = await persistedTranscript(ws);
		const session = open(ws, await SessionManager.open(file, ws.destination), true);
		expect(session.sessionManager.getEntries().length).toBeGreaterThan(0);
		await expectLegacyWritersRefused(session, file);
		// The session's own producers still publish through admission.
		session.agent.emitExternalEvent({ type: "message_end", message: user("shared after refusal") });
		await session.awaitSessionSettlement();
		expect(session.agent.state.error).toBeUndefined();
		expect(await Bun.file(file).text()).toContain("shared after refusal");
	});

	it("stages an unpublished /new successor and refuses once it publishes", async () => {
		const ws = await workspace();
		const file = await persistedTranscript(ws);
		const session = open(ws, await SessionManager.open(file, ws.destination), true);
		expect(await session.newSession()).toBe(true);
		const successor = session.sessionManager;
		expect(successor.isTranscriptPublished()).toBe(false);
		// Bootstrap staging before the first publication stays legacy and lands with it.
		const staged = successor.appendCustomEntry("staged", { value: 1 });
		session.agent.emitExternalEvent({ type: "message_end", message: user("successor first") });
		await session.awaitSessionSettlement();
		const successorFile = successor.getSessionFile();
		if (!successorFile) throw new Error("Missing successor transcript");
		expect(successorFile).not.toBe(file);
		expect(await Bun.file(successorFile).text()).toContain(staged);
		await expectLegacyWritersRefused(session, successorFile);
	});

	it("refuses legacy writes after /resume of a published transcript", async () => {
		const ws = await workspace();
		const file = await persistedTranscript(ws);
		const session = open(ws, SessionManager.create(ws.cwd, ws.destination), true);
		expect(await session.switchSession(file)).toBe(true);
		expect(session.sessionManager.getSessionFile()).toBe(file);
		await expectLegacyWritersRefused(session, file);
	});
});

describe("TUI and SDK alternation on one transcript", () => {
	it("fences the unadmitted SDK opener and keeps the TUI publishing", async () => {
		const ws = await workspace();
		const file = await persistedTranscript(ws);
		const sdk = open(ws, await SessionManager.open(file, ws.destination), false);
		const tui = open(ws, await SessionManager.open(file, ws.destination), true);

		tui.agent.emitExternalEvent({ type: "message_end", message: user("tui first") });
		await tui.awaitSessionSettlement();
		expect(await Bun.file(file).text()).toContain("tui first");

		// The SDK's legacy append is fenced: the TUI changed the transcript identity.
		sdk.agent.emitExternalEvent({ type: "message_end", message: user("sdk stale") });
		await sdk.awaitSessionSettlement().catch(() => undefined);
		expect(sdk.sessionManager.getAppendIdentityMismatch()).toMatchObject(fenced);
		const afterFence = await Bun.file(file).text();
		expect(afterFence).not.toContain("sdk stale");

		// Every later SDK ingress reports the typed rejection before any effect.
		await expect(sdk.prompt("sdk next")).rejects.toMatchObject(fenced);
		await expect(sdk.setServiceTier("priority")).rejects.toMatchObject(fenced);
		expect(sdk.agent.prompt).not.toHaveBeenCalled();
		expect(sdk.serviceTier).toBeUndefined();
		expect(await Bun.file(file).text()).toBe(afterFence);

		tui.agent.emitExternalEvent({ type: "message_end", message: user("tui second") });
		await tui.awaitSessionSettlement();
		expect(tui.agent.state.error).toBeUndefined();
		expect(await Bun.file(file).text()).toContain("tui second");
	});
});

function mcpTool(name: string): CustomTool {
	return {
		name,
		label: name,
		description: `Tool ${name}`,
		mcpServerName: "docs",
		mcpToolName: name,
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	} as CustomTool;
}

describe("root interactive bootstrap admission", () => {
	it("publishes a resumed selection prune through the lease while a peer is live", async () => {
		const ws = await workspace();
		const seed = SessionManager.create(ws.cwd, ws.destination);
		seed.appendMessage(user("earlier run"));
		seed.appendMCPToolSelection(["mcp__docs_kept", "mcp__docs_gone"]);
		await seed.ensureOnDisk();
		await seed.flush();
		const file = seed.getSessionFile();
		if (!file) throw new Error("Missing transcript");
		await seed.closeStrict();

		const resumed = await SessionManager.open(file, ws.destination);
		managers.push(resumed);
		// A live peer publishes after this opener read the transcript.
		const peer = await SessionManager.open(file, ws.destination);
		managers.push(peer);
		const peerAppend = await peer.appendMessageSharingSession(user("peer turn"));
		if (peerAppend.kind !== "committed") throw new Error(`peer append: ${peerAppend.kind}`);

		const settings = Settings.isolated({ "mcp.discoveryMode": true, "recipe.enabled": false });
		const options = {
			cwd: ws.cwd,
			agentDir: ws.agentDir,
			sessionManager: resumed,
			authStorage: ws.auth,
			settings,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			hasUI: true,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
			customTools: [mcpTool("mcp__docs_kept")],
		};
		setPrimaryControlSurface(options, "cli");
		const { session } = await createAgentSession(options);
		sessions.push(session);

		expect(resumed.usesSharedPublication()).toBe(true);
		expect(resumed.getAppendIdentityMismatch()).toBeUndefined();
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_kept"]);
		const reopened = await SessionManager.open(file, ws.destination);
		managers.push(reopened);
		const context = reopened.buildSessionContext();
		expect(context.selectedMCPToolNames).toEqual(["mcp__docs_kept"]);
		expect(reopened.getEntries().some(entry => entry.id === peerAppend.id)).toBe(true);
	});

	it("publishes initial metadata through admission for header-only resumes", async () => {
		const ws = await workspace();
		// Create a published transcript with no messages (header-only)
		const seed = SessionManager.create(ws.cwd, ws.destination);
		// Don't add any messages - just ensure it's on disk and published
		await seed.ensureOnDisk();
		await seed.flush();
		const file = seed.getSessionFile();
		if (!file) throw new Error("Missing transcript");
		await seed.closeStrict();

		const resumed = await SessionManager.open(file, ws.destination);
		managers.push(resumed);
		expect(resumed.isTranscriptPublished()).toBe(true);
		expect(resumed.getBranch().length).toBe(0); // Header-only: empty branch

		// A live peer will publish after this opener reads the transcript to admit the root
		const peer = await SessionManager.open(file, ws.destination);
		managers.push(peer);
		// The peer publishes to admit the root
		const peerAppend = await peer.appendMessageSharingSession(user("peer turn"));
		if (peerAppend.kind !== "committed") throw new Error(`peer append: ${peerAppend.kind}`);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.reminders": false,
			defaultThinkingLevel: "low",
		});
		const options = {
			cwd: ws.cwd,
			agentDir: ws.agentDir,
			sessionManager: resumed,
			authStorage: ws.auth,
			modelRegistry: new ModelRegistry(ws.auth),
			settings,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			thinkingLevel: ThinkingLevel.Low,
			hasUI: true,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
		};
		setPrimaryControlSurface(options, "cli");

		// This should not throw when creating the session with initial metadata
		let session: AgentSession | undefined;
		let createError: unknown;
		try {
			const result = await createAgentSession(options);
			session = result.session;
			sessions.push(session);
		} catch (error) {
			createError = error;
		}

		// After peer publication, the resumed manager should use shared publication
		expect(resumed.usesSharedPublication()).toBe(true);

		// Now when resumed tries to write initial metadata through legacy methods, it should fail
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing bundled model");

		// Legacy writes on the admitted root should fail
		expect(() => resumed.appendModelChange(`${model.provider}/${model.id}`)).toThrow(
			expect.objectContaining(refused),
		);

		expect(() => resumed.appendThinkingLevelChange(ThinkingLevel.Low)).toThrow(expect.objectContaining(refused));

		// Despite legacy writes failing, createAgentSession should succeed by routing metadata through shared publication
		if (createError) {
			throw createError;
		}
		expect(session).toBeDefined();
		if (session) {
			expect(session.agent.state.error).toBeUndefined();
		}

		// Verify that the metadata entries were published through the shared path
		const finalManager = await SessionManager.open(file, ws.destination);
		managers.push(finalManager);
		const allEntries = finalManager.getEntries();

		const thinkingEntries = allEntries.filter(entry => entry.type === "thinking_level_change");
		const modelEntries = allEntries.filter(entry => entry.type === "model_change");

		// Should have metadata entries published through admission
		expect(thinkingEntries.length).toBeGreaterThan(0);
		expect(modelEntries.length).toBeGreaterThan(0);
	});
});
