import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { closeModelCache, type Model } from "@gajae-code/ai";
import { getAgentDbPath, getAgentDir, hookFetch, setAgentDir, TempDir } from "@gajae-code/utils";
import type { Args } from "../src/cli/args";
import { ModelRegistry, ModelsConfigFile } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { runRootCommand } from "../src/main";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";

// `gjc -p --credential <pin> --model <discovered model>` must run the requested
// model on the pinned OAuth account. The literal-API-key cache guard used to
// reject every discovered-only model under a hard pin, so the CLI silently ran
// the configured default instead (or failed for an unqualified `id:N` pin).

const DISCOVERED_MODEL = "claude-pin-only";
const CONFIGURED_DEFAULT = "anthropic/claude-sonnet-4-5";
const OTHER_ACCESS = "other-account-access";
const PINNED_ACCESS = "pinned-account-access";
const REFRESHED_PINNED_ACCESS = "pinned-account-refreshed-access";

interface RootRun {
	createdModel: Model | undefined;
	fallbackMessage: string | undefined;
	printedModel: Model | undefined;
	pinnedApiKey: string | undefined;
	sessionsCreated: number;
}

function rootArgs(overrides: Partial<Args>): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		noSession: true,
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
		mode: "text",
		...overrides,
	};
}

describe("CLI --credential with an explicit --model", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let authStorage: AuthStorage;
	let otherRowId: number;
	let pinnedRowId: number;
	let discoveryTokens: string[];
	let refreshedTokens: string[];
	let runBackgroundRefresh: boolean;
	let backgroundRefreshes: Promise<void>[];
	let restoreBackgroundRefresh: (() => void) | undefined;
	let restoreFetch: (() => void) | undefined;
	let restoreRelocate: (() => void) | undefined;
	const originalAgentDir = getAgentDir();

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-cli-credential-pin-model-");
		agentDir = path.join(tempDir.path(), "agent");
		const modelsPath = path.join(agentDir, "models.yml");
		await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
		setAgentDir(agentDir);
		const originalRelocate = ModelsConfigFile.relocate.bind(ModelsConfigFile);
		const isolatedModelsConfig = originalRelocate(modelsPath);
		const relocateSpy = vi
			.spyOn(ModelsConfigFile, "relocate")
			.mockImplementation(requestedPath =>
				requestedPath === undefined ? isolatedModelsConfig : originalRelocate(requestedPath),
			);
		restoreRelocate = () => relocateSpy.mockRestore();

		// Background catalog refreshes are either skipped (root runs: the process
		// would exit) or run and settled before teardown (SDK-owned startup).
		runBackgroundRefresh = false;
		backgroundRefreshes = [];
		const originalRefresh = ModelRegistry.prototype.refresh;
		const backgroundSpy = vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(function (
			this: ModelRegistry,
			strategy,
			credentialSessionId,
		) {
			if (!runBackgroundRefresh) return;
			backgroundRefreshes.push(originalRefresh.call(this, strategy, credentialSessionId).catch(() => {}));
		});
		restoreBackgroundRefresh = () => backgroundSpy.mockRestore();

		authStorage = await AuthStorage.create(getAgentDbPath(agentDir));
		await authStorage.set("anthropic", [
			{ type: "oauth", access: OTHER_ACCESS, refresh: "other-refresh", expires: Date.now() + 3_600_000 },
			{ type: "oauth", access: PINNED_ACCESS, refresh: "pinned-refresh", expires: Date.now() + 3_600_000 },
		]);
		const rows = authStorage.listCredentialInventory("anthropic");
		otherRowId = rows[0]!.id;
		pinnedRowId = rows[1]!.id;

		// Only the pinned account can see the discovered model, so a discovery
		// answered by the other account would leave the target unresolved.
		discoveryTokens = [];
		refreshedTokens = [];
		const hook = hookFetch((input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
				refreshedTokens.push(body.refresh_token ?? "");
				if (body.refresh_token !== "pinned-refresh") return new Response("invalid_grant", { status: 400 });
				return new Response(
					JSON.stringify({
						access_token: REFRESHED_PINNED_ACCESS,
						refresh_token: "pinned-refresh-2",
						expires_in: 3600,
						token_type: "Bearer",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (!url.startsWith("https://api.anthropic.com/") || !new URL(url).pathname.endsWith("/models")) {
				return new Response("unexpected request", { status: 500 });
			}
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const token = (headers.get("authorization") ?? headers.get("x-api-key") ?? "").replace(/^Bearer\s+/i, "");
			discoveryTokens.push(token);
			const data =
				token === PINNED_ACCESS || token === REFRESHED_PINNED_ACCESS
					? [{ id: DISCOVERED_MODEL, type: "model" }]
					: [];
			return new Response(JSON.stringify({ data, has_more: false }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		restoreFetch = () => hook[Symbol.dispose]();
	});

	afterEach(async () => {
		await Promise.allSettled(backgroundRefreshes);
		restoreBackgroundRefresh?.();
		restoreFetch?.();
		restoreRelocate?.();
		authStorage.close();
		closeModelCache(path.join(agentDir, "models.db"));
		closeModelCache();
		setAgentDir(originalAgentDir);
		resetSettingsForTest();
		tempDir.removeSync();
	});

	async function runRoot(args: Partial<Args>): Promise<RootRun> {
		const run: RootRun = {
			createdModel: undefined,
			fallbackMessage: undefined,
			printedModel: undefined,
			pinnedApiKey: undefined,
			sessionsCreated: 0,
		};
		await runRootCommand(rootArgs(args), [], {
			createAgentSession: async (options = {}): Promise<CreateAgentSessionResult> => {
				const result = await createAgentSession(options);
				run.sessionsCreated += 1;
				run.createdModel = result.session.model;
				run.fallbackMessage = result.modelFallbackMessage;
				if (!result.session.model) {
					// Keep the root command off its process.exit path; the assertions
					// below already fail on the missing model.
					await result.session.dispose();
					throw new Error(`no model resolved: ${result.modelFallbackMessage ?? "(no message)"}`);
				}
				return result;
			},
			discoverAuthStorage: async () => authStorage,
			settings: configuredSettings(),
			suppressProcessExit: true,
			initTheme: async () => {},
			readPipedInput: async () => undefined,
			runStartupCredentialAutoImportIfNeeded: async () => undefined,
			runPrintMode: async session => {
				run.printedModel = session.model;
				if (session.model) {
					run.pinnedApiKey = await session.modelRegistry.getApiKey(session.model, session.credentialSessionId);
				}
				await session.dispose();
			},
			quit: async () => {},
		});
		return run;
	}

	// A configured default model is what silently replaced the requested one.
	function configuredSettings(): Settings {
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false });
		settings.setModelRole("default", CONFIGURED_DEFAULT);
		return settings;
	}

	it("runs a provider-qualified pin on the explicit discovered model", async () => {
		const run = await runRoot({
			credential: `anthropic/id:${pinnedRowId}`,
			model: `anthropic/${DISCOVERED_MODEL}`,
		});

		expect(run.fallbackMessage).toBeUndefined();
		expect(run.createdModel).toMatchObject({ provider: "anthropic", id: DISCOVERED_MODEL });
		expect(run.printedModel).toMatchObject({ provider: "anthropic", id: DISCOVERED_MODEL });
		expect(run.pinnedApiKey).toBe(PINNED_ACCESS);
		expect(discoveryTokens.length).toBeGreaterThan(0);
		expect(discoveryTokens).not.toContain(OTHER_ACCESS);
	});

	it("takes an unqualified id pin's provider from the qualified --model", async () => {
		const run = await runRoot({
			credential: `id:${pinnedRowId}`,
			model: `anthropic/${DISCOVERED_MODEL}`,
		});

		expect(run.fallbackMessage).toBeUndefined();
		expect(run.printedModel).toMatchObject({ provider: "anthropic", id: DISCOVERED_MODEL });
		expect(run.pinnedApiKey).toBe(PINNED_ACCESS);
		expect(discoveryTokens).not.toContain(OTHER_ACCESS);
	});

	it("takes an unqualified --model's provider from a qualified pin", async () => {
		const run = await runRoot({
			credential: `anthropic/id:${pinnedRowId}`,
			model: DISCOVERED_MODEL,
		});

		expect(run.printedModel).toMatchObject({ provider: "anthropic", id: DISCOVERED_MODEL });
		expect(run.pinnedApiKey).toBe(PINNED_ACCESS);
		expect(discoveryTokens).not.toContain(OTHER_ACCESS);
	});

	it("refreshes an expired pinned token before discovering the explicit model", async () => {
		await authStorage.set("anthropic", [
			{ type: "oauth", access: OTHER_ACCESS, refresh: "other-refresh", expires: Date.now() + 3_600_000 },
			{ type: "oauth", access: PINNED_ACCESS, refresh: "pinned-refresh", expires: Date.now() - 60_000 },
		]);
		const activeRows = authStorage.listCredentialInventory("anthropic").filter(row => !row.disabled);
		expect(activeRows).toHaveLength(2);
		const expiredRowId = activeRows[1]!.id;

		const run = await runRoot({
			credential: `id:${expiredRowId}`,
			model: `anthropic/${DISCOVERED_MODEL}`,
		});

		expect(run.fallbackMessage).toBeUndefined();
		expect(run.printedModel).toMatchObject({ provider: "anthropic", id: DISCOVERED_MODEL });
		expect(refreshedTokens).toEqual(["pinned-refresh"]);
		expect(discoveryTokens).toContain(REFRESHED_PINNED_ACCESS);
		expect(discoveryTokens).not.toContain(OTHER_ACCESS);
		expect(run.pinnedApiKey).toBe(REFRESHED_PINNED_ACCESS);
	});

	it("does not fall back to another account when the expired pinned token cannot refresh", async () => {
		await authStorage.set("anthropic", [
			{ type: "oauth", access: OTHER_ACCESS, refresh: "other-refresh", expires: Date.now() + 3_600_000 },
			{ type: "oauth", access: PINNED_ACCESS, refresh: "revoked-refresh", expires: Date.now() - 60_000 },
		]);
		const activeRows = authStorage.listCredentialInventory("anthropic").filter(row => !row.disabled);
		const expiredRowId = activeRows[1]!.id;

		await expect(
			runRoot({ credential: `anthropic/id:${expiredRowId}`, model: `anthropic/${DISCOVERED_MODEL}` }),
		).rejects.toThrow(`Model "anthropic/${DISCOVERED_MODEL}" not found`);
		expect(refreshedTokens).not.toContain("other-refresh");
		expect(discoveryTokens).not.toContain(OTHER_ACCESS);
	});

	it("installs an unqualified pin before SDK-owned startup discovery", async () => {
		runBackgroundRefresh = true;
		const root = tempDir.path();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: root,
			agentDir,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			workspaceTree: { rootPath: root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames: [],
			rules: [],
			modelPattern: `anthropic/${DISCOVERED_MODEL}`,
			credentialSelector: { selector: { kind: "id", value: String(pinnedRowId) }, raw: `id:${pinnedRowId}` },
		});
		try {
			await Promise.allSettled(backgroundRefreshes);
			expect(backgroundRefreshes.length).toBeGreaterThan(0);
			expect(modelFallbackMessage).toBeUndefined();
			expect(session.model).toMatchObject({ provider: "anthropic", id: DISCOVERED_MODEL });
			expect(discoveryTokens).toContain(PINNED_ACCESS);
			expect(discoveryTokens).not.toContain(OTHER_ACCESS);
		} finally {
			await session.dispose();
		}
	});

	it("fails a missing pinned credential instead of using another account", async () => {
		const missingId = Math.max(otherRowId, pinnedRowId) + 100;

		await expect(
			runRoot({ credential: `anthropic/id:${missingId}`, model: `anthropic/${DISCOVERED_MODEL}` }),
		).rejects.toThrow(`No credential found for anthropic matching id:${missingId}`);
		expect(discoveryTokens).toEqual([]);
	});

	it("keeps pinning the account when no --model is given", async () => {
		const run = await runRoot({ credential: `anthropic/id:${pinnedRowId}` });

		expect(run.printedModel?.provider).toBe("anthropic");
		expect(run.pinnedApiKey).toBe(PINNED_ACCESS);
		expect(discoveryTokens).not.toContain(OTHER_ACCESS);
	});
});
