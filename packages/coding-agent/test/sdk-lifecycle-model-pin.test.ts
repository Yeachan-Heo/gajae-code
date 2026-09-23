import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@gajae-code/ai";
import { ModelRegistry, ModelsConfigFile } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { applyStartupModelProfiles } from "../src/main";
import { type CreateLifecycleAgentSessionResult, createLifecycleAgentSession } from "../src/sdk/lifecycle-session";

/**
 * The coordinator model pin (#4707) validates a selector against its own
 * registry and the child resolves it against the registry that actually serves
 * requests. Those two can disagree. These tests pin the seam where that
 * disagreement used to become a silent substitution: construction succeeded
 * with no model, the discarded fallback warning let startup profile
 * application choose `modelProfile.default`/`mpreset` instead, and the
 * coordinator still reported the requested pin.
 */
describe("lifecycle session explicit model pin", () => {
	const createdDirs = new Set<string>();
	let authStorage: AuthStorage;

	const lifecycleOptions = (cwd: string, settings: Settings) => ({
		cwd,
		agentDir: cwd,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage),
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		toolNames: [],
	});

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		// The pin must apply on a credential the CLI would also accept; the issue's
		// evidence is a stored Cursor credential without a usage probe.
		authStorage.setRuntimeApiKey("cursor", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		authStorage.close();
		for (const dir of createdDirs) {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
		createdDirs.clear();
	});

	const tempCwd = (): string => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-model-pin-"));
		createdDirs.add(cwd);
		return cwd;
	};

	test("fails before readiness when the child registry cannot resolve the pin", async () => {
		const cwd = tempCwd();
		// A project-scoped default profile is exactly what would otherwise be
		// activated in the pin's place once construction returned no model.
		const settings = Settings.isolated({ "modelProfile.default": "codex-medium" });
		const created = await createLifecycleAgentSession({
			...lifecycleOptions(cwd, settings),
			modelId: "cursor/model-removed-since-coordinator-validated-it",
		});

		expect("failure" in created).toBe(true);
		if (!("failure" in created)) return;
		expect(created.failure.phase).toBe("registration");
		// The error names the exact pinned selector so the caller can tell a
		// drifted pin apart from an unrelated startup failure.
		expect(created.failure.message).toContain("cursor/model-removed-since-coordinator-validated-it");
		expect(created.failure.message).toContain("--list-models");
		// No session escaped, so startup profile application never runs and no
		// alternate model can activate behind the reported pin.
		expect("session" in created).toBe(false);
	}, 30_000);

	test("keeps the pin as the effective model after default-profile and mpreset processing", async () => {
		const cwd = tempCwd();
		const settings = Settings.isolated();
		const created = await createLifecycleAgentSession({
			...lifecycleOptions(cwd, settings),
			modelId: "cursor/composer-2.5",
		});

		if ("failure" in created) throw new Error(`Lifecycle construction failed: ${created.failure.message}`);
		try {
			expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe("cursor/composer-2.5");

			// The host runs this next. `--model` precedence must survive it: the
			// pin is threaded as `parsedArgs.model`, so an activated profile
			// cannot outrank it.
			await applyStartupModelProfiles({
				session: created.session,
				settings,
				modelRegistry: created.session.modelRegistry,
				parsedArgs: { model: "cursor/composer-2.5" },
			});

			expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe("cursor/composer-2.5");
		} finally {
			await created.session.dispose();
		}
	}, 30_000);

	test("preserves an explicit thinking suffix through lifecycle validation", async () => {
		const cwd = tempCwd();
		const settings = Settings.isolated();
		const created = await createLifecycleAgentSession({
			...lifecycleOptions(cwd, settings),
			modelId: "anthropic/claude-sonnet-4-5:high",
		});

		if ("failure" in created) throw new Error(`Lifecycle construction failed: ${created.failure.message}`);
		try {
			expect(`${created.session.model?.provider}/${created.session.model?.id}`).toBe("anthropic/claude-sonnet-4-5");
			expect(String(created.session.thinkingLevel)).toBe("high");
			await applyStartupModelProfiles({
				session: created.session,
				settings,
				modelRegistry: created.session.modelRegistry,
				parsedArgs: { model: "anthropic/claude-sonnet-4-5:high" },
				startupThinkingLevel: "high" as never,
			});
			expect(String(created.session.thinkingLevel)).toBe("high");
		} finally {
			await created.session.dispose();
		}
	}, 30_000);

	test("refreshes a discovery-only configured default before fresh lifecycle admission", async () => {
		const cwd = tempCwd();
		const provider = "lifecycle-discovery-provider";
		const modelId = "discovered-default-model";
		const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
		const server = http.createServer((request, response) => {
			requests.push({ url: request.url, authorization: request.headers.authorization });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: modelId }] }));
		});
		const listening = Promise.withResolvers<void>();
		server.once("listening", listening.resolve);
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1");
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Discovery server address unavailable");

		const modelsPath = path.join(cwd, "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				`  ${provider}:`,
				`    baseUrl: http://127.0.0.1:${address.port}/v1`,
				"    api: openai-completions",
				"    auth: none",
				"    discovery:",
				"      type: openai-models-list",
				"    models: []",
				"",
			].join("\n"),
		);
		const originalRelocate = ModelsConfigFile.relocate.bind(ModelsConfigFile);
		const relocateSpy = vi
			.spyOn(ModelsConfigFile, "relocate")
			.mockImplementation(configPath => originalRelocate(configPath ?? modelsPath));
		const backgroundRefreshSpy = vi
			.spyOn(ModelRegistry.prototype, "refreshInBackground")
			.mockImplementation(() => {});
		const settings = Settings.isolated({ modelRoles: { default: `${provider}/${modelId}` } });
		let created: CreateLifecycleAgentSessionResult | undefined;
		let explicit: CreateLifecycleAgentSessionResult | undefined;
		try {
			created = await createLifecycleAgentSession({
				cwd,
				agentDir: cwd,
				authStorage,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				toolNames: [],
			});
			if ("failure" in created) throw new Error(`Lifecycle construction failed: ${created.failure.message}`);

			expect(created.session.model).toMatchObject({ provider, id: modelId });
			expect(requests).toEqual([{ url: "/v1/models", authorization: undefined }]);

			explicit = await createLifecycleAgentSession({
				cwd,
				agentDir: cwd,
				authStorage,
				modelRegistry: created.session.modelRegistry,
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				toolNames: [],
				modelId: `${provider}/${modelId}`,
			});
			if ("failure" in explicit)
				throw new Error(`Explicit lifecycle construction failed: ${explicit.failure.message}`);
			expect(explicit.session.model).toMatchObject({ provider, id: modelId });
		} finally {
			if (explicit && !("failure" in explicit)) await explicit.session.dispose();
			if (created && !("failure" in created)) await created.session.dispose();
			backgroundRefreshSpy.mockRestore();
			relocateSpy.mockRestore();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	}, 30_000);
});
