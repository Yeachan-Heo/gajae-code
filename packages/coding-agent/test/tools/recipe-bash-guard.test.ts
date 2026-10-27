import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { activeSnapshotPath, modeStatePath, sessionStateDir } from "../../src/gjc-runtime/session-layout";
import { assertRecipeCommandAllowed } from "../../src/tools/recipe/recipe-guard";

const tempRoots: string[] = [];

async function writeActiveDeepInterview(cwd: string, sessionId = "session-a"): Promise<void> {
	const now = new Date().toISOString();
	const phase = "interviewing";
	await fs.mkdir(sessionStateDir(cwd, sessionId), { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill: "deep-interview",
		phase,
		updated_at: now,
		active_skills: [{ skill: "deep-interview", phase, active: true, updated_at: now, session_id: sessionId }],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, "deep-interview"),
		`${JSON.stringify({ active: true, current_phase: phase, session_id: sessionId }, null, 2)}\n`,
	);
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("assertRecipeCommandAllowed", () => {
	it("blocks a planning-phase product write and allows an inspection command", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "recipe-bash-guard-"));
		tempRoots.push(cwd);
		await writeActiveDeepInterview(cwd);
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		const productPath = path.join(cwd, "src", "product.ts");
		await Bun.write(productPath, "export const sentinel = 1;\n");

		await expect(
			assertRecipeCommandAllowed({
				cwd,
				sessionId: "session-a",
				command: "printf x > src/product.ts",
			}),
		).rejects.toThrow(/phase boundary/);
		expect(await fs.readFile(productPath, "utf8")).toBe("export const sentinel = 1;\n");

		await expect(
			assertRecipeCommandAllowed({
				cwd,
				sessionId: "session-a",
				command: "just --list",
			}),
		).resolves.toBeUndefined();
	});
});
