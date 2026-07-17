import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { auditPath, modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { runNativeStateCommand } from "../../src/gjc-runtime/state-runtime";
import { initialPhaseForSkill } from "../../src/skill-state/initial-phase";
import { buildWorkflowStateReceipt } from "../../src/skill-state/workflow-state-contract";

const TEST_SESSION_ID = "test-session";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-receipts-"));
	const priorSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	try {
		await fn(dir);
	} finally {
		if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
		else delete process.env.GJC_SESSION_ID;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

async function readAuditEntries(cwd: string): Promise<Array<Record<string, unknown>>> {
	const raw = await fs.readFile(auditPath(cwd, TEST_SESSION_ID), "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

function expectValidReceipt(state: Record<string, unknown>, skill: string): void {
	const receipt = state.receipt as Record<string, unknown> | undefined;
	expect(receipt).toMatchObject({
		version: 1,
		skill,
		status: "fresh",
	});
	expect(["gjc-state-cli", "gjc-runtime", "gjc-hook"]).toContain(receipt?.owner as string);
	expect(typeof receipt?.mutated_at).toBe("string");
	expect(Number.isNaN(Date.parse(receipt?.mutated_at as string))).toBe(false);
}

function expectCliChecksum(payload: Record<string, unknown>): void {
	const checksum = payload.content_sha256 as Record<string, unknown> | undefined;
	expect(checksum).toMatchObject({ algorithm: "sha256" });
	expect(typeof checksum?.value).toBe("string");
}

function expectAuditEntry(entry: Record<string, unknown> | undefined, verb: "write" | "clear" | "handoff"): void {
	expect(entry).toMatchObject({
		category: "state",
		verb,
		owner: "gjc-state-cli",
	});
	expect(typeof entry?.ts).toBe("string");
	expect(Array.isArray(entry?.paths)).toBe(true);
}

function findAuditEntry(
	entries: Array<Record<string, unknown>>,
	verb: "write" | "clear" | "handoff",
): Record<string, unknown> | undefined {
	return entries.find(entry => entry.category === "state" && entry.verb === verb && entry.owner === "gjc-state-cli");
}

describe("G5 gjc state receipts", () => {
	it("persists receipts and audit entries for write, clear, and handoff", async () => {
		await withTempCwd(async cwd => {
			const write = await runNativeStateCommand(
				["write", "--mode", "ralplan", "--input", JSON.stringify({ current_phase: "planner" })],
				cwd,
			);
			expect(write.status).toBe(0);
			const writePayload = JSON.parse(write.stdout ?? "{}") as Record<string, unknown>;
			expect(writePayload).toMatchObject({ ok: true, skill: "ralplan", current_phase: "planner", active: true });
			expect(writePayload.state).toBeUndefined();
			expectCliChecksum(writePayload);
			const statePath = modeStatePath(cwd, TEST_SESSION_ID, "ralplan");
			expectValidReceipt(await readJson(statePath), "ralplan");
			expectAuditEntry(findAuditEntry(await readAuditEntries(cwd), "write"), "write");

			const clear = await runNativeStateCommand(["clear", "--mode", "ralplan"], cwd);
			expect(clear.status).toBe(0);
			const clearPayload = JSON.parse(clear.stdout ?? "{}") as Record<string, unknown>;
			expect(clearPayload).toMatchObject({ ok: true, skill: "ralplan", current_phase: "complete", active: false });
			expect(clearPayload.state).toBeUndefined();
			expectCliChecksum(clearPayload);
			expectValidReceipt(await readJson(statePath), "ralplan");
			expectAuditEntry(findAuditEntry(await readAuditEntries(cwd), "clear"), "clear");

			await runNativeStateCommand(
				["write", "--mode", "deep-interview", "--input", JSON.stringify({ current_phase: "interviewing" })],
				cwd,
			);
			const handoff = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(handoff.status).toBe(0);
			const handoffPayload = JSON.parse(handoff.stdout ?? "{}") as Record<string, unknown>;
			expect(handoffPayload).toMatchObject({ ok: true, from: "deep-interview", to: "ralplan" });
			expect(handoffPayload.state).toBeUndefined();
			const handoffReceipts = handoffPayload.receipts as Record<string, Record<string, unknown>>;
			expectCliChecksum(handoffReceipts.from);
			expectCliChecksum(handoffReceipts.to);
			expect(handoffReceipts.from.version).toBeUndefined();
			expectValidReceipt(await readJson(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview")), "deep-interview");
			expectValidReceipt(await readJson(statePath), "ralplan");

			const entries = await readAuditEntries(cwd);
			const handoffEntries = entries.filter(
				entry => entry.category === "state" && entry.verb === "handoff" && entry.owner === "gjc-state-cli",
			);
			expect(handoffEntries).toHaveLength(2);
			for (const entry of handoffEntries) expectAuditEntry(entry, "handoff");
		});
	});
});

describe("workflow receipt path contract", () => {
	it("uses session-layout receipt paths for every workflow mode", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "receipt/session.id";
			for (const skill of ["deep-interview", "ralplan", "ultragoal", "team"] as const) {
				const result = await runNativeStateCommand(
					[
						"write",
						"--mode",
						skill,
						"--session-id",
						sessionId,
						"--input",
						JSON.stringify({ current_phase: initialPhaseForSkill(skill) }),
					],
					cwd,
				);
				expect(result.status).toBe(0);
				const cli = JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
				const storagePath = modeStatePath(cwd, sessionId, skill);
				const activePath = path.join(path.dirname(storagePath), "skill-active-state.json");
				const state = await readJson(storagePath);
				const receipt = state.receipt as Record<string, unknown>;
				const statePath = receipt.state_path as string;
				const checksum = receipt.content_sha256 as Record<string, unknown>;

				expect(path.normalize(cli.state_path as string)).toBe(path.normalize(receipt.state_path as string));
				expect(path.normalize(receipt.state_path as string)).toBe(path.normalize(activePath));
				expect(path.normalize(receipt.storage_path as string)).toBe(path.normalize(storagePath));
				expect(path.normalize(checksum.covered_path as string)).toBe(
					path.normalize(receipt.storage_path as string),
				);
				await expect(fs.stat(statePath)).resolves.toBeDefined();
				await expect(fs.stat(storagePath)).resolves.toBeDefined();
			}
		});
	});

	it("rejects missing receipt sessions instead of constructing a default path", async () => {
		expect(() =>
			buildWorkflowStateReceipt({
				cwd: process.cwd(),
				skill: "ralplan",
				owner: "gjc-state-cli",
				command: "gjc state ralplan write",
				sessionId: " ",
			}),
		).toThrow("non-empty GJC session id");

		await withTempCwd(async cwd => {
			const sessionId = process.env.GJC_SESSION_ID;
			delete process.env.GJC_SESSION_ID;
			try {
				const result = await runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", JSON.stringify({ current_phase: "planner" })],
					cwd,
				);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("session id is required");
			} finally {
				if (sessionId !== undefined) process.env.GJC_SESSION_ID = sessionId;
			}
		});
	});
});
