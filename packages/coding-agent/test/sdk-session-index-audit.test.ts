import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { SessionIndex, type SessionIndexEvent, sessionIndexChecksum } from "../src/sdk/broker/session-index";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";

/** A checksummed index row with a pre-v2 locator, which admission always rejects. */
function legacyRow(dir: string, indexSeq: number): string {
	const row = {
		version: SDK_STATE_VERSION,
		indexSeq,
		type: "host_registered" as const,
		sessionId: `legacy-${indexSeq}`,
		locator: { repo: dir, stateRoot: path.join(dir, ".gjc", "state") },
		endpointGeneration: 1,
		pid: process.pid,
		ts: Date.now(),
	};
	const checksum = sessionIndexChecksum(row as unknown as Omit<SessionIndexEvent, "checksum">);
	return `${JSON.stringify({ ...row, checksum })}\n`;
}

async function fixture(prefix: string) {
	const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
	const sessionsDir = path.join(dir, "sdk", "sessions");
	await fs.mkdir(sessionsDir, { recursive: true });
	return {
		dir,
		logPath: path.join(sessionsDir, "index.jsonl"),
		auditPath: path.join(sessionsDir, "index-audit.jsonl"),
	};
}

async function auditedSeqCounts(file: string): Promise<Record<number, number>> {
	const counts: Record<number, number> = {};
	for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
		if (!line) continue;
		const seq = (JSON.parse(line) as { indexSeq: number }).indexSeq;
		counts[seq] = (counts[seq] ?? 0) + 1;
	}
	return counts;
}

/** Like auditedSeqCounts, but keeps the lines that are not JSON instead of throwing on them. */
async function auditLines(file: string): Promise<{ counts: Record<number, number>; malformed: string[] }> {
	const counts: Record<number, number> = {};
	const malformed: string[] = [];
	for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
		if (!line) continue;
		try {
			const seq = (JSON.parse(line) as { indexSeq: number }).indexSeq;
			counts[seq] = (counts[seq] ?? 0) + 1;
		} catch {
			malformed.push(line);
		}
	}
	return { counts, malformed };
}

describe("session index rejection audit", () => {
	it("does not re-archive a rejection another reader already archived", async () => {
		const { dir, logPath, auditPath } = await fixture("gjc-index-audit-longlived-");
		await fs.writeFile(logPath, legacyRow(dir, 1));
		// A long-lived reader (the broker, a host) seeds its dedupe view once.
		const longLived = await new SessionIndex(dir).open();
		await fs.appendFile(logPath, legacyRow(dir, 2));
		// A short-lived client archives the new rejection first.
		await (await new SessionIndex(dir).open()).refresh();
		await longLived.refresh();
		await longLived.refresh();
		expect(await auditedSeqCounts(auditPath)).toEqual({ 1: 1, 2: 1 });
	});

	it("bounds the audit a cold reader parses by rotating an oversized generation", async () => {
		const { dir, logPath, auditPath } = await fixture("gjc-index-audit-rotate-");
		await fs.writeFile(logPath, legacyRow(dir, 1));
		// The history already names seq 1, so only a generation rotated before it is read re-records it.
		const history = [1, ...Array.from({ length: 2_000 }, (_, i) => 10_000 + i)]
			.map(indexSeq => JSON.stringify({ version: SDK_STATE_VERSION, code: "rejected_legacy_locator", indexSeq }))
			.join("\n");
		await fs.writeFile(auditPath, `${history}\n`);
		const before = (await fs.stat(auditPath)).size;
		await new SessionIndex(dir, { auditRotateBytes: 4096 }).open();
		// The oversized generation is kept, unmodified, as the previous one.
		expect((await fs.stat(`${auditPath}.1`)).size).toBe(before);
		// The live generation holds only what the index still rejects.
		expect(await auditedSeqCounts(auditPath)).toEqual({ 1: 1 });
		// A generation no larger than twice the live rejections is never rotated, so a
		// rejection set near the bound cannot rotate on every append.
		await fs.appendFile(logPath, legacyRow(dir, 2));
		await new SessionIndex(dir, { auditRotateBytes: 1 }).open();
		expect(await auditedSeqCounts(auditPath)).toEqual({ 1: 1, 2: 1 });
		expect((await fs.stat(`${auditPath}.1`)).size).toBe(before);
	});

	it("re-reads a generation another reader rotated in place of its old offset", async () => {
		const { dir, logPath, auditPath } = await fixture("gjc-index-audit-rerotate-");
		await fs.writeFile(logPath, legacyRow(dir, 1));
		// A short first row, so the long-lived reader's offset lands inside a row of the next generation.
		await fs.writeFile(auditPath, `${JSON.stringify({ indexSeq: 99 })}\n`);
		const longLived = await new SessionIndex(dir).open();
		const history = Array.from({ length: 2_000 }, (_, i) => JSON.stringify({ indexSeq: 10_000 + i })).join("\n");
		await fs.appendFile(auditPath, `${history}\n`);
		await fs.appendFile(logPath, legacyRow(dir, 2));
		await new SessionIndex(dir, { auditRotateBytes: 4096 }).open();
		await longLived.refresh();
		expect(await auditedSeqCounts(auditPath)).toEqual({ 1: 1, 2: 1 });
	});

	it("starts a new line after a torn final row instead of joining it", async () => {
		const { dir, logPath, auditPath } = await fixture("gjc-index-audit-torn-");
		await fs.writeFile(logPath, legacyRow(dir, 1));
		// A write that crashed mid-row leaves a tail without its newline.
		const torn = JSON.stringify({ indexSeq: 7, code: "rejected_legacy_locator" }).slice(0, 20);
		await fs.writeFile(auditPath, `${JSON.stringify({ indexSeq: 5 })}\n${torn}`);
		const longLived = await new SessionIndex(dir).open();
		await fs.appendFile(logPath, legacyRow(dir, 2));
		await (await new SessionIndex(dir).open()).refresh();
		await longLived.refresh();
		expect(await auditLines(auditPath)).toEqual({ counts: { 1: 1, 2: 1, 5: 1 }, malformed: [torn] });
	});

	it("dedupes a final row that lost only its newline", async () => {
		const { dir, logPath, auditPath } = await fixture("gjc-index-audit-unterminated-");
		await fs.writeFile(logPath, legacyRow(dir, 1));
		await fs.writeFile(auditPath, JSON.stringify({ indexSeq: 1 }));
		await new SessionIndex(dir).open();
		await fs.appendFile(logPath, legacyRow(dir, 2));
		await new SessionIndex(dir).open();
		expect(await auditLines(auditPath)).toEqual({ counts: { 1: 1, 2: 1 }, malformed: [] });
	});
});
