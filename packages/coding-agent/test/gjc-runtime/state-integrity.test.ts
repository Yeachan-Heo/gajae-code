import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeStateCommand } from "../../src/gjc-runtime/state-runtime";
import { writeJsonAtomic } from "../../src/gjc-runtime/state-writer";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-integrity-"));
	const priorSessionId = process.env.GJC_SESSION_ID;
	delete process.env.GJC_SESSION_ID;
	try {
		await fn(dir);
	} finally {
		if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

async function readAuditEntries(cwd: string): Promise<Array<Record<string, unknown>>> {
	const raw = await fs.readFile(path.join(cwd, ".gjc/state/audit.jsonl"), "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("gjc state integrity", () => {
	it("blocks out-of-band edits on the next mode-state write unless forced", async () => {
		await withTempCwd(async cwd => {
			const first = await runNativeStateCommand(
				["write", "--mode", "ralplan", "--input", JSON.stringify({ current_phase: "planner" })],
				cwd,
			);
			expect(first.status).toBe(0);
			const statePath = path.join(cwd, ".gjc/state/ralplan-state.json");
			const stamped = await readJson(statePath);
			expect((stamped.receipt as Record<string, unknown>)?.content_sha256).toMatchObject({ algorithm: "sha256" });

			stamped.tampered = true;
			await fs.writeFile(statePath, `${JSON.stringify(stamped, null, 2)}\n`, "utf-8");

			const rejected = await runNativeStateCommand(
				["write", "--mode", "ralplan", "--input", JSON.stringify({ verdict: "continue" })],
				cwd,
			);
			expect(rejected.status).not.toBe(0);
			expect(rejected.stderr).toContain("out-of-band edit detected");
			expect((await readJson(statePath)).tampered).toBe(true);

			const forced = await runNativeStateCommand(
				["write", "--mode", "ralplan", "--force", "--input", JSON.stringify({ verdict: "continue" })],
				cwd,
			);
			expect(forced.status).toBe(0);
			expect(forced.stderr).toContain("out-of-band edit detected");
			const entries = await readAuditEntries(cwd);
			const mismatch = entries.find(entry => entry.verb === "out_of_band_detected" && entry.forced === true);
			expect(mismatch).toMatchObject({ skill: "ralplan", category: "state", owner: "gjc-state-cli" });
			expect(typeof mismatch?.expected_sha256).toBe("string");
			expect(typeof mismatch?.actual_sha256).toBe("string");
		});
	});

	it("does not checksum generic non-envelope JSON written by the shared writer", async () => {
		await withTempCwd(async cwd => {
			await writeJsonAtomic(
				path.join(cwd, ".gjc/state/team/tasks/task-1.json"),
				{ id: "task-1", status: "open" },
				{ cwd },
			);
			const task = await readJson(path.join(cwd, ".gjc/state/team/tasks/task-1.json"));
			expect(task.receipt).toBeUndefined();
			expect(task.content_sha256).toBeUndefined();
		});
	});

	it("handoff writes and removes its per-mutation journal on success", async () => {
		await withTempCwd(async cwd => {
			await runNativeStateCommand(
				["write", "--mode", "deep-interview", "--input", JSON.stringify({ current_phase: "interviewing" })],
				cwd,
			);
			const result = await runNativeStateCommand(["handoff", "--mode", "deep-interview", "--to", "ralplan"], cwd);
			expect(result.status).toBe(0);
			const entries = await fs.readdir(path.join(cwd, ".gjc/state/transactions")).catch(() => [] as string[]);
			expect(entries).toEqual([]);
		});
	});

	it("an injected mid-handoff failure leaves a same-mutation journal while unrelated writes still proceed", async () => {
		await withTempCwd(async cwd => {
			await runNativeStateCommand(
				["write", "--mode", "deep-interview", "--input", JSON.stringify({ current_phase: "interviewing" })],
				cwd,
			);
			process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER = "__never__";
			const originalNow = Date.prototype.toISOString;
			Date.prototype.toISOString = () => "2026-06-03T00:00:00.000Z";
			process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER = "deep-interview:handoff:ralplan:2026-06-03T00:00:00.000Z";
			try {
				const failed = await runNativeStateCommand(["handoff", "--mode", "deep-interview", "--to", "ralplan"], cwd);
				expect(failed.status).toBe(1);
			} finally {
				Date.prototype.toISOString = originalNow;
				delete process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER;
			}

			const journals = await fs.readdir(path.join(cwd, ".gjc/state/transactions"));
			expect(journals).toHaveLength(1);
			const journal = await readJson(path.join(cwd, ".gjc/state/transactions", journals[0]));
			expect(journal).toMatchObject({
				status: "pending",
				mutation_id: "deep-interview:handoff:ralplan:2026-06-03T00:00:00.000Z",
			});

			Date.prototype.toISOString = () => "2026-06-03T00:00:00.000Z";
			try {
				const recovered = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan"],
					cwd,
				);
				expect(recovered.status).toBe(0);
			} finally {
				Date.prototype.toISOString = originalNow;
			}
			const remainingAfterRecovery = await fs.readdir(path.join(cwd, ".gjc/state/transactions"));
			expect(remainingAfterRecovery).toEqual([]);

			await fs.writeFile(
				path.join(cwd, ".gjc/state/transactions/orphan-unrelated.json"),
				`${JSON.stringify({ version: 1, mutation_id: "orphan", status: "pending", paths: ["/elsewhere"] })}\n`,
			);
			const write = await runNativeStateCommand(
				["write", "--mode", "ultragoal", "--input", JSON.stringify({ current_phase: "goal-planning" })],
				cwd,
			);
			expect(write.status).toBe(0);
			expect(await readJson(path.join(cwd, ".gjc/state/ultragoal-state.json"))).toMatchObject({
				skill: "ultragoal",
			});
		});
	});
});
