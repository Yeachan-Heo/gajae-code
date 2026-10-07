import { beforeAll, describe, expect, it } from "bun:test";
import {
	canonicalJson,
	checkAdmission,
	contractDigest,
	loadContract,
	type PreflightRecord,
	type PreregistrationContract,
	type PreregistrationReceipt,
} from "../bench/multisession/contract";

let contract: PreregistrationContract;

beforeAll(async () => {
	contract = await loadContract();
});

function admissionInputs(): {
	contract: PreregistrationContract;
	receipt: PreregistrationReceipt;
	preflight: PreflightRecord;
	current: { sourceSha: string; dirty: boolean; workloadDigest: string; bootstrapDigest: string; bunVersion: string };
} {
	const current = {
		sourceSha: "source-sha-1",
		dirty: false,
		workloadDigest: "workload-digest-1",
		bootstrapDigest: "bootstrap-digest-1",
		bunVersion: "bun-1.4.0",
	};
	const digest = contractDigest(contract);
	return {
		contract,
		receipt: {
			contractDigest: digest,
			discussionCommentUrl: "https://github.com/gajae-code/gajae-code/discussions/6247#discussioncomment-1",
			postedAt: "2026-10-04T05:00:00.000Z",
		},
		preflight: {
			sourceSha: current.sourceSha,
			dirty: false,
			workloadDigest: current.workloadDigest,
			bootstrapDigest: current.bootstrapDigest,
			bunVersion: current.bunVersion,
			osVersion: "Darwin 25.5.0",
			contractDigest: digest,
			checks: [{ name: "worker-survives-close-barrier", passed: true }],
			result: "pass",
		},
		current,
	};
}

describe("multi-session contract admission", () => {
	it("loads the immutable preregistration without runtime digest values", async () => {
		const loaded = await loadContract();
		expect(loaded.environment.platform).toBe("darwin-arm64");
		expect(loaded.environment.smol).toBe(false);
		expect(loaded.bindings.workloadDigest.digestValueStoredHere).toBe(false);
		expect(loaded.bindings.bootstrapDigest.digestValueStoredHere).toBe(false);
		expect("workloadDigest" in loaded).toBe(false);
		expect("bootstrapDigest" in loaded).toBe(false);
	});

	it("canonicalizes nested object keys while preserving array order", () => {
		expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe('{"a":{"x":3,"y":2},"list":[2,1],"z":1}');
		expect(canonicalJson({ b: true, a: 1 })).toBe(canonicalJson({ a: 1, b: true }));
	});

	it("refuses preflight admission when the preregistration receipt is missing", () => {
		const inputs = admissionInputs();
		expect(
			checkAdmission("preflight", {
				contract: inputs.contract,
				preflight: inputs.preflight,
				current: inputs.current,
			}),
		).toEqual({ ok: false, reason: "Missing preregistration receipt" });
		expect(
			checkAdmission("worker", { contract: inputs.contract, preflight: inputs.preflight, current: inputs.current }),
		).toEqual({ ok: false, reason: "Missing preregistration receipt" });
	});

	it("rejects a contract altered after its receipt was posted", () => {
		const inputs = admissionInputs();
		const altered = structuredClone(inputs.contract);
		altered.thresholds.memory.workerToStandaloneMeanMaximum = 0.51;
		expect(checkAdmission("worker", { ...inputs, contract: altered })).toEqual({
			ok: false,
			reason: "Preregistration receipt does not match the current contract digest",
		});
	});

	it("rejects a failed preflight", () => {
		const inputs = admissionInputs();
		inputs.preflight.result = "fail";
		expect(checkAdmission("worker", inputs)).toEqual({ ok: false, reason: "Preflight did not pass" });
	});

	it("rejects a stale preflight source SHA", () => {
		const inputs = admissionInputs();
		inputs.preflight.sourceSha = "old-source-sha";
		expect(checkAdmission("worker", inputs)).toEqual({ ok: false, reason: "Preflight source SHA is stale" });
	});

	it("rejects dirty current and preflight trees", () => {
		const dirtyCurrent = admissionInputs();
		dirtyCurrent.current.dirty = true;
		expect(checkAdmission("worker", dirtyCurrent)).toEqual({ ok: false, reason: "Current source tree is dirty" });

		const dirtyPreflight = admissionInputs();
		dirtyPreflight.preflight.dirty = true;
		expect(checkAdmission("worker", dirtyPreflight)).toEqual({
			ok: false,
			reason: "Preflight source tree was dirty",
		});
	});

	it("binds Worker admission to workload, bootstrap, Bun, contract, and passing checks", () => {
		const inputs = admissionInputs();
		expect(checkAdmission("worker", inputs)).toEqual({ ok: true });

		const wrongWorkload = admissionInputs();
		wrongWorkload.current.workloadDigest = "different-workload";
		expect(checkAdmission("worker", wrongWorkload)).toEqual({
			ok: false,
			reason: "Preflight workload digest does not match the current workload binding",
		});

		const failedCheck = admissionInputs();
		failedCheck.preflight.checks.push({ name: "host-stays-alive", passed: false });
		expect(checkAdmission("worker", failedCheck)).toEqual({
			ok: false,
			reason: "Preflight check failed: host-stays-alive",
		});
	});

	it("admits a preflight after a valid discussion receipt without requiring a prior preflight", () => {
		const inputs = admissionInputs();
		expect(
			checkAdmission("preflight", { contract: inputs.contract, receipt: inputs.receipt, current: inputs.current }),
		).toEqual({ ok: true });
	});
});
