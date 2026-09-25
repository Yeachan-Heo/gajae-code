import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as stateWriter from "../src/gjc-runtime/state-writer";
import { ensureWorkflowSkillActivationSeed } from "../src/hooks/skill-state";

describe("concurrent workflow activation clear", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("rejects activation when the existing entry is cleared before its subskill merge", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-state-clear-race-"));
		const sessionId = "session-clear-race";
		const initialSubskills = [
			{
				plugin: "gjc",
				subskillName: "ralplan",
				parent: "deep-interview",
				bindsTo: "session" as const,
				phase: "planner",
				activationArg: "initial",
			},
		];
		const changedSubskills = [
			{
				...initialSubskills[0],
				activationArg: "changed",
			},
		];
		await ensureWorkflowSkillActivationSeed({
			cwd: tempDir,
			skill: "deep-interview",
			sessionId,
			activeSubskills: initialSubskills,
		});

		const mergeSubskills = stateWriter.mergeActiveEntrySubskills;
		let removed = false;
		vi.spyOn(stateWriter, "mergeActiveEntrySubskills").mockImplementation(async (...args) => {
			if (!removed) {
				removed = true;
				await stateWriter.removeActiveEntry(args[0], args[1], args[2]);
			}
			return await mergeSubskills(...args);
		});

		await expect(
			ensureWorkflowSkillActivationSeed({
				cwd: tempDir,
				skill: "deep-interview",
				sessionId,
				activeSubskills: changedSubskills,
			}),
		).rejects.toThrow("Workflow activation entry disappeared during subskill merge: deep-interview");

		expect(removed).toBe(true);
	});
});
