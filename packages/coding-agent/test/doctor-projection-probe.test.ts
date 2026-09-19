import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type {
	CustomizeDoctorItem,
	CustomizeDoctorReport,
	CustomizeDoctorSurface,
	CustomizeSurfaceKind,
} from "../src/cli/customize-doctor";
import * as customizeDoctor from "../src/cli/customize-doctor";
import { PROJECTION_RECEIPT_BUDGET_BYTES } from "../src/cli/doctor/probe-types";
import { collectProjectionProbe } from "../src/cli/doctor/projection-probe";

const spies: { mockRestore(): void }[] = [];

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

function syntheticItem(
	kind: CustomizeSurfaceKind,
	index: number,
	health: "ok" | "warning" | "error",
): CustomizeDoctorItem {
	const name = `${kind}-item-${index.toString().padStart(4, "0")}`;
	return {
		name,
		kind,
		sourceClass: "canonical",
		convention: "gjc",
		provider: "bundled",
		providerName: "GJC Bundled",
		scope: "user",
		path: `/synthetic/${kind}/${name}`,
		status: health === "warning" ? "rejected" : "loaded",
		reason: health === "warning" ? "quarantined" : health === "error" ? "load-error" : "loaded",
		detail: "synthetic projection item",
		remediation: [],
		trust: "synthetic",
		restartRequired: true,
		precedence: { priority: 0 },
	};
}

function syntheticSurface(kind: CustomizeSurfaceKind, items: CustomizeDoctorItem[]): CustomizeDoctorSurface {
	return {
		kind,
		displayName: kind,
		description: kind,
		precedence: [],
		items,
	};
}

function syntheticReport(surfaces: CustomizeDoctorSurface[]): CustomizeDoctorReport {
	return {
		schemaVersion: 1,
		command: "customize doctor",
		cwd: process.cwd(),
		generatedAt: new Date(0).toISOString(),
		policy: {
			skillsEnabled: true,
			skillScopeNotes: [],
			disabledProviders: [],
			mcpNote: "synthetic",
			conventionsNotLoaded: [],
			globalImportCandidateDirs: [],
			sourceClasses: [],
		},
		surfaces,
		summary: {},
		warnings: [],
	};
}

function stubProjection(report: CustomizeDoctorReport): void {
	const spy = spyOn(customizeDoctor, "runCustomizeDoctor").mockResolvedValue(report);
	spies.push(spy);
}

describe("doctor projection probe receipt budget", () => {
	test("summarizes healthy items and emits only actionable item checks", async () => {
		const skillItems = [
			...Array.from({ length: 260 }, (_, index) => syntheticItem("skill", index, "ok")),
			syntheticItem("skill", 260, "warning"),
			syntheticItem("skill", 261, "error"),
		];
		const hookItems = [syntheticItem("hook", 0, "ok"), syntheticItem("hook", 1, "ok")];
		stubProjection(syntheticReport([syntheticSurface("skill", skillItems), syntheticSurface("hook", hookItems)]));

		const receipt = await collectProjectionProbe();
		expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(PROJECTION_RECEIPT_BUDGET_BYTES);
		expect(receipt.status).toBe("completed");

		for (const kind of ["skill", "hook"] as const) {
			expect(receipt.checks.some(check => check.id === `projection.${kind}.coverage`)).toBe(true);
		}
		expect(receipt.checks.some(check => check.id === "projection.coverage")).toBe(true);

		// 262 skill items collapse to exactly the two actionable ones; no healthy
		// item contributes a check, so nothing is shed for budget.
		expect(receipt.checks.filter(check => check.health === "warning")).toHaveLength(1);
		expect(receipt.checks.filter(check => check.health === "error")).toHaveLength(1);
		expect(receipt.checks.some(check => check.reasonCode === "limit_exceeded")).toBe(false);

		const skillCoverage = receipt.checks.find(check => check.id === "projection.skill.coverage");
		if (!skillCoverage) throw new Error("skill coverage check was shed");
		expect(skillCoverage.evidence.count).toBe(skillItems.length);
		expect(skillCoverage.evidence.counts).toBeUndefined();

		const hookItemChecks = receipt.checks.filter(
			check => check.id.startsWith("projection.hook.") && check.id !== "projection.hook.coverage",
		);
		expect(hookItemChecks).toHaveLength(0);
	});

	test("keeps a fully healthy projection completed so the doctor verdict is not inconclusive", async () => {
		const items = Array.from({ length: 193 }, (_, index) => syntheticItem("skill", index, "ok"));
		stubProjection(syntheticReport([syntheticSurface("skill", items)]));

		const receipt = await collectProjectionProbe();
		expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(PROJECTION_RECEIPT_BUDGET_BYTES);
		expect(receipt.status).toBe("completed");
		expect(receipt.checks.every(check => check.execution === "completed")).toBe(true);
		expect(receipt.checks.some(check => check.reasonCode === "limit_exceeded")).toBe(false);

		const coverage = receipt.checks.find(check => check.id === "projection.skill.coverage");
		if (!coverage) throw new Error("skill coverage check was missing");
		expect(coverage).toMatchObject({ execution: "completed", health: "ok", reasonCode: "projection_collected" });
		expect(coverage.evidence.count).toBe(items.length);
		expect(coverage.evidence.counts).toBeUndefined();

		const aggregate = receipt.checks.find(check => check.id === "projection.coverage");
		if (!aggregate) throw new Error("aggregate coverage check was missing");
		expect(aggregate).toMatchObject({ execution: "completed", health: "ok" });
	});

	test("sheds actionable item checks only when they alone exceed the budget", async () => {
		const items = Array.from({ length: 4000 }, (_, index) => syntheticItem("skill", index, "error"));
		stubProjection(syntheticReport([syntheticSurface("skill", items)]));

		const receipt = await collectProjectionProbe();
		expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(PROJECTION_RECEIPT_BUDGET_BYTES);
		expect(receipt.status).toBe("completed");

		const coverage = receipt.checks.find(check => check.id === "projection.skill.coverage");
		if (!coverage) throw new Error("skill coverage check was shed");
		expect(coverage).toMatchObject({ execution: "blocked", health: "unknown", reasonCode: "limit_exceeded" });
		expect(coverage.evidence.count).toBe(items.length);
		const counts = coverage.evidence.counts;
		if (!counts) throw new Error("truncated coverage must report emitted/omitted counts");
		expect(counts.omitted).toBeGreaterThan(0);
		expect(counts.emitted + counts.omitted).toBe(items.length);
	});
});
