import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	buildWorkflowStateReceipt,
	workflowActiveStatePath,
	workflowStateStoragePath,
} from "../../src/skill-state/workflow-state-contract";

describe("workflow receipt paths", () => {
	test("session-scoped receipts use the real _session- layout, not legacy state/sessions", () => {
		const cwd = "/repo";
		const sessionId = "sess-a";
		const storage = workflowStateStoragePath(cwd, "ultragoal", sessionId);
		const active = workflowActiveStatePath(cwd, sessionId);
		expect(storage).toBe(path.join(cwd, ".gjc", "_session-sess-a", "state", "ultragoal-state.json"));
		expect(active).toBe(path.join(cwd, ".gjc", "_session-sess-a", "state", "skill-active-state.json"));
		expect(storage).not.toContain(`${path.sep}state${path.sep}sessions${path.sep}`);
		expect(active).not.toContain(`${path.sep}state${path.sep}sessions${path.sep}`);

		const receipt = buildWorkflowStateReceipt({
			cwd,
			skill: "ultragoal",
			owner: "gjc-state-cli",
			command: "gjc state ultragoal write --input '<json>'",
			sessionId,
			nowIso: "2026-07-17T00:00:00.000Z",
			mutationId: "m1",
		});
		expect(receipt.storage_path).toBe(storage);
		expect(receipt.state_path).toBe(active);
	});
});
