import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@gajae-code/coding-agent/extensibility/custom-commands";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { PromptActionAutocompleteProvider } from "@gajae-code/coding-agent/modes/prompt-action-autocomplete";
import {
	createSdkComposerObservation,
	isSdkComposerObservationOperation,
	SDK_COMPOSER_LIMITS,
	type SdkComposerObservation,
	SdkComposerObservationError,
} from "@gajae-code/coding-agent/sdk/composer-observation";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@gajae-code/coding-agent/slash-commands/acp-builtins";
import type { AutocompleteItem } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";

interface Suggestions {
	items: AutocompleteItem[];
	prefix: string;
}

function custom(name: string, description = "Project command"): LoadedCustomCommand {
	return {
		path: "command.ts",
		resolvedPath: "/internal/project/command.ts",
		source: "project",
		command: { name, description, execute: () => undefined },
	};
}

function failure(action: () => unknown, code: SdkComposerObservationError["code"]): void {
	try {
		action();
		throw new Error(`Expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(SdkComposerObservationError);
		if (!(error instanceof SdkComposerObservationError)) throw error;
		expect(error.code).toBe(code);
	}
}

describe("SDK composer and HUD observation", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let observation: SdkComposerObservation;
	let commands: LoadedCustomCommand[];
	const restores: Array<() => void> = [];

	beforeEach(async () => {
		dir = TempDir.createSync("sdk-composer-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing fixture model");
		commands = [custom("project-task", "Project\ncommand\x1b[31m description")];
		const skills: Skill[] = [{
			name: "fixture-workflow",
			description: "Fixture workflow",
			filePath: path.join(dir.path(), "SKILL.md"),
			baseDir: dir.path(),
			source: "project",
		}];
		const settings = Settings.isolated({ "skills.enableSkillCommands": true });
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			modelRegistry: new ModelRegistry(auth),
			customCommands: commands,
			skills,
			skillsSettings: settings.getGroup("skills"),
		});
		observation = createSdkComposerObservation(session);
	});

	afterEach(async () => {
		observation.dispose();
		for (const restore of restores.splice(0)) restore();
		await session.dispose();
		auth.close();
		dir.removeSync();
	});

	it("advertises executable SDK builtins and live dynamic commands, never UI-only builtins or internal paths", () => {
		commands.push(custom("model", "Must not shadow builtin"), custom("quit", "Not executable over SDK"), custom("bad\x1bname"));
		const catalog = observation.catalog({});
		const builtins = new Set(ACP_BUILTIN_SLASH_COMMANDS.map(command => command.name));
		expect(catalog.commands.find(command => command.name === "model")).toMatchObject({ source: "builtin" });
		expect(catalog.commands.filter(command => command.source === "builtin").every(command => builtins.has(command.name))).toBe(true);
		expect(catalog.commands.map(command => command.name)).not.toContain("quit");
		expect(catalog.commands.map(command => command.name)).not.toContain("bad\x1bname");
		expect(catalog.commands.find(command => command.name === "project-task")).toEqual({
			name: "project-task", label: "project-task", description: "Project command description", source: "prompt",
		});
		expect(catalog.commands.map(command => command.name)).toContain("skill:fixture-workflow");
		expect(JSON.stringify(catalog)).not.toContain("/internal/project");
		commands.push(custom("later-command"));
		expect(observation.catalog({}).commands.map(command => command.name)).toContain("later-command");
	});

	it("uses the shared engine for slash names, skill aliases, and builtin arguments without executing commands", async () => {
		const execute = spyOn(session, "prompt");
		restores.push(() => execute.mockRestore());
		const project = await observation.complete({ text: "/project-ta", cursor: 11 });
		expect(project.items.find(item => item.value === "project-task")).toMatchObject({ text: "/project-task ", cursor: 14 });
		const skill = await observation.complete({ text: "/fixture-work", cursor: 13 });
		expect(skill.items.find(item => item.value === "skill:fixture-workflow")?.text).toBe("/skill:fixture-workflow ");
		const args = await observation.complete({ text: "/fast st", cursor: 8 });
		expect(args.items.find(item => item.value === "status ")?.text).toBe("/fast status ");
		expect(execute).toHaveBeenCalledTimes(0);
	});

	it("uses real file mention completion and preserves provider replacements for quoted paths", async () => {
		await Bun.write(path.join(dir.path(), "composer evidence.ts"), "fixture");
		const result = await observation.complete({ text: "inspect @composer", cursor: 17 });
		const completion = result.items.find(item => item.value.includes("composer evidence.ts"));
		expect(completion).toBeDefined();
		if (!completion) throw new Error("Missing file completion");
		expect(completion.text).toContain("composer evidence.ts");
		expect(completion.text.startsWith("inspect @")).toBe(true);
		expect(completion.cursor).toBeLessThanOrEqual(completion.text.length);
	});

	it("sanitizes display fields only and uses exact shared-provider draft/cursor output", async () => {
		const item: AutocompleteItem = { value: "raw\tfile name.ts", label: "\x1b[31mFile\nlabel\x1b[0m", description: "details\x1b]0;title\x07\nnext" };
		const suggestions = spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions").mockResolvedValue({ items: [item], prefix: "@ra" });
		restores.push(() => suggestions.mockRestore());
		const text = "first line\ninspect @ra tail";
		const cursor = text.indexOf(" tail");
		const expected = new PromptActionAutocompleteProvider([], dir.path(), []).applyCompletion(text.split("\n"), 1, "inspect @ra".length, item, "@ra");
		const result = await observation.complete({ text, cursor });
		expect(result.items[0]?.value).toBe(item.value);
		expect(result.items[0]?.text).toBe(expected.lines.join("\n"));
		expect(result.items[0]?.cursor).toBe(expected.lines[0]!.length + 1 + expected.cursorCol);
		expect(result.items[0]?.label).toBe("File label");
		expect(result.items[0]?.description).not.toContain("\x1b");
	});

	it("bounds catalog and completion bytes without truncating executable replacement values", async () => {
		for (let index = 0; index < SDK_COMPOSER_LIMITS.commands + 10; index++) commands.push(custom(`bounded-${index}`, "한".repeat(3000)));
		const catalog = observation.catalog({});
		expect(catalog.truncated).toBe(true);
		expect(catalog.commands.length).toBeLessThanOrEqual(SDK_COMPOSER_LIMITS.commands);
		expect(new TextEncoder().encode(JSON.stringify(catalog)).byteLength).toBeLessThanOrEqual(SDK_COMPOSER_LIMITS.responseBytes);
		const items: AutocompleteItem[] = [
			{ value: "x".repeat(SDK_COMPOSER_LIMITS.textChars + 1), label: "Oversized insertion" },
			...Array.from({ length: SDK_COMPOSER_LIMITS.completions + 1 }, (_, index) => ({ value: `project-${index}`, label: "한".repeat(1000) })),
		];
		const suggestions = spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions").mockResolvedValue({ items, prefix: "/pro" });
		restores.push(() => suggestions.mockRestore());
		const result = await observation.complete({ text: "/pro", cursor: 4 });
		expect(result.truncated).toBe(true);
		expect(result.items).toHaveLength(SDK_COMPOSER_LIMITS.completions);
		expect(result.items[0]?.value).toBe("project-0");
		expect(result.items[0]?.label.length).toBeLessThanOrEqual(SDK_COMPOSER_LIMITS.labelChars);
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(SDK_COMPOSER_LIMITS.responseBytes);
	});

	it("rejects malformed cursors, surrogate splits, and unrecognized fields before invoking the provider", async () => {
		const suggestions = spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions");
		restores.push(() => suggestions.mockRestore());
		for (const input of [
			{ text: "/m", cursor: -1 }, { text: "/m", cursor: 3 }, { text: "/m", cursor: 0.5 },
			{ text: "/m", cursor: NaN }, { text: "/m", cursor: Infinity }, { text: "/m", cursor: "2" },
			{ text: "𐐀/m", cursor: 1 }, { text: "/m\0", cursor: 2 },
			{ text: "x".repeat(SDK_COMPOSER_LIMITS.textChars + 1), cursor: 0 },
			{ text: "/m", cursor: 2, cwd: "/other" },
		]) {
			await expect(observation.complete(input)).rejects.toMatchObject({ code: "invalid_input" });
		}
		failure(() => observation.catalog({ extra: true }), "invalid_input");
		failure(() => observation.info({ sessionId: "other" }), "invalid_input");
		expect(suggestions).toHaveBeenCalledTimes(0);
	});

	it("does not use the completion engine for plain prose or UI prompt actions", async () => {
		const suggestions = spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions");
		restores.push(() => suggestions.mockRestore());
		for (const text of ["ordinary prose", "#new", ":smile", ""]) {
			expect((await observation.complete({ text, cursor: text.length })).items).toEqual([]);
		}
		expect(suggestions).toHaveBeenCalledTimes(0);
	});

	it("rejects pending completion results after cwd replacement", async () => {
		const pending = Promise.withResolvers<Suggestions | null>();
		const suggestions = spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions").mockReturnValue(pending.promise);
		restores.push(() => suggestions.mockRestore());
		const completion = observation.complete({ text: "/model", cursor: 6 });
		const cwd = spyOn(session.sessionManager, "getCwd").mockReturnValue(path.join(dir.path(), "successor"));
		restores.push(() => cwd.mockRestore());
		pending.resolve({ items: [{ value: "model", label: "Model" }], prefix: "/model" });
		await expect(completion).rejects.toMatchObject({ code: "stale_session" });
		cwd.mockRestore();
		failure(() => observation.catalog({}), "stale_session");
	});

	it("permanently retires owner references and lifecycle cleanup registrations", async () => {
		const register = spyOn(session, "registerToolSessionTransitionCleanup");
		const bound = createSdkComposerObservation(session);
		const cleanup = register.mock.calls[0]?.[0];
		register.mockRestore();
		if (!cleanup) throw new Error("Missing transition cleanup");
		await cleanup();
		failure(() => bound.catalog({}), "stale_session");
		const original = session.sessionManager;
		const replacement = SessionManager.inMemory(dir.path());
		try {
			session.sessionManager = replacement;
			failure(() => observation.info({}), "stale_session");
		} finally {
			session.sessionManager = original;
			await replacement.close();
		}
		failure(() => observation.info({}), "stale_session");
	});

	it("cancels observation publication on disposal", async () => {
		const pending = Promise.withResolvers<Suggestions | null>();
		const suggestions = spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions").mockReturnValue(pending.promise);
		restores.push(() => suggestions.mockRestore());
		const completion = observation.complete({ text: "/model", cursor: 6 });
		await session.dispose();
		pending.resolve({ items: [{ value: "model", label: "Model" }], prefix: "/model" });
		await expect(completion).rejects.toMatchObject({ code: "disposed" });
		expect(observation.disposed).toBe(true);
	});

	it("maps backend errors to public failures without leaking exception content", async () => {
		const suggestions = spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions").mockRejectedValue(new Error("secret backend detail"));
		restores.push(() => suggestions.mockRestore());
		await expect(observation.complete({ text: "/model", cursor: 6 })).rejects.toMatchObject({ code: "backend_failure", message: "The session completion provider failed." });
	});

	it("represents unavailable thinking selection as null and projects a later selection explicitly", () => {
		let selected: string | undefined;
		Object.defineProperty(session, "thinkingLevel", { configurable: true, get: () => selected });
		try {
			expect(observation.info({}).thinkingLevel).toBeNull();
			selected = "high";
			expect(observation.info({}).thinkingLevel).toBe("high");
		} finally {
			Reflect.deleteProperty(session, "thinkingLevel");
		}
	});

	it("projects live HUD state through session methods without exposing persistence or runtime handles", async () => {
		session.agent.appendMessage({ role: "user", content: "observe", timestamp: 1 });
		await session.sessionManager.setSessionName("Named\nconversation", "user");
		const context = spyOn(session, "getContextUsage").mockReturnValue({ tokens: 123, contextWindow: 200000, percent: 0.0615, source: "provider_anchor" });
		const profile = spyOn(session, "getActiveModelProfile").mockReturnValue("profile\nlabel");
		restores.push(() => context.mockRestore(), () => profile.mockRestore());
		const info = observation.info({});
		expect(info).toMatchObject({
			sessionId: session.sessionId,
			name: "Named conversation",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			modelProfile: "profile label",
			context: { tokens: 123, source: "provider_anchor" },
			stats: { userMessages: 1, totalMessages: 1 },
		});
		expect(context).toHaveBeenCalledTimes(1);
		expect(profile).toHaveBeenCalledTimes(1);
		expect(Object.keys(info)).not.toContain("sessionFile");
		expect(Object.keys(info)).not.toContain("sessionManager");
		expect(isSdkComposerObservationOperation("composer.complete")).toBe(true);
		expect(isSdkComposerObservationOperation("session.info")).toBe(true);
		expect(isSdkComposerObservationOperation("composer.execute")).toBe(false);
	});
});
