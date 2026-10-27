import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { getKeybindings, setKeybindings } from "@gajae-code/tui";
import { getDefaultTabWidth, setDefaultTabWidth, TempDir } from "@gajae-code/utils";
import { enqueueAtomicYamlOperation } from "../src/config/atomic-yaml-patch";
import { KeybindingsManager } from "../src/config/keybindings";
import { ModelRegistry } from "../src/config/model-registry";
import {
	onAppendOnlyModeChanged,
	resetSettingsForTest,
	Settings,
	type SettingsAtomicPatch,
} from "../src/config/settings";
import { SettingsSelectorComponent } from "../src/modes/components/settings-selector";
import { initTheme } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const sampling = {
	temperature: 0.35,
	topP: 0.8,
	topK: 24,
	minP: 0.1,
	presencePenalty: 0.4,
	repetitionPenalty: 1.2,
} as const;

const wireSampling = {
	temperature: 0.35,
	top_p: 0.8,
	top_k: 24,
	min_p: 0.1,
	presence_penalty: 0.4,
	repetition_penalty: 1.2,
};

/** Capture the real provider serializer/HTTP boundary, not Agent property readback. */
function captureRequests(requests: Record<string, unknown>[]): typeof fetch {
	async function capture(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		requests.push((await request.json()) as Record<string, unknown>);
		return new Response(
			`data: ${JSON.stringify({
				id: "sampling-fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: "gpt-4o-mini",
				choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	}
	return Object.assign(capture, { preconnect: fetch.preconnect });
}

describe("AgentSession live sampling settings", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession | undefined;
	let settings: Settings;
	let requests: Record<string, unknown>[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-live-sampling-");
		auth = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		auth.setRuntimeApiKey("openai", "fixture-key");
		session = undefined;
		requests = [];
	});

	afterEach(async () => {
		await session?.dispose();
		await settings?.close();
		auth.close();
		tempDir.removeSync();
	});

	function buildSession(): AgentSession {
		const model = getBundledModel<"openai-completions">("openai", "gpt-4o-mini");
		const agent = new Agent({
			getApiKey: () => "fixture-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (_model, context, options) =>
				streamOpenAICompletions(model, context, { ...options, fetch: captureRequests(requests) }),
		});
		return new AgentSession({
			agent,
			agentDir: path.join(tempDir.path(), "agent"),
			settings,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: new ModelRegistry(auth, path.join(tempDir.path(), "agent", "models.yml"), settings),
		});
	}

	async function request(): Promise<Record<string, unknown>> {
		await session!.prompt("Report the sampling fixture.");
		await session!.waitForIdle();
		return requests.at(-1)!;
	}

	it("applies ordinary setting changes to the next provider payload and clears sentinels", async () => {
		settings = Settings.isolated({ "compaction.enabled": false });
		session = buildSession();
		for (const [key, value] of Object.entries(sampling)) settings.set(key as keyof typeof sampling, value);
		expect(await request()).toMatchObject(wireSampling);

		for (const key of Object.keys(sampling) as Array<keyof typeof sampling>) settings.set(key, -1);
		const cleared = await request();
		for (const key of Object.keys(wireSampling)) expect(cleared).not.toHaveProperty(key);
		expect(requests).toHaveLength(2);
	});

	it("applies unset fallback and detaches observation on dispose", async () => {
		settings = Settings.isolated({ "compaction.enabled": false });
		session = buildSession();
		settings.set("temperature", 0);
		expect(await request()).toHaveProperty("temperature", 0);
		settings.unset("temperature");
		expect(await request()).not.toHaveProperty("temperature");
		await session.dispose();
		settings.set("temperature", 0.9);
		expect(session.agent.temperature).toBeUndefined();
	});

	it("applies and clears runtime overrides without bypassing their precedence", async () => {
		settings = Settings.isolated({ "compaction.enabled": false });
		session = buildSession();
		settings.override("temperature", 0.9);
		expect(await request()).toHaveProperty("temperature", 0.9);
		settings.set("temperature", 0.3);
		expect(await request()).toHaveProperty("temperature", 0.9);
		settings.clearOverride("temperature");
		expect(await request()).toHaveProperty("temperature", 0.3);
	});

	it("applies a scoped TUI sampling selection to its session's next provider request", async () => {
		resetSettingsForTest();
		const global = await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			agentDir: path.join(tempDir.path(), "global-agent"),
		});
		global.set("temperature", 1);
		const previousKeybindings = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		let selector: SettingsSelectorComponent | undefined;
		try {
			await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
			settings = Settings.isolated({ "compaction.enabled": false, temperature: 0.2 });
			session = buildSession();
			selector = new SettingsSelectorComponent(
				{
					settings,
					cwd: tempDir.path(),
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["red-claw", "blue-crab"],
					availableModelProfiles: [],
				},
				{ onChange: () => {}, onCancel: () => {} },
			);
			selector.handleInput("\x1b[C");
			for (const character of "temperature") selector.handleInput(character);
			selector.handleInput("\n");
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			expect(await request()).toHaveProperty("temperature", 0.5);
			expect(global.get("temperature")).toBe(1);
		} finally {
			selector?.dispose();
			setKeybindings(previousKeybindings);
			resetSettingsForTest();
		}
	});

	it("publishes externally rebased sampling when saving an unrelated setting", async () => {
		const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
		settings = await Settings.loadForScope(scope);
		settings.set("compaction.enabled", false);
		session = buildSession();
		settings.set("temperature", 0.2);
		await settings.flushOrThrow();
		expect(await request()).toHaveProperty("temperature", 0.2);
		const other = await Settings.loadForScope(scope);
		try {
			other.set("temperature", 0.8);
			await other.flushOrThrow();
			settings.set("topK", 24);
			await settings.flushOrThrow();
			expect(settings.get("temperature")).toBe(0.8);
			expect(await request()).toMatchObject({ temperature: 0.8, top_k: 24 });
		} finally {
			await other.close();
		}
	});

	it("does not run process-global display hooks for runtime overrides", () => {
		settings = Settings.isolated();
		const original = getDefaultTabWidth();
		const width = original === 2 ? 3 : 2;
		try {
			settings.override("display.tabWidth", width);
			expect(settings.get("display.tabWidth")).toBe(width);
			expect(getDefaultTabWidth()).toBe(original);
			settings.clearOverride("display.tabWidth");
			expect(getDefaultTabWidth()).toBe(original);
		} finally {
			setDefaultTabWidth(original);
		}
	});

	for (const updates of [[0.25], [0.75, 0.25]]) {
		it(`rejects an older restore after another owner writes ${updates.join("/")}`, async () => {
			const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
			settings = await Settings.loadForScope(scope);
			settings.set("compaction.enabled", false);
			session = buildSession();
			const receipt = await settings.commitAtomicBatch([{ path: "temperature", op: "set", value: 0.25 }]);
			const other = await Settings.loadForScope(scope);
			try {
				for (const value of updates) {
					other.set("temperature", value);
					await other.flushOrThrow();
				}
				expect((await receipt.restore()).status).toBe("conflict");
				expect(await request()).toHaveProperty("temperature", 0.25);
				expect((await Settings.loadReadonly(scope)).get("temperature")).toBe(0.25);
				expect(other.get("temperature")).toBe(0.25);
			} finally {
				await other.close();
			}
		});
	}

	for (const durable of [false, true]) {
		for (const updates of [["openai/gpt-4o-mini"], ["other/model", "openai/gpt-4o-mini"]]) {
			it(`fences an atomic model leaf against newer parent role writes ${updates.join("/")} (${durable ? "disk" : "memory"})`, async () => {
				const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
				settings = durable ? await Settings.loadForScope(scope) : Settings.isolated();
				const receipt = await settings.commitAtomicBatch([
					{ path: "modelRoles.default", op: "set", value: "openai/gpt-4o-mini" },
				]);
				for (const value of updates) settings.setModelRole("default", value);
				await settings.flushOrThrow();
				expect((await receipt.restore()).status).toBe("conflict");
				expect(settings.getModelRole("default")).toBe("openai/gpt-4o-mini");
				if (durable)
					expect((await Settings.loadReadonly(scope)).getModelRole("default")).toBe("openai/gpt-4o-mini");
			});
		}
	}

	for (const durable of [false, true]) {
		it(`preserves an unrelated role when restoring the default model (${durable ? "disk" : "memory"})`, async () => {
			const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
			settings = durable ? await Settings.loadForScope(scope) : Settings.isolated();
			const receipt = await settings.commitAtomicBatch([
				{ path: "modelRoles.default", op: "set", value: "openai/gpt-4o-mini" },
			]);
			settings.setModelRole("smol", "other/model");
			await settings.flushOrThrow();
			expect((await receipt.restore()).status).toBe("restored");
			expect(settings.getModelRole("smol")).toBe("other/model");
			if (durable) expect((await Settings.loadReadonly(scope)).getModelRole("smol")).toBe("other/model");
		});
	}

	for (const durable of [false, true]) {
		for (const withCurrent of [false, true]) {
			it(`rejects overlapping atomic paths before publication (${durable ? "disk" : "memory"}, ${withCurrent ? "current" : "direct"})`, async () => {
				const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
				settings = durable ? await Settings.loadForScope(scope) : Settings.isolated();
				settings.setModelRole("default", "before/model");
				await settings.flushOrThrow();
				const before = structuredClone(settings.get("modelRoles"));
				const configPath = settings.getGlobalConfigPath();
				const diskBefore = configPath ? { path: configPath, text: await Bun.file(configPath).text() } : undefined;
				const changes: string[] = [];
				const unsubscribe = settings.onChanged(settingPath => changes.push(settingPath));
				const patches: SettingsAtomicPatch[] = [
					{ path: "modelRoles", op: "set", value: { default: "after/model", smol: "new/model" } },
					{ path: "modelRoles.default", op: "set", value: "final/model" },
				];
				try {
					for (const ordered of [patches, [...patches].reverse()]) {
						const commit = withCurrent
							? settings.commitAtomicBatchWithCurrent(() => ordered)
							: settings.commitAtomicBatch(ordered);
						await expect(commit).rejects.toThrow("overlapping paths");
						expect(settings.get("modelRoles")).toEqual(before);
						expect(changes).toEqual([]);
						if (diskBefore) expect(await Bun.file(diskBefore.path).text()).toBe(diskBefore.text);
					}
				} finally {
					unsubscribe();
				}
			});
		}
	}

	it("keeps live sampling after bounded child cleanup", async () => {
		settings = Settings.isolated({ "compaction.enabled": false });
		session = buildSession();
		await session.disposeChildSubprocesses();
		settings.set("temperature", 0.45);
		expect(await request()).toHaveProperty("temperature", 0.45);
	});

	it("uses project sampling ahead of global writes and below runtime overrides", async () => {
		await Bun.write(path.join(tempDir.path(), ".gjc", "config.yml"), "temperature: 0.65\n");
		settings = await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") });
		settings.set("compaction.enabled", false);
		expect(settings.get("temperature")).toBe(0.65);
		session = buildSession();
		settings.set("temperature", 0.3);
		expect(await request()).toHaveProperty("temperature", 0.65);
		settings.override("temperature", 0.9);
		expect(await request()).toHaveProperty("temperature", 0.9);
		settings.clearOverride("temperature");
		expect(await request()).toHaveProperty("temperature", 0.65);
	});

	it("rechecks local revisions after a restore waits in the config queue", async () => {
		settings = await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") });
		settings.set("compaction.enabled", false);
		session = buildSession();
		const receipt = await settings.commitAtomicBatch([{ path: "temperature", op: "set", value: 0.25 }]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = enqueueAtomicYamlOperation(settings.getGlobalConfigPath()!, async () => {
			entered.resolve();
			await release.promise;
		});
		let restore: Promise<unknown> | undefined;
		try {
			await entered.promise;
			restore = receipt.restore();
			settings.set("temperature", 0.25);
			release.resolve();
			expect(await restore).toMatchObject({ status: "conflict", paths: ["temperature"] });
			await settings.flushOrThrow();
			expect(await request()).toHaveProperty("temperature", 0.25);
		} finally {
			release.resolve();
			await blocker;
			await restore;
		}
	});

	it("does not let an earlier ordinary observer strand set or unset application", async () => {
		settings = Settings.isolated({ "compaction.enabled": false });
		const unsubscribe = settings.onChanged(() => {
			throw new Error("observer fixture failure");
		});
		try {
			session = buildSession();
			settings.set("temperature", 0.5);
			expect(await request()).toHaveProperty("temperature", 0.5);
			settings.unset("temperature");
			expect(await request()).not.toHaveProperty("temperature");
		} finally {
			unsubscribe();
		}
	});

	for (const durable of [false, true]) {
		it(`publishes a complete sampling snapshot before reentrant observers (${durable ? "disk" : "memory"})`, async () => {
			settings = durable
				? await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") })
				: Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			let run: Promise<void> | undefined;
			const unsubscribe = settings.onChanged(settingPath => {
				if (settingPath === "temperature") run = session!.agent.prompt("Reentrant settings observer");
			});
			try {
				session = buildSession();
				const receipt = await settings.commitAtomicBatch([
					{ path: "temperature", op: "set", value: 0.35 },
					{ path: "topP", op: "set", value: 0.8 },
				]);
				await run;
				await session.waitForIdle();
				expect(requests[0]).toMatchObject({ temperature: 0.35, top_p: 0.8 });
				expect((await receipt.restore()).status).toBe("restored");
				await run;
				await session.waitForIdle();
				expect(requests[1]).not.toHaveProperty("temperature");
				expect(requests[1]).not.toHaveProperty("top_p");
				expect(requests).toHaveLength(2);
			} finally {
				unsubscribe();
				await run;
			}
		});

		it(`preserves receipts and sampling when an append-only hook subscriber throws (${durable ? "disk" : "memory"})`, async () => {
			settings = durable
				? await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") })
				: Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			const unsubscribeFailure = onAppendOnlyModeChanged(() => {
				throw new Error("hook fixture failure");
			});
			const modes: string[] = [];
			const unsubscribe = onAppendOnlyModeChanged(mode => modes.push(mode));
			try {
				session = buildSession();
				const receipt = await settings.commitAtomicBatch([
					{ path: "provider.appendOnlyContext", op: "set", value: "off" },
					{ path: "temperature", op: "set", value: 0.25 },
				]);
				expect(await request()).toHaveProperty("temperature", 0.25);
				expect((await receipt.restore()).status).toBe("restored");
				expect(await request()).not.toHaveProperty("temperature");
				expect(modes).toEqual(["off", "auto"]);
			} finally {
				unsubscribeFailure();
				unsubscribe();
			}
		});

		for (const updates of [[0.25], [0.75, 0.25]]) {
			it(`rejects same-value or ABA local restore after ${updates.join("/")} (${durable ? "disk" : "memory"})`, async () => {
				const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
				settings = durable
					? await Settings.loadForScope(scope)
					: Settings.isolated({ "compaction.enabled": false });
				settings.set("compaction.enabled", false);
				session = buildSession();
				const receipt = await settings.commitAtomicBatch([{ path: "temperature", op: "set", value: 0.25 }]);
				for (const value of updates) settings.set("temperature", value);
				await settings.flushOrThrow();
				expect((await receipt.restore()).status).toBe("conflict");
				expect(await request()).toHaveProperty("temperature", 0.25);
				if (durable) expect((await Settings.loadReadonly(scope)).get("temperature")).toBe(0.25);
			});
		}

		it(`applies an atomic batch and CAS restore to provider payloads (${durable ? "disk" : "memory"})`, async () => {
			const scope = { cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") };
			settings = durable ? await Settings.loadForScope(scope) : Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			session = buildSession();
			const receipt = await settings.commitAtomicBatch(
				(Object.keys(sampling) as Array<keyof typeof sampling>).map(key => ({
					path: key,
					op: "set" as const,
					value: sampling[key],
				})),
			);
			expect(await request()).toMatchObject(wireSampling);
			if (durable) {
				const readback = await Settings.loadReadonly(scope);
				for (const key of Object.keys(sampling) as Array<keyof typeof sampling>) {
					expect(readback.get(key)).toBe(sampling[key]);
				}
			}
			expect((await receipt.restore()).status).toBe("restored");
			const restored = await request();
			for (const key of Object.keys(wireSampling)) expect(restored).not.toHaveProperty(key);
			expect(requests).toHaveLength(2);
		});

		it(`keeps atomic receipts and live application when an observer throws (${durable ? "disk" : "memory"})`, async () => {
			settings = durable
				? await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") })
				: Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			const unsubscribe = settings.onChanged(() => {
				throw new Error("observer fixture failure");
			});
			try {
				session = buildSession();
				const receipt = await settings.commitAtomicBatch([{ path: "temperature", op: "set", value: 0.25 }]);
				expect(await request()).toHaveProperty("temperature", 0.25);
				expect((await receipt.restore()).status).toBe("restored");
				expect(await request()).not.toHaveProperty("temperature");
			} finally {
				unsubscribe();
			}
		});

		it(`preserves a newer sampling write when CAS restore conflicts (${durable ? "disk" : "memory"})`, async () => {
			settings = durable
				? await Settings.loadForScope({ cwd: tempDir.path(), agentDir: path.join(tempDir.path(), "agent") })
				: Settings.isolated({ "compaction.enabled": false });
			settings.set("compaction.enabled", false);
			session = buildSession();
			const receipt = await settings.commitAtomicBatch([{ path: "temperature", op: "set", value: 0.25 }]);
			settings.set("temperature", 0.75);
			await settings.flushOrThrow();
			expect((await receipt.restore()).status).toBe("conflict");
			expect(await request()).toHaveProperty("temperature", 0.75);
		});
	}
});
