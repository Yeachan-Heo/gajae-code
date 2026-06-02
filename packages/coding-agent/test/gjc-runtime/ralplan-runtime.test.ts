import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { GJC_RESTRICTED_ROLE_AGENT_BASH_ENV } from "@gajae-code/coding-agent/gjc-runtime/restricted-role-agent-bash";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ralplan-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("native gjc ralplan runtime — consensus handoff", () => {
	it("accepts the documented flag surface without rejecting --interactive/--deliberate", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--interactive", "--deliberate", "make state native"], root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Seeded ralplan deliberate run (interactive)");
		const state = JSON.parse(await fs.readFile(path.join(root, ".gjc", "state", "ralplan-state.json"), "utf-8"));
		expect(state.mode).toBe("deliberate");
		expect(state.interactive).toBe(true);
		expect(state.task).toBe("make state native");
	});

	it("--architect openai-code seeds the kind into state", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--architect", "openai-code", "--critic", "openai-code", "scope a refactor"],
			root,
		);
		expect(result.status).toBe(0);
		const state = JSON.parse(await fs.readFile(path.join(root, ".gjc", "state", "ralplan-state.json"), "utf-8"));
		expect(state.architect_kind).toBe("openai-code");
		expect(state.critic_kind).toBe("openai-code");
	});

	it("syncs ralplan HUD chips for the active run", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(["--deliberate", "task"], root);
		const active = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "skill-active-state.json"), "utf-8"),
		);
		const entry = (
			active.active_skills as Array<{
				skill: string;
				phase?: string;
				hud?: { chips?: Array<{ label: string; value?: string }> };
			}>
		).find(e => e.skill === "ralplan");
		expect(entry).toBeTruthy();
		expect(entry?.phase).toBe("planner");
		const chips = entry?.hud?.chips ?? [];
		expect(chips.some(c => c.label === "stage" && c.value === "planner")).toBe(true);
		expect(chips.some(c => c.label === "iter" && c.value === "1")).toBe(true);
	});

	it("rejects unknown --architect kinds with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--architect", "nope", "task"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown --architect kind");
	});

	it("rejects missing task description with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--deliberate"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("requires a task description");
	});

	it("rejects unknown free-form flags with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--no-such-flag", "task"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown flag");
	});
});

