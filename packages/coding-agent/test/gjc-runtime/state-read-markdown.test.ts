import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowStateJson, runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";

const tempRoots: string[] = [];
let priorSessionId: string | undefined;

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-state-read-markdown-"));
	tempRoots.push(dir);
	return dir;
}

beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
});

afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("gjc state read markdown", () => {
	it("defaults read output to markdown and keeps --json parseable", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--input",
				JSON.stringify({ active: true, current_phase: "interviewing", artifact_path: ".gjc/specs/draft.md" }),
			],
			root,
		);

		const markdown = await runNativeStateCommand(["read", "--mode", "deep-interview"], root);
		expect(markdown.status).toBe(0);
		expect(markdown.stdout).toStartWith("# deep-interview state\n");
		expect(markdown.stdout).toContain("- Current phase: interviewing");
		expect(markdown.stdout).toContain("- Valid next transitions:");
		expect(markdown.stdout).toContain("- Receipt: fresh");
		expect(markdown.stdout).toContain(".gjc/specs/draft.md");
		expect(() => JSON.parse(markdown.stdout ?? "")).toThrow();

		const json = await runNativeStateCommand(["read", "--mode", "deep-interview", "--json"], root);
		expect(json.status).toBe(0);
		const parsed = JSON.parse(json.stdout ?? "{}");
		expect(parsed.skill).toBe("deep-interview");
		expect(parsed.state.current_phase).toBe("interviewing");
	});

	it("exposes readWorkflowStateJson for programmatic callers", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			[
				"write",
				"--mode",
				"ralplan",
				"--force",
				"--input",
				JSON.stringify({ active: true, current_phase: "approval" }),
			],
			root,
		);

		const state = await readWorkflowStateJson(root, "ralplan");
		expect(state.skill).toBe("ralplan");
		expect(state.current_phase).toBe("approval");
	});

	it("rejects unknown gjc state flags", async () => {
		const root = await tempDir();
		const result = await runNativeStateCommand(["read", "--mode", "deep-interview", "--bogus"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown gjc state flag: --bogus");
	});
});
