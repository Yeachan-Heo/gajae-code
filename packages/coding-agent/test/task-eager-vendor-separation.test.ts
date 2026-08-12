import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import type { ModelProfileDefinition } from "@gajae-code/coding-agent/config/model-profiles";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	findVendorSeparatedWorkerRoles,
	resolveEagerTaskDelegation,
} from "@gajae-code/coding-agent/config/task-delegation";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";

const DELEGATION_DIRECTIVE = "Delegate by default for multi-file changes";

const authStorages: AuthStorage[] = [];
const tempDirs: string[] = [];

function vendorSeparatedProfile(): ModelProfileDefinition {
	return {
		name: "vendor-split",
		requiredProviders: ["anthropic", "openai-codex"],
		modelMapping: {
			default: "anthropic/claude-opus-5:medium",
			executor: "openai-codex/gpt-5.5:high",
			planner: "openai-codex/gpt-5.5:high",
		},
		source: "user",
	};
}

async function createSession(settings: Settings, toolNames?: string[]) {
	const tempDir = path.join(os.tmpdir(), `gjc-task-eager-${Snowflake.next()}`);
	tempDirs.push(tempDir);
	fs.mkdirSync(tempDir, { recursive: true });
	settings.override("recipe.enabled", false);
	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorages.push(authStorage);
	return createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.inMemory(),
		authStorage,
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
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
		toolNames,
	});
}

afterEach(() => {
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("findVendorSeparatedWorkerRoles", () => {
	it("reports worker roles pinned to a provider other than the default role", () => {
		expect(
			findVendorSeparatedWorkerRoles({
				default: "anthropic/claude-opus-5:medium",
				executor: "openai-codex/gpt-5.5:high",
				planner: "anthropic/claude-opus-5:low",
				critic: "grok-build/grok-build",
			}),
		).toEqual(["executor"]);
	});

	it("compares the primary selector of a fallback chain", () => {
		expect(
			findVendorSeparatedWorkerRoles({
				default: ["anthropic/claude-opus-5", "openai-codex/gpt-5.5"],
				executor: ["openai-codex/gpt-5.5", "anthropic/claude-opus-5"],
			}),
		).toEqual(["executor"]);
	});

	it("ignores single-vendor and provider-agnostic layouts", () => {
		expect(
			findVendorSeparatedWorkerRoles({
				default: "openai-codex/gpt-5.6-sol:low",
				executor: "openai-codex/gpt-5.6-terra:low",
				planner: "openai-codex/gpt-5.6-terra:high",
			}),
		).toEqual([]);
		expect(findVendorSeparatedWorkerRoles({ default: "glm-5.2:medium", executor: "deepseek-v4-flash:high" })).toEqual(
			[],
		);
		expect(findVendorSeparatedWorkerRoles({ executor: "openai-codex/gpt-5.5:high" })).toEqual([]);
	});
});

describe("resolveEagerTaskDelegation", () => {
	it("enables delegation for a vendor-separated profile that has not been installed into settings", () => {
		const resolved = resolveEagerTaskDelegation({
			settings: Settings.isolated(),
			profile: vendorSeparatedProfile(),
		});
		expect(resolved).toEqual({
			eagerTasks: true,
			vendorSeparatedRoles: ["executor", "planner"],
			suppressedByExplicitSetting: false,
		});
	});

	it("enables delegation from installed role bindings without any profile", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-opus-5:medium" },
			"task.agentModelOverrides": { executor: "openai-codex/gpt-5.5:high" },
		});
		expect(resolveEagerTaskDelegation({ settings }).eagerTasks).toBe(true);
	});

	it("lets installed settings bindings override a stale profile mapping", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "openai-codex/gpt-5.5:medium" },
			"task.agentModelOverrides": { executor: "openai-codex/gpt-5.5:high", planner: "openai-codex/gpt-5.5:high" },
		});
		expect(resolveEagerTaskDelegation({ settings, profile: vendorSeparatedProfile() })).toEqual({
			eagerTasks: false,
			vendorSeparatedRoles: [],
			suppressedByExplicitSetting: false,
		});
	});

	it("keeps an explicit task.eager false authoritative and flags the unused workers", () => {
		const resolved = resolveEagerTaskDelegation({
			settings: Settings.isolated({ "task.eager": false }),
			profile: vendorSeparatedProfile(),
		});
		expect(resolved).toEqual({
			eagerTasks: false,
			vendorSeparatedRoles: ["executor", "planner"],
			suppressedByExplicitSetting: true,
		});
	});

	it("keeps single-vendor profiles non-eager by default", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "openai-codex/gpt-5.6-sol:low" },
			"task.agentModelOverrides": { executor: "openai-codex/gpt-5.6-terra:low" },
		});
		expect(resolveEagerTaskDelegation({ settings }).eagerTasks).toBe(false);
	});
});

describe("vendor-separated delegation in the system prompt", () => {
	it("emits the delegation directive with task.eager left at its default", async () => {
		const { session } = await createSession(
			Settings.isolated({
				modelRoles: { default: "anthropic/claude-opus-5:medium" },
				"task.agentModelOverrides": { executor: "openai-codex/gpt-5.5:high", planner: "openai-codex/gpt-5.5:high" },
			}),
		);
		try {
			expect(session.systemPrompt.join("\n")).toContain(DELEGATION_DIRECTIVE);
		} finally {
			await session.dispose();
		}
	});

	it("omits the delegation directive when the user explicitly disables task.eager", async () => {
		const { session } = await createSession(
			Settings.isolated({
				"task.eager": false,
				modelRoles: { default: "anthropic/claude-opus-5:medium" },
				"task.agentModelOverrides": { executor: "openai-codex/gpt-5.5:high" },
			}),
		);
		try {
			expect(session.systemPrompt.join("\n")).not.toContain(DELEGATION_DIRECTIVE);
		} finally {
			await session.dispose();
		}
	});

	it("activates the task tool and directive when a profile becomes vendor-separated mid-session", async () => {
		const settings = Settings.isolated({
			"tools.discoveryMode": "all",
			modelRoles: { default: "openai-codex/gpt-5.6-sol:low" },
			"task.agentModelOverrides": { executor: "openai-codex/gpt-5.6-terra:low" },
		});
		const { session } = await createSession(settings);
		try {
			expect(session.getActiveToolNames()).not.toContain("task");
			expect(session.systemPrompt.join("\n")).not.toContain(DELEGATION_DIRECTIVE);

			// What activating a vendor-separated profile installs mid-session.
			settings.override("modelRoles", { default: "anthropic/claude-opus-5:medium" });
			settings.override("task.agentModelOverrides", { executor: "openai-codex/gpt-5.5:high" });
			await session.syncEagerDelegation();

			expect(session.getActiveToolNames()).toContain("task");
			expect(session.systemPrompt.join("\n")).toContain(DELEGATION_DIRECTIVE);
		} finally {
			await session.dispose();
		}
	});

	it("omits the delegation directive for a single-vendor layout", async () => {
		const { session } = await createSession(
			Settings.isolated({
				modelRoles: { default: "openai-codex/gpt-5.6-sol:low" },
				"task.agentModelOverrides": { executor: "openai-codex/gpt-5.6-terra:low" },
			}),
		);
		try {
			expect(session.systemPrompt.join("\n")).not.toContain(DELEGATION_DIRECTIVE);
		} finally {
			await session.dispose();
		}
	});
});