describe("native gjc ralplan runtime — --write artifact path", () => {
	it("persists an inline artifact under .gjc/plans/ralplan/<run-id>/", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan body",
				"--run-id",
				"test-run-1",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.run_id).toBe("test-run-1");
		expect(payload.stage).toBe("planner");
		expect(payload.stage_n).toBe(1);
		expect(typeof payload.sha256).toBe("string");
		const filePath = path.join(root, ".gjc", "plans", "ralplan", "test-run-1", "stage-01-planner.md");
		const content = await fs.readFile(filePath, "utf-8");
		expect(content).toBe("# Plan body\n");
		const indexLine = (
			await fs.readFile(path.join(root, ".gjc", "plans", "ralplan", "test-run-1", "index.jsonl"), "utf-8")
		).trim();
		expect(JSON.parse(indexLine).sha256).toBe(payload.sha256);
	});

	it("--artifact <file> reads contents from disk", async () => {
		const root = await tempDir();
		const artifactPath = path.join(root, "draft.md");
		await fs.writeFile(artifactPath, "# Draft\nbody\n");
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "architect", "--stage_n", "2", "--artifact", artifactPath, "--run-id", "file-run"],
			root,
		);
		expect(result.status).toBe(0);
		const content = await fs.readFile(
			path.join(root, ".gjc", "plans", "ralplan", "file-run", "stage-02-architect.md"),
			"utf-8",
		);
		expect(content).toBe("# Draft\nbody\n");
	});

	it("restricted role-agent bash treats --artifact paths as inline text", async () => {
		const root = await tempDir();
		const artifactPath = path.join(root, "secret.md");
		await fs.writeFile(artifactPath, "# Secret\nshould-not-be-read\n");
		const previous = process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV];
		process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV] = "1";
		try {
			const result = await runNativeRalplanCommand(
				[
					"--write",
					"--stage",
					"architect",
					"--stage_n",
					"2",
					"--artifact",
					artifactPath,
					"--run-id",
					"restricted-file-run",
				],
				root,
			);
			expect(result.status).toBe(0);
			const content = await fs.readFile(
				path.join(root, ".gjc", "plans", "ralplan", "restricted-file-run", "stage-02-architect.md"),
				"utf-8",
			);
			expect(content).toBe(`${artifactPath}\n`);
		} finally {
			if (previous === undefined) {
				delete process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV];
			} else {
				process.env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV] = previous;
			}
		}
	});

	it("final stage emits pending-approval.md alongside the stage artifact", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"final",
				"--stage_n",
				"6",
				"--artifact",
				"# Final Plan",
				"--run-id",
				"final-run",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(typeof payload.pending_approval_path).toBe("string");
		const pendingApproval = await fs.readFile(
			path.join(root, ".gjc", "plans", "ralplan", "final-run", "pending-approval.md"),
			"utf-8",
		);
		expect(pendingApproval).toBe("# Final Plan\n");
	});

	it("rejects unknown --stage with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "nope", "--stage_n", "1", "--artifact", "x"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown --stage");
	});

	it("rejects out-of-range --stage_n with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1000", "--artifact", "x"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid --stage_n");
	});

	it("rejects malformed non-integer --stage_n like '1.5' or '1abc' with exit 2", async () => {
		const root = await tempDir();
		for (const bad of ["1.5", "1abc", "0", "-1", "abc"]) {
			const result = await runNativeRalplanCommand(
				["--write", "--stage", "planner", "--stage_n", bad, "--artifact", "x"],
				root,
			);
			expect(result.status, `expected rejection for ${bad}`).toBe(2);
			expect(result.stderr).toContain("invalid --stage_n");
		}
	});

	it("rejects --run-id with traversal characters with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "x", "--run-id", "../escape"],
			root,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("invalid path component");
	});

	it("appends index.jsonl entries instead of overwriting", async () => {
		const root = await tempDir();
		await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "p1", "--run-id", "multi"],
			root,
		);
		await runNativeRalplanCommand(
			["--write", "--stage", "architect", "--stage_n", "2", "--artifact", "a2", "--run-id", "multi"],
			root,
		);
		const indexLines = (
			await fs.readFile(path.join(root, ".gjc", "plans", "ralplan", "multi", "index.jsonl"), "utf-8")
		)
			.trim()
			.split("\n");
		expect(indexLines.length).toBe(2);
		expect(JSON.parse(indexLines[0]).stage).toBe("planner");
		expect(JSON.parse(indexLines[1]).stage).toBe("architect");
	});

	it("keeps multiple --write calls in the same run when no --run-id is supplied", async () => {
		const root = await tempDir();
		const first = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "p1", "--json"],
			root,
		);
		expect(first.status).toBe(0);
		const firstPayload = JSON.parse(first.stdout ?? "{}") as { run_id: string };

		const second = await runNativeRalplanCommand(
			["--write", "--stage", "architect", "--stage_n", "2", "--artifact", "a2", "--json"],
			root,
		);
		expect(second.status).toBe(0);
		const secondPayload = JSON.parse(second.stdout ?? "{}") as { run_id: string };

		// Without explicit --run-id, both writes should target the same auto-generated run.
		expect(secondPayload.run_id).toBe(firstPayload.run_id);

		const indexLines = (
			await fs.readFile(path.join(root, ".gjc", "plans", "ralplan", firstPayload.run_id, "index.jsonl"), "utf-8")
		)
			.trim()
			.split("\n");
		expect(indexLines.length).toBe(2);
		expect(JSON.parse(indexLines[0]).stage).toBe("planner");
		expect(JSON.parse(indexLines[1]).stage).toBe("architect");
	});

	it("ralplan consensus handoff seeds run_id that subsequent --write calls reuse", async () => {
		const root = await tempDir();
		const handoff = await runNativeRalplanCommand(["--deliberate", "--json", "task"], root);
		expect(handoff.status).toBe(0);
		const handoffPayload = JSON.parse(handoff.stdout ?? "{}") as { run_id: string };
		expect(typeof handoffPayload.run_id).toBe("string");

		const write = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--json"],
			root,
		);
		expect(write.status).toBe(0);
		const writePayload = JSON.parse(write.stdout ?? "{}") as { run_id: string };
		expect(writePayload.run_id).toBe(handoffPayload.run_id);
	});
});
