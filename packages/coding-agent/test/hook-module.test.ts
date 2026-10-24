import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSupportedHookEvent, renderHookModule } from "../src/migrate/hook-module";
import { planMigration } from "../src/migrate/action-planner";
import type { HookCandidate, MigrateDestinations } from "../src/migrate/types";

let tmp: string;
let dest: MigrateDestinations;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hook-module-test-"));
	dest = {
		mcpConfigPath: path.join(tmp, "mcp.json"),
		skillsDir: path.join(tmp, "skills"),
		commandsDir: path.join(tmp, ".gjc", "commands"),
		agentsDir: path.join(tmp, ".gjc", "agents"),
		hooksDir: path.join(tmp, ".gjc", "hooks"),
		instructionsPath: path.join(tmp, "AGENTS.md"),
	};
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("hook-module — supported events", () => {
	it("supports PreToolUse, PostToolUse, SessionStart", () => {
		expect(isSupportedHookEvent("PreToolUse")).toBe(true);
		expect(isSupportedHookEvent("PostToolUse")).toBe(true);
		expect(isSupportedHookEvent("SessionStart")).toBe(true);
	});

	it("does not support Stop event (no faithful GJC equivalent)", () => {
		expect(isSupportedHookEvent("Stop")).toBe(false);
	});

	it("does not support unknown events", () => {
		expect(isSupportedHookEvent("UnknownEvent")).toBe(false);
	});
});

describe("hook-module — destination location", () => {
	it("writes hooks to .gjc/hooks/post/ directory for discovery", async () => {
		const hookCandidate: HookCandidate = {
			source: "claude-code",
			event: "PostToolUse",
			matcher: "bash",
			command: 'echo "hook ran"',
		};

		const { actions } = await planMigration({
			results: [
				{
					mcpCandidates: [],
					skillCandidates: [],
					slashCommandCandidates: [],
					agentCandidates: [],
					hookCandidates: [hookCandidate],
					instructionCandidates: [],
					diagnostics: [],
					manualActions: [],
				},
			],
			destinations: dest,
			force: false,
		});

		expect(actions).toHaveLength(1);
		const hookAction = actions[0];
		expect(hookAction?.type).toBe("hook");
		expect(hookAction?.destination).toContain("post");
		expect(hookAction?.destination).toBe(path.join(dest.hooksDir, "post", "migrated-claude-code.ts"));
	});
});

describe("hook-module — Stop event handling", () => {
	it("marks Stop as skipped_unmappable", async () => {
		const stopHook: HookCandidate = {
			source: "claude-code",
			event: "Stop",
			command: 'echo "cleanup"',
		};

		const { actions } = await planMigration({
			results: [
				{
					mcpCandidates: [],
					skillCandidates: [],
					slashCommandCandidates: [],
					agentCandidates: [],
					hookCandidates: [stopHook],
					instructionCandidates: [],
					diagnostics: [],
					manualActions: [],
				},
			],
			destinations: dest,
			force: false,
		});

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			type: "hook",
			name: "Stop",
			operation: "skip",
			status: "skipped_unmappable",
			reason: expect.stringContaining("Stop has no faithful gjc hook event"),
		});
	});
});

describe("hook-module — case-insensitive tool matching", () => {
	it("renders hook module with case-insensitive matchers", async () => {
		const hooks: HookCandidate[] = [
			{
				source: "claude-code",
				event: "PreToolUse",
				matcher: "Bash",
				command: 'echo "pre-bash"',
			},
			{
				source: "claude-code",
				event: "PostToolUse",
				matcher: "Read",
				command: 'echo "post-read"',
			},
		];

		const module = renderHookModule("claude-code", hooks);

		// Module should contain the matchers
		expect(module).toContain("Bash");
		expect(module).toContain("Read");

		// Module should use case-insensitive regex matching
		expect(module).toContain('new RegExp(`^(?:${matcher})$`, "i")');
	});

	it("generated module matches both uppercase and lowercase tool names", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PreToolUse",
				matcher: "Bash",
				command: 'echo "matched"',
			},
		]);

		// Verify the generated code includes case-insensitive matching
		expect(module).toContain("normalizedName");
		expect(module).toContain(".toLowerCase()");
	});
});

describe("hook-module — PreToolUse permissionDecision parsing", () => {
	it("renders blocking hook code that checks permissionDecision", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PreToolUse",
				command: 'echo \'{"permissionDecision":"deny"}\'',
			},
		]);

		// Module should parse JSON response
		expect(module).toContain("JSON.parse(result.stdout)");
		expect(module).toContain("permissionDecision");

		// Module should block when permissionDecision is "deny"
		expect(module).toContain('if (response.permissionDecision === "deny")');
	});

	it("falls back to exit code 2 if JSON parsing fails", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PreToolUse",
				command: "hook-script",
			},
		]);

		// Should have try-catch and fallback
		expect(module).toContain("} catch {");
		expect(module).toContain("// Not JSON or parse failed");
		expect(module).toContain("if (result.code === 2)");
	});
});

describe("hook-module — PostToolUse tool_response translation", () => {
	it("includes tool_response and tool_error in observational payload", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PostToolUse",
				command: 'echo "done"',
			},
		]);

		// Module should extract content and isError from payload
		expect(module).toContain("content?: unknown");
		expect(module).toContain("isError?: boolean");

		// Module should add these to hook payload for tool_result events
		expect(module).toContain("tool_response");
		expect(module).toContain("tool_error");

		// Should only add them when event is tool_result
		expect(module).toContain('if (event === "tool_result"');
	});
});

describe("hook-module — timeout enforcement", () => {
	it("sets timeout constant to 30 seconds", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PostToolUse",
				command: 'echo "test"',
			},
		]);

		// Module should have timeout constant
		expect(module).toContain("HOOK_COMMAND_TIMEOUT_MS = 30000");
	});

	it("uses Promise.race to enforce timeout", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PostToolUse",
				command: 'echo "test"',
			},
		]);

		// Module should use Promise.race
		expect(module).toContain("Promise.race<number>");
		expect(module).toContain("setTimeout");
		expect(module).toContain("child.kill()");
		expect(module).toContain("resolve(124)");
	});
});

describe("hook-module — rendering", () => {
	it("generates valid TypeScript module", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PreToolUse",
				matcher: "bash",
				command: 'echo "test"',
			},
		]);

		// Module should be valid TypeScript
		expect(module).toContain("import { spawn } from \"node:child_process\"");
		expect(module).toContain("interface ImportedHook");
		expect(module).toContain("interface HookCommandResult");
		expect(module).toContain("interface HookApi");
		expect(module).toContain("function matches");
		expect(module).toContain("function shellCommand");
		expect(module).toContain("async function runHook");
		expect(module).toContain("function registerBlocking");
		expect(module).toContain("function registerObservational");
		expect(module).toContain("export default");
	});

	it("generates deterministic output", async () => {
		const hooks: HookCandidate[] = [
			{
				source: "claude-code",
				event: "PreToolUse",
				matcher: "bash",
				command: 'echo "test"',
			},
			{
				source: "claude-code",
				event: "PostToolUse",
				command: 'echo "done"',
			},
		];

		const module1 = renderHookModule("claude-code", hooks);
		const module2 = renderHookModule("claude-code", hooks);

		expect(module1).toBe(module2);
	});

	it("includes generated header comment", async () => {
		const module = renderHookModule("claude-code", [
			{
				source: "claude-code",
				event: "PostToolUse",
				command: 'echo "test"',
			},
		]);

		expect(module).toContain("Generated by `gjc migrate --from claude-code`");
		expect(module).toContain("Re-run with --force to regenerate");
	});
});
