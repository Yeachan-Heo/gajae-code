import * as crypto from "node:crypto";

export interface PreregistrationContract {
	schemaVersion: number;
	experiment: {
		rfc: string;
		phase: string;
		scope: string;
		arms: string[];
		comparisonConcurrency: number;
		brokerFreeArms: boolean;
	};
	thresholds: {
		minimumValidRepsPerArm: number;
		memory: {
			workerToStandaloneMeanMaximum: number;
			sampledPeakRegressionAllowed: boolean;
			concurrency: number;
		};
		turnLatency: { maximumRelativeIncrease: number; percentile: number };
		throughput: { minimumRelativeChange: number };
		eventLoopLag: { maximumP95Ms: number; percentile: number; aggregation: string };
		coldReadiness: { maximumRelativeIncrease: number };
		teardown: { workerHostFootprintMultiplierOfBrokerBaseline: number; sampleDelayAfterFifthCloseMs: number };
		churn: { cycles: number; maximumCycle20GrowthOverCycle1: number };
		orphans: { maximumOwned: number; maximumUnresolvedOwnership: number };
		fidelity: { required: "equal" };
	};
	definitions: Record<string, string | number | boolean>;
	environment: Record<string, string | number | boolean>;
	bindings: {
		workloadDigest: { runtimeValue: string; checkedAgainst: string; digestValueStoredHere: boolean };
		bootstrapDigest: { runtimeValue: string; checkedAgainst: string; digestValueStoredHere: boolean };
	};
	cohort: Record<string, string>;
	broker: Record<string, string>;
	workerPolicyException: string;
	capabilityLabelRule: {
		equal: string;
		differsOrUnavailable: string;
		claimRule: string;
	};
}

export interface PreregistrationReceipt {
	contractDigest: string;
	discussionCommentUrl: string;
	postedAt: string;
}

export interface PreflightRecord {
	sourceSha: string;
	dirty: boolean;
	workloadDigest: string;
	bootstrapDigest: string;
	bunVersion: string;
	osVersion: string;
	contractDigest: string;
	checks: Array<{ name: string; passed: boolean; detail?: string }>;
	result: "pass" | "fail";
}

export type AdmissionResult = { ok: true } | { ok: false; reason: string };

export function canonicalJson(value: unknown): string {
	return encodeCanonical(value, new WeakSet<object>());
}

function encodeCanonical(value: unknown, ancestors: WeakSet<object>): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
		return JSON.stringify(value);
	}
	if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}`);
	if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const items: unknown[] = value as unknown[];
			return `[${items.map(item => encodeCanonical(item, ancestors)).join(",")}]`;
		}
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Canonical JSON only supports plain objects");
		}
		const record = value as Record<string, unknown>;
		const properties = Object.keys(record)
			.filter(key => record[key] !== undefined)
			.sort()
			.map(key => `${JSON.stringify(key)}:${encodeCanonical(record[key], ancestors)}`);
		return `{${properties.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

export function contractDigest(contract: PreregistrationContract): string {
	return crypto.createHash("sha256").update(canonicalJson(contract), "utf8").digest("hex");
}

export async function loadContract(path?: string): Promise<PreregistrationContract> {
	const source = path ?? new URL("./preregistration.json", import.meta.url);
	const parsed: unknown = await Bun.file(source).json();
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError("Preregistration contract must be a JSON object");
	}
	return parsed as PreregistrationContract;
}

export function checkAdmission(
	kind: "preflight" | "worker",
	inputs: {
		contract: PreregistrationContract;
		receipt?: PreregistrationReceipt;
		preflight?: PreflightRecord;
		current: {
			sourceSha: string;
			dirty: boolean;
			workloadDigest: string;
			bootstrapDigest: string;
			bunVersion: string;
		};
	},
): AdmissionResult {
	const currentContractDigest = contractDigest(inputs.contract);
	const { receipt } = inputs;
	if (!receipt) return { ok: false, reason: "Missing preregistration receipt" };
	if (receipt.contractDigest !== currentContractDigest) {
		return { ok: false, reason: "Preregistration receipt does not match the current contract digest" };
	}
	if (!receipt.discussionCommentUrl.trim() || !isHttpsUrl(receipt.discussionCommentUrl)) {
		return { ok: false, reason: "Preregistration receipt has no valid discussion comment URL" };
	}
	if (!receipt.postedAt.trim()) return { ok: false, reason: "Preregistration receipt has no posting timestamp" };
	if (kind === "preflight") return { ok: true };

	const preflight = inputs.preflight;
	if (!preflight) return { ok: false, reason: "Missing preflight record for Worker admission" };
	if (preflight.result !== "pass") return { ok: false, reason: "Preflight did not pass" };
	const failedCheck = preflight.checks.find(check => !check.passed);
	if (failedCheck) return { ok: false, reason: `Preflight check failed: ${failedCheck.name}` };
	if (preflight.dirty) return { ok: false, reason: "Preflight source tree was dirty" };
	if (preflight.sourceSha !== inputs.current.sourceSha) return { ok: false, reason: "Preflight source SHA is stale" };
	if (preflight.workloadDigest !== inputs.current.workloadDigest) {
		return { ok: false, reason: "Preflight workload digest does not match the current workload binding" };
	}
	if (preflight.bootstrapDigest !== inputs.current.bootstrapDigest) {
		return { ok: false, reason: "Preflight bootstrap digest does not match the current configuration binding" };
	}
	if (preflight.bunVersion !== inputs.current.bunVersion) return { ok: false, reason: "Preflight Bun version is stale" };
	if (preflight.contractDigest !== currentContractDigest) {
		return { ok: false, reason: "Preflight contract digest does not match the current contract" };
	}
	if (!inputs.current.dirty) return { ok: true };
	return { ok: false, reason: "Current source tree is dirty" };
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}
