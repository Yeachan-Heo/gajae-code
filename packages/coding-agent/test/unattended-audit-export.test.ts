import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { UnattendedAuditLog } from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-audit";

function seededLog(): { file: string; log: UnattendedAuditLog } {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "audit-export-")), "run.jsonl");
	const log = new UnattendedAuditLog(file);
	log.record({
		run_id: "run-A",
		session_id: "s1",
		actor: "hermes",
		event: "gate_response_accepted",
		outcome: "accepted",
		dedupe_key: "A-g1",
		gate_id: "g1",
	});
	log.record({
		run_id: "run-A",
		session_id: "s1",
		actor: "hermes",
		event: "scope_denied",
		outcome: "denied",
		dedupe_key: "A-s",
		scope: "bash",
	});
	log.record({
		run_id: "run-A",
		session_id: "s2",
		actor: "other",
		event: "gate_response_accepted",
		outcome: "accepted",
		dedupe_key: "A-g2",
		gate_id: "g2",
	});
	log.record({
		run_id: "run-A",
		session_id: "s1",
		actor: "hermes",
		event: "budget_exceeded",
		outcome: "exceeded",
		dedupe_key: "A-b",
	});
	return { file, log };
}

describe("get_unattended_audit export/query", () => {
	it("filters by run/session/actor/gate/outcome", () => {
		const { log } = seededLog();
		expect(log.query({ run_id: "run-A" })).toHaveLength(4);
		expect(log.query({ session_id: "s1" })).toHaveLength(3);
		expect(log.query({ actor: "other" })).toHaveLength(1);
		expect(log.query({ gate_id: "g2" })).toHaveLength(1);
		expect(log.query({ outcome: "denied" }).map(r => r.event)).toEqual(["scope_denied"]);
		expect(log.query({ outcome: "exceeded" }).map(r => r.event)).toEqual(["budget_exceeded"]);
	});

	it("combines filters (AND semantics)", () => {
		const { log } = seededLog();
		expect(log.query({ session_id: "s1", outcome: "accepted" })).toHaveLength(1);
		expect(log.query({ actor: "hermes", gate_id: "g2" })).toHaveLength(0);
	});

	it("exports the full trail from a fresh reader after the run", () => {
		const { file } = seededLog();
		const reader = new UnattendedAuditLog(file);
		const all = reader.export();
		expect(all).toHaveLength(4);
		expect(all.every(r => r.schema_version === 1 && r.category === "unattended_lifecycle")).toBe(true);
	});
});
