import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager, type AsyncJobRegisterOptions } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { isValidAllocatedTaskId, isValidTaskId, TaskTool, validateAllocatedTaskId } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import { AgentOutputManager } from "../../src/task/output-manager";
import type { TaskParams } from "../../src/task/types";
import { taskSchema } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	AsyncJobManager.resetForTests();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...overrides,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

function validParams(id: string): TaskParams {
	return {
		agent: "task",
		tasks: [{ id, description: "label", assignment: "Do work." }],
	};
}

describe("task id validation", () => {
	it("accepts filesystem-safe task ids and allocated prefixes", async () => {
		for (const id of ["A", "ab", "a_b-9", "Z".repeat(48)]) {
			expect(isValidTaskId(id)).toBe(true);
			expect(taskSchema.safeParse(validParams(id)).success).toBe(true);
		}

		const outputManager = new AgentOutputManager(() => null);
		expect(await outputManager.allocateBatch(["Alpha", "beta_2"])).toEqual(["0-Alpha", "1-beta_2"]);
		expect(isValidAllocatedTaskId("0-Alpha")).toBe(true);
		expect(isValidAllocatedTaskId("0-Parent.1-Child_2")).toBe(true);
	});

	it("rejects path-like, blank, control, unicode separator, and absolute-ish ids in schema", () => {
		const invalidIds = [
			"",
			" ",
			"../x",
			"a/b",
			"a\\b",
			".",
			"..",
			"/abs",
			"C:\\abs",
			"a\u0000b",
			"a\u001fb",
			"a\u2215b",
			"-startsWithDash",
			"_startsWithUnderscore",
			"a.b",
			"x".repeat(49),
		];

		for (const id of invalidIds) {
			expect(taskSchema.safeParse(validParams(id)).success, id).toBe(false);
			expect(isValidTaskId(id), id).toBe(false);
		}
	});

	it("rejects invalid task ids before scheduling", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });
		const registered: string[] = [];
		AsyncJobManager.setInstance({
			register: (_type: "bash" | "task", label: string, _run: unknown, options?: AsyncJobRegisterOptions) => {
				registered.push(options?.id ?? label);
				return options?.id ?? label;
			},
		} as unknown as AsyncJobManager);

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-invalid-id", validParams("../x"));

		expect(registered).toEqual([]);
		expect(getFirstText(result)).toContain("Invalid task ids");
		expect(getFirstText(result)).toContain("../x");
	});

	it("prevents allocated id path traversal before artifact writes", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-id-artifacts-"));
		tempDirs.push(artifactsDir);
		const outsidePath = path.join(path.dirname(artifactsDir), "escape.md");
		await fs.rm(outsidePath, { force: true });

		expect(() => validateAllocatedTaskId("0-../../escape")).toThrow("Allocated task id");
		expect(() => validateAllocatedTaskId("0-a/b")).toThrow("Allocated task id");
		expect(() => validateAllocatedTaskId("0-a\\b")).toThrow("Allocated task id");

		await expect(fs.stat(outsidePath)).rejects.toThrow();
	});
});
