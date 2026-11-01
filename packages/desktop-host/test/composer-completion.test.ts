import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import * as slashCommands from "@gajae-code/coding-agent/extensibility/slash-commands";
import { PromptActionAutocompleteProvider } from "@gajae-code/coding-agent/modes/prompt-action-autocomplete";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	completeDesktopDraft,
	DesktopComposerCompletion,
	readDesktopCompletionInput,
} from "../src/composer-completion";
import { DesktopHost } from "../src/host";
import { ManagedSession } from "../src/managed-session";
import {
	type DesktopCommandResult,
	type DesktopCompletionResult,
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	MAX_FRAME_BYTES,
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

async function project() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-completion-")));
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	const cwd = path.join(directory, "project");
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	await Bun.write(path.join(cwd, "src", "hello.ts"), "export const hello = true;\n");
	await Bun.write(path.join(cwd, "space name.txt"), "spaced\n");
	await Bun.write(path.join(cwd, ".gitignore"), "ignored/\n");
	await Bun.write(path.join(cwd, "ignored", "secret-file.ts"), "ignored\n");
	await Bun.write(path.join(cwd, "visible", "secret-file.ts"), "visible\n");
	await Bun.write(
		path.join(cwd, ".gjc", "commands", "desktop-file.md"),
		"---\ndescription: Desktop file command\n---\nExpand desktop fixture: $1\n",
	);
	return { directory, cwd };
}

async function launch(managed = false) {
	const { directory, cwd } = await project();
	const home = path.join(directory, "home");
	await fs.mkdir(home);
	process.env.HOME = home;
	const dataDir = path.join(directory, "app");
	await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
	await Bun.write(
		path.join(cwd, ".gjc", "skills", "desktop-skill", "SKILL.md"),
		"---\nname: desktop-skill\ndescription: Desktop fixture skill\n---\nUse the real project skill.\n",
	);
	const projectId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	if (managed)
		await Bun.write(
			path.join(dataDir, "catalog.json"),
			JSON.stringify({
				version: 1,
				projects: [{ id: projectId, name: "project", path: cwd }],
				sessions: [{ id: sessionId, projectId, title: "Managed", starred: false, managed: true }],
			}),
		);
	const frames: DesktopFrame[] = [];
	const sessions: CreateAgentSessionResult[] = [];
	const host = new DesktopHost({
		dataDir,
		emit: frame => frames.push(frame),
		createSession: async options => {
			options.settings?.set("skills.enablePiProject", true);
			options.settings?.set("skills.enableSkillCommands", true);
			const result = await createAgentSession({
				...options,
				extensions: [
					api => {
						api.on("input", async () => ({ handled: false }));
						api.registerCommand("desktop-extension", {
							description: "Real extension command",
							handler: async () => {},
						});
						api.registerCommand("provider", { description: "Builtin collision", handler: async () => {} });
					},
				],
			});
			sessions.push(result);
			return result;
		},
	});
	cleanups.push(() => host.close());
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (!response || response.type !== "response") throw new Error("Missing response");
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	let session: DesktopSession;
	if (managed)
		session = {
			id: sessionId,
			projectId,
			title: "Managed",
			starred: false,
			status: "idle",
			messages: [],
			controlGeneration: 7,
			imageInput: null,
			operatorRunning: false,
		};
	else {
		const opened = await call<DesktopProject>("project.open", { path: cwd });
		session = await call<DesktopSession>("session.create", { projectId: opened.id });
	}
	const complete = (text: string, cursor = text.length) =>
		call<DesktopCompletionResult>("composer.complete", {
			sessionId: session.id,
			sessionGeneration: session.controlGeneration,
			text,
			cursor,
		});
	return { host, call, complete, frames, sessions, session, cwd };
}

async function expectProviderReplacement(cwd: string, text: string, cursor: number, value: string) {
	const result = await completeDesktopDraft(text, cursor, cwd, [], () => true);
	const actual = result.items.find(item => item.value === value);
	expect(actual).toBeDefined();
	const lines = text.split("\n");
	const preceding = text.slice(0, cursor).split("\n");
	const line = preceding.length - 1;
	const col = preceding[line]!.length;
	const provider = new PromptActionAutocompleteProvider([], cwd, []);
	const suggestions = await provider.getSuggestions(lines, line, col);
	const item = suggestions?.items.find(candidate => candidate.value === value);
	if (!suggestions || !item) throw new Error("Missing public provider fixture suggestion");
	const applied = provider.applyCompletion(lines, line, col, item, suggestions.prefix);
	expect(actual?.text).toBe(applied.lines.join("\n"));
	expect(actual?.cursor).toBe(
		applied.lines.slice(0, applied.cursorLine).reduce((sum, part) => sum + part.length + 1, 0) + applied.cursorCol,
	);
	return actual!;
}

