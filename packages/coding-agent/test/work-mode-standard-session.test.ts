import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { ScopedConfigurationMutationService } from "../src/config/scoped-configuration-mutation";
import { createAgentSession } from "../src/sdk/session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: Array<{ dispose: () => Promise<void>; authStorage: AuthStorage }> = [];

afterEach(async () => {
	while (sessions.length > 0) {
		const current = sessions.pop();
		if (!current) continue;
		await current.dispose();
		current.authStorage.close();
	}
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) await fs.rm(root, { recursive: true, force: true });
	}
});

describe("standard AgentSession Work Mode composition", () => {
	test("uses the repository-root project target, reloads durable scopes, and rejects managed writes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-work-mode-standard-"));
		roots.push(root);
		const repoRoot = path.join(root, "repo");
		const nestedCwd = path.join(repoRoot, "packages", "app");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(path.join(repoRoot, ".gjc"), { recursive: true });
		await fs.mkdir(path.join(nestedCwd, ".gjc"), { recursive: true });
		await Bun.write(path.join(repoRoot, ".gjc", "config.yml"), "theme:\n  dark: red-claw\n");
		await Bun.write(path.join(nestedCwd, ".gjc", "config.yml"), "theme:\n  dark: blue-crab\n");

		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.getAll().find(candidate => candidate.provider === "openai-codex");
		if (!model) throw new Error("Expected an OpenAI Codex model in the test registry");

		const created = await createAgentSession({
			cwd: nestedCwd,
			agentDir,
			modelRegistry,
			model,
			sessionManager: SessionManager.inMemory(),
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			notificationHostModeSupported: false,
			sdkHostModeSupported: false,
		});
		sessions.push({ dispose: () => created.session.dispose(), authStorage });

		expect(created.session.settings.get("theme.dark")).toBe("red-claw");
		const resolver = created.session.settings.getEffectiveConfigurationResolver();
		const themeExplanation = resolver.explain(resolver.resolve("theme.dark"));
		expect(themeExplanation.winner?.ownership).toBe("owned");

		const preview = await created.session.previewWorkMode("quick-edit");
		if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
		const projectEvent = await created.session.applyWorkMode({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "project",
			operationId: "standard-project-apply",
		});
		expect("caseId" in projectEvent && projectEvent.caseId).toBe("persistent_apply.ready.committed");
		expect(await Bun.file(path.join(repoRoot, ".gjc", "config.yml")).text()).toContain("modelProfile:");
		expect(created.session.settings.get("modelProfile.default")).toBe("codex-eco");

		const userPreview = await created.session.previewWorkMode("quick-edit");
		if (userPreview.state !== "ready")
			throw new Error(`Expected ready Work Mode user preview, got ${userPreview.state}`);
		const userEvent = await created.session.applyWorkMode({
			modeId: "quick-edit",
			acceptedPreview: userPreview,
			scope: "user",
			operationId: "standard-user-apply",
		});
		expect("caseId" in userEvent && userEvent.caseId).toBe("persistent_apply.ready.committed");
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toContain("modelProfile:");
		expect(created.session.settings.get("modelProfile.default")).toBe("codex-eco");

		const managed = new ScopedConfigurationMutationService({
			loadContext: { cwd: nestedCwd, home: os.homedir(), repoRoot },
			agentDir,
			reloadAndVerify: context => created.session.settings.reloadAndVerifyScope(context),
		});
		const managedReceipt = await managed.mutate({
			scope: "managed",
			patches: [{ op: "set", path: "modelProfile.default", value: "codex-eco" }],
		});
		expect(managedReceipt.status).toBe("locked");
	});
});
