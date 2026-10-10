import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { activeSnapshotPath, modeStatePath, sessionStateDir } from "../src/gjc-runtime/session-layout";
import { RALPLAN_MUTATION_BLOCK_MESSAGE } from "../src/skill-state/workflow-mutation-guard";
import { assertMonitorMutationAllowed } from "../src/tools/monitor-mutation";

async function writeActiveRalplan(cwd: string): Promise<void> {
	const now = new Date().toISOString();
	const sessionId = "session-a";
	await fs.mkdir(sessionStateDir(cwd, sessionId), { recursive: true });
	const activeState = {
		version: 1,
		active: true,
		skill: "ralplan",
		phase: "planning",
		updated_at: now,
		active_skills: [{ skill: "ralplan", phase: "planning", active: true, updated_at: now, session_id: sessionId }],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, "ralplan"),
		`${JSON.stringify({ active: true, current_phase: "planning", session_id: sessionId }, null, 2)}\n`,
	);
}

describe("monitor planning guard", () => {
	it("refuses a product-code mutation and allows a read-only monitor during ralplan", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-plan-"));
		try {
			await writeActiveRalplan(cwd);
			await expect(
				assertMonitorMutationAllowed({ cwd, sessionId: "session-a", command: "tee src/product.ts" }),
			).rejects.toThrow(RALPLAN_MUTATION_BLOCK_MESSAGE);
			await expect(
				assertMonitorMutationAllowed({ cwd, sessionId: "session-a", command: "tail -f README.md" }),
			).resolves.toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