describe("Desktop composer public provider adapter", () => {
	test("completes real project files without sending a prompt", async () => {
		const { complete, sessions } = await launch();
		const prompt = vi.spyOn(sessions[0]!.session, "prompt");
		const result = await complete("Inspect @src/hel");
		expect(result.items.find(item => item.value === "@src/hello.ts")).toMatchObject({
			text: "Inspect @src/hello.ts ",
			cursor: "Inspect @src/hello.ts ".length,
		});
		expect(prompt).not.toHaveBeenCalled();
	});

	test("retains TUI quoting, suffixes, multiline drafts and UTF-16 caret offsets", async () => {
		const { cwd } = await project();
		const spaced = await expectProviderReplacement(cwd, "Read @space", 11, '@"space name.txt"');
		expect(spaced.text).toBe('Read @"space name.txt" ');
		await expectProviderReplacement(cwd, 'Read @"space na', 15, '@"space name.txt"');
		const draft = "😀 first line\nRead @src/hel then keep this\nlast line";
		const cursor = draft.indexOf(" then");
		const item = await expectProviderReplacement(cwd, draft, cursor, "@src/hello.ts");
		expect(item.text).toContain(" then keep this\nlast line");
		expect(item.text.startsWith("😀 first line\n")).toBe(true);
	});

	test("preserves ignored fuzzy versus explicit-prefix semantics of the real provider", async () => {
		const { cwd } = await project();
		const fuzzy = await completeDesktopDraft("@scrfl", 6, cwd, [], () => true);
		expect(fuzzy.items.map(item => item.value)).toContain("@visible/secret-file.ts");
		expect(fuzzy.items.some(item => item.value.startsWith("@ignored/"))).toBe(false);
		const explicit = await completeDesktopDraft("@ignored/sec", 12, cwd, [], () => true);
		expect(explicit.items.map(item => item.value)).toContain("@ignored/secret-file.ts");
	});

	test("does not query the provider or discover commands for ordinary prose", async () => {
		const { complete } = await launch();
		const suggestions = vi.spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions");
		const discovery = vi.spyOn(slashCommands, "loadSlashCommands");
		for (const text of ["ordinary prose", "email@example.com", "some/path/file.ts", "#help", ":smile"])
			expect(await complete(text)).toEqual({ items: [] });
		expect(suggestions).not.toHaveBeenCalled();
		expect(discovery).not.toHaveBeenCalled();
	});

	test("rejects invalid text, offsets and generations before provider work", () => {
		for (const params of [
			{ text: "abc", cursor: -1, sessionGeneration: 0 },
			{ text: "abc", cursor: 4, sessionGeneration: 0 },
			{ text: "abc", cursor: 1.5, sessionGeneration: 0 },
			{ text: "😀", cursor: 1, sessionGeneration: 0 },
			{ text: 3, cursor: 0, sessionGeneration: 0 },
			{ text: "x\0", cursor: 0, sessionGeneration: 0 },
			{ text: "x".repeat(32_001), cursor: 0, sessionGeneration: 0 },
			{ text: "/", cursor: 1, sessionGeneration: null },
			{ text: "/", cursor: 1, sessionGeneration: -1 },
			{ text: "/", cursor: 1, sessionGeneration: 0, extra: true },
		])
			expect(() => readDesktopCompletionInput(params)).toThrow("Invalid completion");
	});

	test("bounds presentation and aggregate size without modifying insertion values", async () => {
		const { cwd } = await project();
		const commands = Array.from({ length: 150 }, (_, index) => ({
			name: `desktop-${index}-${"x".repeat(300)}`,
			description: `description ${"y".repeat(2000)}`,
		}));
		const result = await completeDesktopDraft("/desktop", 8, cwd, commands, () => true);
		expect(result.items).toHaveLength(100);
		expect(result.items.every(item => item.label.length <= 256 && (item.description?.length ?? 0) <= 1024)).toBe(
			true,
		);
		expect(result.items.every(item => item.value.length > 256 && item.text === `/${item.value} `)).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(MAX_FRAME_BYTES);
		const suffix = "\u0001".repeat(31_000);
		const aggregate = await completeDesktopDraft(`/desktop${suffix}`, 8, cwd, commands, () => true);
		expect(aggregate.items.length).toBeGreaterThan(0);
		expect(aggregate.items.length).toBeLessThan(100);
		expect(aggregate.items.every(item => item.text.endsWith(suffix))).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(aggregate)).byteLength).toBeLessThan(MAX_FRAME_BYTES);
		const huge = await completeDesktopDraft("/", 1, cwd, [{ name: "x".repeat(32_000) }], () => true);
		expect(huge.items).toEqual([]);
	});
});

