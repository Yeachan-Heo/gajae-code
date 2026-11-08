import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type TranscriptObservation,
	transcriptObservationDiagnostics,
	transcriptObservationFailure,
} from "./fixtures/shared-session-transcript-observation-probe";

const prompts = ["race-from-A", "race-from-B"];
const header = { type: "session", id: "synthetic-session" };
const a = { type: "message", id: "synthetic-A", parentId: null, message: { role: "user", content: prompts[0] } };
const b = { type: "message", id: "synthetic-B", parentId: a.id, message: { role: "user", content: prompts[1] } };

function observation(
	entries: unknown[],
	phase: TranscriptObservation["phase"] = "wait-satisfied",
): TranscriptObservation {
	return {
		phase,
		sequence: phase === "wait-satisfied" ? 7 : 8,
		relativePath: "synthetic/session.jsonl",
		buffer: Buffer.from([header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n"),
	};
}

// Synthetic counterexamples verify only diagnostic discrimination, not a product fix or cause.
describe("shared-session transcript observation probe", () => {
	it("distinguishes raw B inside a prefix/suffix message from an exact prompt", () => {
		const snapshot = observation([a, { ...b, message: { role: "user", content: "prefix race-from-B suffix" } }]);
		const output = JSON.parse(JSON.stringify(transcriptObservationDiagnostics([snapshot], prompts)));
		expect(output.snapshots[0].exactMatchCounts).toEqual({ "race-from-A": 1, "race-from-B": 0 });
		expect(output.snapshots[0].matchingLines[1]).toEqual({
			line: 3,
			raw: JSON.stringify({ ...b, message: { role: "user", content: "prefix race-from-B suffix" } }),
			prompts: [prompts[1]],
			parsed: {
				type: "message",
				id: b.id,
				parentId: a.id,
				messageRole: "user",
				content: "prefix race-from-B suffix",
			},
		});
	});

	it("distinguishes a custom entry containing exact B from a message", () => {
		const custom = { type: "custom", id: "synthetic-custom", parentId: a.id, data: prompts[1] };
		const output = transcriptObservationDiagnostics([observation([a, custom])], prompts);
		expect(output.snapshots[0]!.exactMatchCounts).toEqual({ "race-from-A": 1, "race-from-B": 0 });
		expect(output.snapshots[0]!.matchingLines[1]).toEqual({
			line: 3,
			raw: JSON.stringify(custom),
			prompts: [prompts[1]],
			parsed: { type: "custom", id: custom.id, parentId: a.id, messageRole: null, content: null },
		});
	});

	it("reports the removed B ID after a valid A/B message observation", () => {
		const output = transcriptObservationDiagnostics([observation([a, b]), observation([a], "assertion")], prompts);
		expect(output.snapshots.map(snapshot => snapshot.exactMatchCounts)).toEqual([
			{ "race-from-A": 1, "race-from-B": 1 },
			{ "race-from-A": 1, "race-from-B": 0 },
		]);
		expect(output.removedIds).toEqual([b.id]);
		expect(output.addedIds).toEqual([]);
	});

	it("reports malformed JSON without presenting partial counts or ID differences", () => {
		const malformed = observation([a]);
		malformed.buffer = Buffer.concat([malformed.buffer, Buffer.from('{"message":"race-from-B"\n')]);
		const output = transcriptObservationDiagnostics([malformed, observation([a], "assertion")], prompts);
		expect(output.snapshots[0]!.parseErrors[0]!.line).toBe(3);
		expect(output.snapshots[0]!.parseErrors[0]!.error).toContain("SyntaxError");
		expect(output.snapshots[0]!.matchingLines[1]!.parsed).toBeNull();
		expect(output.snapshots[0]!.exactMatchCounts).toBeNull();
		expect(output.snapshots[0]!.ids).toBeNull();
		expect(output.removedIds).toBeNull();
	});

	it("emits compact cause JSON and retains complete synthetic buffers outside disposable roots", async () => {
		const observations = [observation([a, b]), observation([a], "assertion")];
		const original = new Error("synthetic assertion failure");
		const failure = await transcriptObservationFailure(original, observations, prompts);
		expect(failure.cause).toBeInstanceOf(Error);
		const diagnosticError = failure.cause as Error;
		expect(diagnosticError.cause).toBe(original);
		const output = JSON.parse(diagnosticError.message);
		expect(output.removedIds).toEqual([b.id]);
		expect(output.retentionError).toBeNull();
		expect(output.artifactDirectory).toStartWith("artifacts/shared-session-transcript-observation-probe/failure-");
		const repo = path.resolve(import.meta.dirname, "../../..");
		for (const [index, snapshot] of observations.entries()) {
			const retained = Buffer.from(
				await Bun.file(
					path.join(repo, output.artifactDirectory, `${snapshot.sequence}-${snapshot.phase}.jsonl`),
				).arrayBuffer(),
			);
			expect(retained.equals(snapshot.buffer)).toBe(true);
			expect(output.snapshots[index].bytes).toBe(retained.byteLength);
			expect(output.snapshots[index].sha256).toBe(new Bun.CryptoHasher("sha256").update(retained).digest("hex"));
			expect(output.snapshots[index].relativePath).toBe(snapshot.relativePath);
			expect(output.snapshots[index].sequence).toBe(snapshot.sequence);
		}
	});
});
