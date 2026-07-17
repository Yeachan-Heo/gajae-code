import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { activeSnapshotPath, modeStatePath } from "../../src/gjc-runtime/session-layout";
import { buildWorkflowStateReceipt } from "../../src/skill-state/workflow-state-contract";

describe("workflow receipt paths", () => {
	test("receipts stamp the real _session- layout paths", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-receipt-paths-"));
		const sessionId = "sess-receipt-1";
		const skill = "ralplan" as const;

		const receipt = buildWorkflowStateReceipt({
			cwd,
			skill,
			owner: "gjc-state-cli",
			command: "gjc state ralplan write",
			sessionId,
			nowIso: "2026-07-17T00:00:00.000Z",
			mutationId: "mut-1",
		});

		const expectedState = activeSnapshotPath(cwd, sessionId);
		const expectedStorage = modeStatePath(cwd, sessionId, skill);
		expect(receipt.state_path).toBe(expectedState);
		expect(receipt.storage_path).toBe(expectedStorage);
		expect(receipt.state_path).toContain(`${path.sep}.gjc${path.sep}_session-`);
		expect(receipt.state_path).not.toContain(`${path.sep}state${path.sep}sessions${path.sep}`);
		expect(receipt.storage_path).not.toContain(`${path.sep}state${path.sep}sessions${path.sep}`);

		await fs.mkdir(path.dirname(expectedState), { recursive: true });
		await fs.writeFile(expectedState, "{}\n");
		await fs.writeFile(expectedStorage, "{}\n");
		await expect(fs.stat(receipt.state_path)).resolves.toBeDefined();
		await expect(fs.stat(receipt.storage_path)).resolves.toBeDefined();
	});

	test("missing sessionId falls back to a stable default session segment", () => {
		const cwd = "/tmp/project";
		const receipt = buildWorkflowStateReceipt({
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview",
		});
		expect(receipt.state_path).toBe(activeSnapshotPath(cwd, "default"));
		expect(receipt.storage_path).toBe(modeStatePath(cwd, "default", "deep-interview"));
	});
});