describe("Desktop executable slash catalog", () => {
	test("discovers file commands, SDK skills, bundled priority and real ACP commands", async () => {
		const { complete, sessions } = await launch();
		const sdk = sessions[0]!.session;
		const registration = vi.spyOn(sdk, "setSlashCommands");
		const builtin = await complete("/provider");
		expect(builtin.items.some(item => item.value === "provider")).toBe(true);
		const file = await complete("/desktop-file");
		expect(file.items.find(item => item.value === "desktop-file")?.text).toBe("/desktop-file ");
		expect(registration).toHaveBeenCalledTimes(1);
		const registered = registration.mock.calls[0]![0];
		expect(slashCommands.expandSlashCommand("/desktop-file argument", registered)).toContain(
			"Expand desktop fixture: argument",
		);
		expect(sdk.skills.some(skill => skill.name === "desktop-skill")).toBe(true);
		const skill = await complete("/desktop-skill");
		expect(skill.items.find(item => item.value === "skill:desktop-skill")?.text).toBe("/skill:desktop-skill ");
		const root = await complete("/");
		expect(root.items.some(item => item.value === "btw")).toBe(true);
		expect(root.items.some(item => item.value === "session" || item.value === "move")).toBe(false);
		const priorities = (await complete("/skill:")).items.map(item => item.value);
		expect(priorities).toContain("skill:autoresearch");
		expect(priorities).toContain("skill:desktop-skill");
		expect(priorities.indexOf("skill:autoresearch")).toBeLessThan(priorities.indexOf("skill:desktop-skill"));
		expect((await complete("/desktop-extension")).items.map(item => item.value)).toContain("desktop-extension");
		expect((await complete("/extension:provider")).items.map(item => item.value)).toContain("extension:provider");
	});

	test("reads custom commands through the session getter and preserves skill collisions", async () => {
		const { sessions, cwd } = await launch();
		const sdk = sessions[0]!.session;
		const custom = {
			path: "fixture:custom",
			resolvedPath: "fixture:custom",
			source: "project" as const,
			command: { name: "desktop-skill", description: "Custom command wins the direct name", execute: () => "" },
		};
		const view = {
			skills: sdk.skills,
			settings: sdk.settings,
			model: sdk.model,
			extensionRunner: sdk.extensionRunner,
			get customCommands() {
				return [custom];
			},
			setSlashCommands: (commands: slashCommands.FileSlashCommand[]) => sdk.setSlashCommands(commands),
		};
		const completion = new DesktopComposerCompletion(view, cwd, [], () => true);
		const direct = await completion.complete("/desktop-skill", 14);
		expect(direct.items.find(item => item.value === "desktop-skill")?.description).toContain("Custom command wins");
		const qualified = await completion.complete("/skill:desktop-skill", 20);
		expect(qualified.items.map(item => item.value)).toContain("skill:desktop-skill");
	});

	test("routes a composer builtin through the existing command dispatcher without a provider turn", async () => {
		const { call, complete, session, sessions, frames } = await launch();
		const prompt = vi.spyOn(sessions[0]!.session, "prompt");
		const suggestion = (await complete("/provider")).items.find(item => item.value === "provider");
		expect(suggestion).toBeDefined();
		const output = await call<DesktopCommandResult>("prompt", {
			sessionId: session.id,
			text: `${suggestion!.text}login`,
			sessionGeneration: session.controlGeneration,
		});
		expect(output.consumed).toBe(true);
		expect(output.output).toContain("/login");
		expect(prompt).not.toHaveBeenCalled();
		expect(frames.some(frame => frame.type === "delivery" && frame.receipt.disposition === "completed")).toBe(true);
	});

	test("a forwarded builtin retains accepted-only uncertainty rather than claiming model completion", async () => {
		const { call, session, sessions, frames } = await launch();
		const prompt = vi.spyOn(sessions[0]!.session, "prompt").mockImplementation(async (_text, options) => {
			await options?.onPreflightAcceptCommit?.();
		});
		const result = await call<DesktopCommandResult>("prompt", { sessionId: session.id, text: "/notify on" });
		expect(result.prompt).toBe("/notify on");
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(frames.some(frame => frame.type === "delivery" && frame.receipt.disposition === "accepted")).toBe(true);
		expect(frames.some(frame => frame.type === "delivery" && frame.receipt.disposition === "unknown")).toBe(true);
		expect(frames.some(frame => frame.type === "delivery" && frame.receipt.disposition === "completed")).toBe(false);
	});

	test("refuses attachments on builtin dispatch rather than treating file text as arguments", async () => {
		const { call, session, sessions, frames } = await launch();
		const prompt = vi.spyOn(sessions[0]!.session, "prompt");
		await expect(
			call("prompt", {
				sessionId: session.id,
				text: "/provider login",
				attachments: [{ kind: "text", name: "note.txt", text: "private" }],
			}),
		).rejects.toThrow("cannot be submitted with attachments");
		expect(prompt).not.toHaveBeenCalled();
		expect(frames.some(frame => frame.type === "delivery" && frame.receipt.disposition === "refused")).toBe(true);
	});

	test("refuses old rendered generations", async () => {
		const { call, session } = await launch();
		await expect(
			call("composer.complete", {
				sessionId: session.id,
				sessionGeneration: session.controlGeneration! + 1,
				text: "/",
				cursor: 1,
			}),
		).rejects.toThrow("Session changed");
	});

	test("never registers asynchronous discovery into a retired host identity", async () => {
		const { sessions, host, complete } = await launch();
		const sdk = sessions[0]!.session;
		const pending = Promise.withResolvers<slashCommands.FileSlashCommand[]>();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(slashCommands, "loadSlashCommands").mockImplementation(() => {
			entered.resolve();
			return pending.promise;
		});
		const register = vi.spyOn(sdk, "setSlashCommands");
		const result = complete("/");
		await entered.promise;
		const closing = host.close();
		pending.resolve([{ name: "retired", content: "Must not register", description: "old", source: "project" }]);
		await expect(result).rejects.toThrow("Session changed");
		await closing;
		expect(register).not.toHaveBeenCalled();
	});

	test("fences provider results after asynchronous file discovery", async () => {
		const { cwd } = await project();
		let current = true;
		const pending = Promise.withResolvers<{ items: { value: string; label: string }[]; prefix: string }>();
		vi.spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions").mockReturnValue(pending.promise);
		const result = completeDesktopDraft("@src", 4, cwd, [], () => current);
		current = false;
		pending.resolve({ items: [{ value: "@src/hello.ts", label: "hello.ts" }], prefix: "@src" });
		await expect(result).rejects.toThrow("Session changed");
	});
});

