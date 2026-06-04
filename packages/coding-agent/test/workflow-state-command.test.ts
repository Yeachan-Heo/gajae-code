import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const workflowSkills = ["deep-interview", "ralplan", "ultragoal", "team"] as const;
const initialPhases: Record<(typeof workflowSkills)[number], string> = {
	"deep-interview": "interviewing",
	ralplan: "planner",
	ultragoal: "goal-planning",
	team: "starting",
};

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-command-"));
	try {
		return await fn(cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

function runState(cwd: string, args: string[]) {
	return Bun.spawnSync(["bun", cliEntry, "state", ...args], {
		cwd,
		stderr: "pipe",
		stdout: "pipe",
		env: { ...process.env },
	});
}

describe("gjc state workflow command", () => {
	it("writes readable canonical state and receipt for workflow skills through documented invocation", async () => {
		await withTempCwd(async cwd => {
			for (const skill of workflowSkills) {
				const result = runState(cwd, [
					"write",
					"--session-id",
					`session-${skill}`,
					"--input",
					JSON.stringify({
						skill,
						current_phase: initialPhases[skill],
						active: true,
						hud: {
							version: 1,
							chips: [{ label: "gate", value: "approval-required", priority: 5, severity: "warning" }],
						},
						state: { blocked_reason: "execution approval missing" },
					}),
					"--json",
				]);
				expect(result.exitCode, result.stderr.toString()).toBe(0);
				const payload = JSON.parse(result.stdout.toString()) as {
					skill: string;
					status: string;
				};
				expect(payload).toMatchObject({ skill, status: "fresh" });

				const modeState = await Bun.file(
					path.join(cwd, ".gjc", "state", "sessions", `session-${skill}`, `${skill}-state.json`),
				).json();
				expect(modeState).toMatchObject({
					skill,
					current_phase: initialPhases[skill],
					blocked_reason: "execution approval missing",
				});
				expect(modeState.receipt.command).toBe(`gjc state ${skill} write`);

				const activeState = await Bun.file(
					path.join(cwd, ".gjc", "state", "sessions", `session-${skill}`, "skill-active-state.json"),
				).json();
				expect(activeState.active_skills[0]).toMatchObject({
					skill,
					phase: initialPhases[skill],
					receipt: { owner: "gjc-state-cli" },
				});
			}
		});
	}, 30_000);

	it("infers read skill from session context and prefers incoming phase transitions", async () => {
		await withTempCwd(async cwd => {
			const initial = runState(cwd, [
				"write",
				"--session-id",
				"session-1",
				"--input",
				JSON.stringify({
					skill: "deep-interview",
					current_phase: "interviewing",
					state: { current_phase: "ignored" },
				}),
				"--json",
			]);
			expect(initial.exitCode, initial.stderr.toString()).toBe(0);

			const transition = runState(cwd, [
				"write",
				"--session-id",
				"session-1",
				"--input",
				JSON.stringify({ skill: "deep-interview", phase: "handoff", state: { current_phase: "stale" } }),
				"--json",
			]);
			expect(transition.exitCode, transition.stderr.toString()).toBe(0);

			const modeState = await Bun.file(
				path.join(cwd, ".gjc", "state", "sessions", "session-1", "deep-interview-state.json"),
			).json();
			expect(modeState.current_phase).toBe("handoff");

			const activeState = await Bun.file(
				path.join(cwd, ".gjc", "state", "sessions", "session-1", "skill-active-state.json"),
			).json();
			expect(activeState.active_skills[0]).toMatchObject({ skill: "deep-interview", phase: "handoff" });

			const read = runState(cwd, ["read", "--session-id", "session-1", "--json"]);
			expect(read.exitCode, read.stderr.toString()).toBe(0);
			const readPayload = JSON.parse(read.stdout.toString()) as { skill: string; state: { current_phase: string } };
			expect(readPayload.skill).toBe("deep-interview");
			expect(readPayload.state.current_phase).toBe("handoff");
		});
	}, 20_000);
});
