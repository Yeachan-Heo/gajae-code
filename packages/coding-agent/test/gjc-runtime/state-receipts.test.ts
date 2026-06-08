import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeStateCommand } from "../../src/gjc-runtime/state-runtime";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-receipts-"));
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
			const statePath = path.join(cwd, ".gjc/state/ralplan-state.json");
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
			expectValidReceipt(await readJson(path.join(cwd, ".gjc/state/deep-interview-state.json")), "deep-interview");
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