test("managed references expose no invented owner slash catalog or writer and fence @files by reference epoch", async () => {
	let attached = true;
	let generation = 7;
	vi.spyOn(ManagedSession.prototype, "open").mockImplementation(async function (this: ManagedSession) {
		Object.defineProperties(this, {
			isAttached: { get: () => attached },
			controlGeneration: { get: () => (attached ? generation : null) },
		});
	});
	vi.spyOn(ManagedSession.prototype, "refresh").mockResolvedValue(undefined);
	const fixture = await launch(true);
	vi.spyOn(ManagedSession.prototype, "dto").mockReturnValue(fixture.session);
	await fixture.call("session.select", { sessionId: fixture.session.id });
	const slash = await fixture.complete("/provider");
	expect(slash.items).toEqual([]);
	expect(slash.reason).toContain("owner does not expose its command catalog");
	expect(fixture.sessions).toHaveLength(0);
	expect((await fixture.complete("@src/hel")).items.map(item => item.value)).toContain("@src/hello.ts");
	generation++;
	await expect(fixture.complete("@src/hel")).rejects.toThrow("SDK owner changed");
	generation--;
	attached = false;
	await expect(fixture.complete("@src/hel")).rejects.toThrow("SDK owner changed");
	attached = true;
	const pending = Promise.withResolvers<{ items: { value: string; label: string }[]; prefix: string }>();
	const entered = Promise.withResolvers<void>();
	vi.spyOn(PromptActionAutocompleteProvider.prototype, "getSuggestions").mockImplementation(() => {
		entered.resolve();
		return pending.promise;
	});
	const stale = fixture.complete("@src/hel");
	await entered.promise;
	generation++;
	pending.resolve({ items: [{ value: "@src/hello.ts", label: "hello.ts" }], prefix: "@src/hel" });
	await expect(stale).rejects.toThrow("Session changed");
});
