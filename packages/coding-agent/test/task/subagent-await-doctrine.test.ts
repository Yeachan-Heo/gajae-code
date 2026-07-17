import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	SUBAGENT_AWAIT_TIMEOUT_DOCTRINE,
	SUBAGENT_CANCEL_ONLY_WHEN_WRONG_DOCTRINE,
} from "../../src/task/subagent-await-doctrine";

const repoRoot = path.resolve(import.meta.dir, "../../..", "..");

describe("subagent await doctrine single source", () => {
	test("runtime surfaces import the shared doctrine text", () => {
		const subagentTool = fs.readFileSync(path.join(repoRoot, "packages/coding-agent/src/tools/subagent.ts"), "utf8");
		const taskIndex = fs.readFileSync(path.join(repoRoot, "packages/coding-agent/src/task/index.ts"), "utf8");
		expect(subagentTool).toContain("SUBAGENT_AWAIT_TIMEOUT_DOCTRINE");
		expect(taskIndex).toContain("SUBAGENT_AWAIT_TIMEOUT_DOCTRINE");
		expect(SUBAGENT_AWAIT_TIMEOUT_DOCTRINE).toContain("await timeout");
		expect(SUBAGENT_CANCEL_ONLY_WHEN_WRONG_DOCTRINE).toContain("never a cancellation reason");
	});

	test("prompt and skill docs stay aligned with the shared doctrine", () => {
		const subagentMd = fs.readFileSync(
			path.join(repoRoot, "packages/coding-agent/src/prompts/tools/subagent.md"),
			"utf8",
		);
		const ultragoal = fs.readFileSync(
			path.join(repoRoot, "packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md"),
			"utf8",
		);
		expect(subagentMd).toContain(SUBAGENT_AWAIT_TIMEOUT_DOCTRINE);
		expect(ultragoal).toContain("not subagent failure evidence");
		expect(ultragoal).toContain("become unrecoverably wrong");
	});
});
