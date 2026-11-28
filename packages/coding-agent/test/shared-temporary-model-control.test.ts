import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const stores: AuthStorage[] = [];
const registries: ModelRegistry[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const options = { cause: "temporary-operation" as const, reason: "other" as const };

async function fixture(rebuild?: () => Promise<{ systemPrompt: string[] }>) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-temporary-model-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	manager.appendMessage(user("first"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const initial = getBundledModel("anthropic", "claude-sonnet-4-5");
	const selected = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!initial || !selected) throw new Error("Missing bundled models");
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
	const edit: AgentTool = {
		name: "edit",
		label: "Edit",
		description: "Fixture edit tool",
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "edited" }] }),
	};
	const agent = new Agent({
		initialState: { model: initial, systemPrompt: ["Test"], tools: rebuild ? [edit] : [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		thinkingLevel: ThinkingLevel.Off,
		...(rebuild ? { toolRegistry: new Map([[edit.name, edit]]), rebuildSystemPrompt: rebuild } : {}),
	});
	sessions.push(session);
	// The fixture seeds a legacy message so temporary records have a known committed parent.
	const admitted = { kind: "committed" as const, id: manager.appendMessage(user("shared root")) };
	return { manager, session, agent, initial, selected, file, settings, destination, registry, admitted };
}

async function records(file: string) {
	return (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(
			line =>
				JSON.parse(line) as {
					type: string;
					id?: string;
					parentId?: string;
					model?: string;
					role?: string;
					thinkingLevel?: string;
				},
		);
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function configureRoleCycle(f: { settings: Settings; initial: Model; selected: Model }) {
	const roles = {
		default: `${f.initial.provider}/${f.initial.id}:off`,
		smol: `${f.selected.provider}/${f.selected.id}:high`,
	};
	f.settings.set("modelRoles", roles);
	f.settings.set("cycleOrder", ["default", "smol"]);
	return roles;
}

describe("shared temporary model control", () => {
	for (const optedIn of [false, true]) {
		// #7824: an adopted session keeps using shared publication, and a persistent cycle
		// publishes additively instead of staging a transcript rewrite.
		it(`publishes ${optedIn ? "persistent" : "temporary"} role cycles of an adopted session additively`, async () => {
			const f = await fixture();
			const roles = configureRoleCycle(f);
			const before = await Bun.file(f.file).text();
			const leaf = f.manager.getLeafId();
			const result = await f.session.cycleRoleModels(["default", "smol"], { temporary: !optedIn });
			expect(result?.role).toBe("smol");
			expect(f.session.model).toMatchObject({ provider: f.selected.provider, id: f.selected.id });
			const after = await Bun.file(f.file).text();
			expect(after.startsWith(before)).toBe(true);
			const appended = (await records(f.file)).slice(before.trim().split("\n").length);
			expect(appended[0]).toMatchObject({ parentId: leaf });
			if (optedIn) {
				expect(appended.filter(entry => entry.type === "model_change").map(entry => entry.role)).toEqual([
					"default",
					"smol",
				]);
			} else {
				expect(f.settings.get("modelRoles")).toEqual(roles);
				expect(appended[0]).toMatchObject({ type: "model_change", role: "temporary" });
			}
		});
	}

	it("publishes two linked records and restores an auto-owned baseline without another append", async () => {
		const f = await fixture();
		const baselineThinking = f.session.thinkingLevel;
		const prefix = await records(f.file);
		const first = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		expect(first).toBeDefined();
		const appended = (await records(f.file)).slice(prefix.length);
		expect(appended).toHaveLength(2);
		expect(appended[0]).toMatchObject({ type: "model_change", role: "temporary", parentId: f.admitted.id });
		expect(appended[1]).toMatchObject({ type: "thinking_level_change", parentId: appended[0]?.id });
		const second = await f.session.setModelTemporary(f.initial, undefined, options);
		expect(second).toBeUndefined();
		expect(f.session.model).toEqual(f.initial);
		expect(f.session.thinkingLevel).toBe(baselineThinking);
		const restoredBytes = await Bun.file(f.file).text();
		if (first) expect(await f.session.restoreTemporaryProviderSessionScope(first)).toBe(false);
		expect(await Bun.file(f.file).text()).toBe(restoredBytes);
	});

	it("records repeated temporary reasoning against the restored baseline", async () => {
		const f = await fixture();
		const first = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		const before = (await records(f.file)).length;
		const second = await f.session.setModelTemporary(f.selected, ThinkingLevel.High, options);
		expect((await records(f.file)).slice(before).map(entry => entry.type)).toEqual([
			"model_change",
			"thinking_level_change",
		]);
		if (!first || !second) throw new Error("Expected replaced auto-owned scopes");
		expect(await f.session.restoreTemporaryProviderSessionScope(first)).toBe(false);
		expect(await f.session.restoreTemporaryProviderSessionScope(second)).toBe(true);
		expect(f.session.model).toEqual(f.initial);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.Off);
	});

	for (const change of ["unchanged"]) {
		it(`reports postcommit ${change} with correct selection certainty`, async () => {
			const cancellation = new AbortController();
			const failure = new Error("edit synchronization failed after durable selection");
			let session!: AgentSession;
			const f = await fixture(async () => {
				if (change === "cancel") cancellation.abort();
				else if (change === "thinking") await session.setThinkingLevelForControl(ThinkingLevel.High, false);
				else if (change === "selection") session.markUserModelSelection();
				else if (change === "failure") throw failure;
				return { systemPrompt: ["Rebuilt"] };
			});
			session = f.session;
			let thrown: unknown;
			try {
				await session.setModelTemporary(f.selected, ThinkingLevel.Low, { ...options, signal: cancellation.signal });
			} catch (error) {
				thrown = error;
			}
			if (change === "unchanged") expect(thrown).toBeUndefined();
			else {
				expect(thrown).toBeInstanceOf(Error);
				expect((thrown as Error).message).toContain("Committed shared temporary model edit synchronization failed");
				const evidence = (thrown as Error).cause as { ids: string[]; error: unknown };
				expect(evidence.ids).toEqual([expect.any(String), expect.any(String)]);
				if (change === "failure") expect(evidence.error).toBe(failure);
			}
			expect(session.model).toEqual(f.selected);
			if (change === "thinking") expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(
				(await records(f.file)).filter(entry => entry.type === "model_change" && entry.role === "temporary"),
			).toHaveLength(1);
		});
	}
});
