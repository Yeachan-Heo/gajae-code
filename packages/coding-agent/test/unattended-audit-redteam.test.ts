import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	AUDIT_CATEGORY,
	AUDIT_SCHEMA_VERSION,
	answerHash,
	defaultAuditPath,
	UnattendedAuditLog,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-audit";

function tempDir(prefix = "audit-redteam-"): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function tempFile(name = "audit.jsonl"): string {
	return path.join(tempDir(), name);
}

describe("UnattendedAuditLog red-team coverage", () => {
	it("dedupes many interleaved events across a fresh instance and preserves the first record", () => {
		let currentTime = 0;
		let currentId = 0;
		const file = tempFile();
		const log = new UnattendedAuditLog(file, {
			now: () => currentTime,
			nextId: () => `id-${++currentId}`,
		});

		const keys = ["gate:a", "budget:a", "scope:a", "gate:b", "action:a", "budget:b"];
		const firstByKey = new Map<string, { event_id: string; event: string; timestamp: string; actor?: string }>();
		for (let round = 0; round < 20; round += 1) {
			for (const [index, key] of keys.entries()) {
				currentTime = round * 1000 + index;
				const event = key.split(":")[0] === "gate" ? "gate_response_accepted" : `${key.split(":")[0]}_event`;
				const rec = log.record({
					run_id: "run-dedupe",
					session_id: round % 2 === 0 ? "even" : "odd",
					actor: `actor-${round}`,
					event,
					outcome: event === "gate_response_accepted" ? "accepted" : "info",
					dedupe_key: key,
					gate_id: event === "gate_response_accepted" ? key : undefined,
				});
				if (!firstByKey.has(key)) {
					expect(rec).not.toBeNull();
					firstByKey.set(key, {
						event_id: rec!.event_id,
						event: rec!.event,
						timestamp: rec!.timestamp,
						actor: rec!.actor,
					});
				} else {
					expect(rec).toBeNull();
				}
			}
		}

		const fresh = new UnattendedAuditLog(file, { nextId: () => "should-not-write" });
		for (const key of keys) {
			expect(
				fresh.record({ run_id: "run-dedupe", event: "duplicate", outcome: "info", dedupe_key: key }),
			).toBeNull();
		}

		const all = fresh.readAll();
		expect(all).toHaveLength(keys.length);
		expect(new Set(all.map(record => record.dedupe_key))).toEqual(new Set(keys));
		for (const record of all) {
			expect(record).toMatchObject(firstByKey.get(record.dedupe_key)!);
		}
	});

	it("uses inclusive since/until time-window boundaries", () => {
		let currentTime = 0;
		const log = new UnattendedAuditLog(tempFile(), { now: () => currentTime });
		for (const millis of [1000, 2000, 3000, 4000]) {
			currentTime = millis;
			log.record({
				run_id: "run-window",
				event: "gate_response_accepted",
				outcome: "accepted",
				dedupe_key: `t-${millis}`,
			});
		}

		const since = new Date(2000).toISOString();
		const until = new Date(3000).toISOString();
		expect(log.query({ since, until }).map(record => record.dedupe_key)).toEqual(["t-2000", "t-3000"]);
		expect(log.export({ since: until }).map(record => record.dedupe_key)).toEqual(["t-3000", "t-4000"]);
		expect(log.export({ until: since }).map(record => record.dedupe_key)).toEqual(["t-1000", "t-2000"]);
	});

	it("fails closed for corrupt lines at the start, middle, and end", () => {
		for (const [position, contents, expectedLine] of [
			["start", "{ not json\n", 1],
			["middle", "", 2],
			["end", "", 3],
		] as const) {
			const file = tempFile(`${position}.jsonl`);
			const log = new UnattendedAuditLog(file, { now: () => 0, nextId: () => `${position}-id-1` });
			const first = log.record({
				run_id: `run-${position}`,
				event: "first",
				outcome: "info",
				dedupe_key: `${position}-first`,
			});
			const second = log.record({
				run_id: `run-${position}`,
				event: "second",
				outcome: "info",
				dedupe_key: `${position}-second`,
			});
			const validLines = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
			if (position === "start") writeFileSync(file, `${contents}${validLines}`);
			if (position === "middle")
				writeFileSync(file, `${JSON.stringify(first)}\n{ not json\n${JSON.stringify(second)}\n`);
			if (position === "end") writeFileSync(file, `${validLines}{ not json\n`);

			expect(() => log.readAll()).toThrow(new RegExp(`corrupt audit record at .*:${expectedLine}:`));
		}
	});

	it("returns empty arrays before the audit file exists", () => {
		const file = path.join(tempDir(), "missing", "audit.jsonl");
		const log = new UnattendedAuditLog(file);
		expect(log.readAll()).toEqual([]);
		expect(log.query({ run_id: "none" })).toEqual([]);
		expect(log.export({ outcome: "accepted" })).toEqual([]);
	});

	it("redaction removes answers, keeps hashes, and leaves non-answer events unaffected", () => {
		const log = new UnattendedAuditLog(tempFile(), { redactAnswers: true });
		const answer = { secret: "do-not-store", allow: true };
		const gate = log.record({
			run_id: "run-redact",
			event: "gate_response_accepted",
			outcome: "accepted",
			dedupe_key: "gate",
			answer,
			answer_hash: answerHash(answer),
		});
		const budget = log.record({
			run_id: "run-redact",
			event: "budget_exceeded",
			outcome: "exceeded",
			dedupe_key: "budget",
			budget: {
				code: "budget_exceeded",
				metric: "tokens",
				limit: 10,
				observed: 11,
				phase: "reconcile",
				run_id: "run-redact",
				abort_status: "aborted",
			},
		});
		const stored = log.readAll();
		expect(gate?.answer).toBeUndefined();
		expect(stored[0].answer).toBeUndefined();
		expect(stored[0].answer_hash).toBe(answerHash(answer));
		expect(budget).toEqual(stored[1]);
		expect(stored[1]).not.toHaveProperty("answer");
		expect(stored[1].budget).toEqual({
			code: "budget_exceeded",
			metric: "tokens",
			limit: 10,
			observed: 11,
			phase: "reconcile",
			run_id: "run-redact",
			abort_status: "aborted",
		});
	});

	it("writes required fields on every event category", () => {
		const log = new UnattendedAuditLog(tempFile(), { now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
		log.record({
			run_id: "run-fields",
			event: "gate_response_accepted",
			outcome: "accepted",
			dedupe_key: "gate",
			gate_id: "g1",
		});
		log.record({ run_id: "run-fields", event: "budget_exceeded", outcome: "exceeded", dedupe_key: "budget" });
		log.record({
			run_id: "run-fields",
			event: "scope_denied",
			outcome: "denied",
			dedupe_key: "scope",
			scope: "bash",
		});
		log.record({
			run_id: "run-fields",
			event: "action_denied",
			outcome: "denied",
			dedupe_key: "action",
			action: "git.push",
		});

		for (const record of log.readAll()) {
			expect(record.event_id).toBeString();
			expect(record.event_id.length).toBeGreaterThan(0);
			expect(record.schema_version).toBe(AUDIT_SCHEMA_VERSION);
			expect(record.category).toBe(AUDIT_CATEGORY);
			expect(record.timestamp).toBe(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString());
			expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
			expect(record.dedupe_key).toBeString();
			expect(record.dedupe_key.length).toBeGreaterThan(0);
		}
	});

	it("sanitizes defaultAuditPath run ids into a safe single segment under .gjc/audit/unattended", () => {
		const root = tempDir();
		const auditPath = defaultAuditPath("../run with/slashes and spaces", root);
		const relative = path.relative(root, auditPath);
		expect(relative).toBe(path.join(".gjc", "audit", "unattended", ".._run_with_slashes_and_spaces.jsonl"));
		expect(path.dirname(auditPath)).toBe(path.join(root, ".gjc", "audit", "unattended"));
		expect(path.basename(auditPath)).not.toContain("/");
		expect(path.basename(auditPath)).not.toContain(" ");
	});

	it("round-trips a large-ish export volume with count and filters intact", () => {
		const file = tempFile();
		const log = new UnattendedAuditLog(file);
		for (let i = 0; i < 500; i += 1) {
			log.record({
				run_id: i % 2 === 0 ? "run-even" : "run-odd",
				session_id: `session-${i % 5}`,
				actor: i % 3 === 0 ? "hermes" : "other",
				event: i % 7 === 0 ? "budget_exceeded" : "gate_response_accepted",
				outcome: i % 7 === 0 ? "exceeded" : "accepted",
				dedupe_key: `volume-${i}`,
				gate_id: `gate-${i % 11}`,
			});
		}

		const reader = new UnattendedAuditLog(file);
		const all = reader.export();
		expect(all).toHaveLength(500);
		expect(new Set(all.map(record => record.dedupe_key)).size).toBe(500);
		expect(reader.export({ run_id: "run-even" })).toHaveLength(250);
		expect(reader.export({ outcome: "exceeded" })).toHaveLength(72);
		expect(reader.export({ run_id: "run-odd", actor: "hermes", outcome: "accepted" })).toHaveLength(71);
		expect(reader.export({ session_id: "session-4", gate_id: "gate-3" })).toHaveLength(9);
		// 500 records each go through a durable openSync+writeSync+fsyncSync+closeSync;
		// on contended CI disks fsync can run ~10ms+ apiece, so allow headroom past the 5s default.
	}, 30000);
});
