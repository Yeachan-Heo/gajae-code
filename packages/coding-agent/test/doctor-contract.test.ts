import { describe, expect, test } from "bun:test";
import { parseDoctorArgs } from "../src/cli/doctor/args";
import { canonicalDigest, configTargetId, isDoctorTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import { finalizeReport, renderDoctorJson, renderDoctorText } from "../src/cli/doctor/report";
import type { DoctorRepair, RepairState } from "../src/cli/doctor/types";

const R = `r${"a".repeat(64)}`;
const binary = `t1:binary:${R}:standalone:p${"b".repeat(64)}`;
const service = `t1:service:${R}:broker`;
const check = (health: "ok" | "warning" | "error" | "unknown" = "ok") => ({
	id: "c",
	targetId: service,
	execution: "completed" as const,
	health,
	evidenceLevel: "observed" as const,
	dependsOn: [],
	evidence: { runtimeVersion: "v", unknownSecret: "nope" },
	remediationIds: [],
});
const base = {
	runId: "run",
	generatedAt: new Date(0).toISOString(),
	durationMs: 1,
	subject: { gjcVersion: "v", platform: "x", arch: "y", channel: "z", rootIds: [] },
	selection: { checks: [] },
	coverage: { requested: 1, expanded: 1, attempted: 1, completed: 1, blocked: 0, timedOut: 0, unsupported: 0 },
};

describe("doctor contracts", () => {
	test("never reflects rejected argument values into diagnostics", () => {
		const secret = "private-sentinel\n\u001b[31m";
		expect(parseDoctorArgs(["--allow-risk", secret]).error).toBe("unknown risk class");
		expect(parseDoctorArgs(["--repair", secret]).error).toBe("unknown repair action");
		expect(parseDoctorArgs([secret]).error).toBe("unexpected argument");
	});
	test.each([
		["blocked", false, 3],
		["preparing", false, 3],
		["failed", false, 3],
		["failed", true, 4],
		["rolled_back", true, 4],
		// Physical states establish an effect even when an adapter reports a false
		// flag, so each one must reach exit 4 on the flag alone being wrong.
		["uncertain", false, 4],
		["uncertain", true, 4],
		["rolled_back", false, 4],
		["pending_activation", false, 4],
		["pending_activation", true, 4],
		["rollback_conflict", true, 4],
		["rollback_conflict", false, 4],
		["verified", true, 0],
		["not_needed", false, 0],
	] satisfies [
		RepairState,
		boolean,
		number,
	][])("maps actual repair state %s and side effects %s to exit %s", (state, sideEffectStarted, expected) => {
		const repair: DoctorRepair = {
			id: "service.restart-owned",
			targetId: service,
			riskClasses: ["service-interruption"],
			authorization: [],
			readiness: [],
			candidates: [],
			preconditions: [],
			state,
			sideEffectStarted,
			beforeCheckIds: [],
			afterCheckIds: [],
			restartRequired: false,
			nonrollbackableEffects: [],
		};
		expect(finalizeReport({ ...base, mode: "fix", checks: [check()], repairs: [repair] }).summary.exitCode).toBe(
			expected,
		);
	});

	test("retains historical findings but computes verified repair health from fresh checks", () => {
		const repair: DoctorRepair = {
			id: "service.restart-owned",
			targetId: service,
			riskClasses: ["service-interruption"],
			authorization: ["service-interruption"],
			readiness: [],
			candidates: [],
			preconditions: [],
			state: "verified",
			sideEffectStarted: true,
			beforeCheckIds: ["before.c"],
			afterCheckIds: ["c"],
			restartRequired: false,
			nonrollbackableEffects: [],
		};
		const report = finalizeReport({
			...base,
			mode: "fix",
			repairs: [repair],
			checks: [{ ...check("error"), id: "before.c" }, check()],
		});
		expect(report.summary).toEqual({ verdict: "healthy", exitCode: 0 });
		expect(report.checks[0].health).toBe("error");
		const missingAfter = finalizeReport({
			...base,
			mode: "fix",
			repairs: [repair],
			checks: [{ ...check("error"), id: "before.c" }],
		});
		expect(missingAfter.summary.exitCode).toBe(1);
		const preview = finalizeReport({
			...base,
			mode: "dry-run",
			checks: [check()],
			repairs: [
				{
					...repair,
					state: "blocked",
					sideEffectStarted: false,
					readiness: ["authorization_missing"],
					afterCheckIds: [],
				},
			],
		});
		expect(preview.summary.exitCode).toBe(0);
	});

	test("framed IDs are stable, root-sensitive, and fully validated", () => {
		expect(canonicalDigest(["a", "b"])).not.toBe(canonicalDigest(["a|b"]));
		const root = resolveDoctorRoot("config-user", process.cwd());
		expect(configTargetId(root.rootId, "user", "skills.enabled")).toMatch(
			/^t1:config:r[0-9a-f]{64}:user:skills\.enabled$/,
		);
		expect(isDoctorTargetId(binary)).toBe(true);
		expect(isDoctorTargetId(`${binary}:junk`)).toBe(false);
		expect(isDoctorTargetId("t1:bogus:x")).toBe(false);
		expect(isDoctorTargetId(`c1:link:${R}:source:p${"b".repeat(64)}`)).toBe(false);
	});

	test("all action grammar, repeats, and typed values", () => {
		const cases: [string[], boolean][] = [
			[["--check=a", "--check", "b", "--allow-risk", "config-change"], true],
			[
				[
					"--fix",
					"--repair",
					"config.set-validated",
					"--target",
					`t1:config:${R}:user:skills.enabled`,
					"--set-value-json",
					"false",
				],
				true,
			],
			[["--fix", "--repair", "install.restore-binary", "--target", binary], true],
			[["--fix", "--repair", "service.restart-owned", "--target", service, "--drain"], true],
			[["--fix", "--repair", "install.repair-managed-link", "--target", `t1:link:${R}:p${"b".repeat(64)}`], false],
			[
				["--dry-run", "--repair", "install.repair-managed-link", "--target", `t1:link:${R}:p${"b".repeat(64)}`],
				true,
			],
			[["--fix", "--repair", "service.restart-owned", "--target", binary], false],
			[["--fix", "--repair", "plugin.quarantine-selected", "--target", service], false],
			[["--fix", "--repair", "config.set-validated", "--repair", "mcp.set-startup-policy"], false],
			[["--timeout-ms", "999"], false],
			[["--repair", "config.set-validated", "--ref", "x"], false],
			[["--scope", "user", "--target", service], false],
			[["--drain"], false],
		];
		for (const [argv, ok] of cases) expect(parseDoctorArgs(argv).options !== undefined).toBe(ok);
		expect(
			parseDoctorArgs(["--fix", "--repair", "install.restore-binary", "--target", binary]).options,
		).toBeDefined();
		expect(
			parseDoctorArgs([
				"--fix",
				"--repair",
				"install.restore-binary",
				"--target",
				binary,
				"--ref=x=y",
				"--sha256",
				"c".repeat(64),
			]).options?.ref,
		).toBe("x=y");
	});

	test("finalizer exit/readiness matrix and renderer parity", () => {
		expect(finalizeReport({ ...base, mode: "diagnose", checks: [check()] }).summary.exitCode).toBe(0);
		expect(finalizeReport({ ...base, mode: "diagnose", checks: [check("error")] }).summary.exitCode).toBe(1);
		expect(finalizeReport({ ...base, mode: "diagnose", checks: [check("unknown")] }).summary.exitCode).toBe(3);
		const pending = {
			id: "r",
			targetId: service,
			riskClasses: [],
			authorization: [],
			readiness: [],
			candidates: [],
			preconditions: [],
			state: "pending_activation" as const,
			beforeCheckIds: [],
			afterCheckIds: [],
			restartRequired: false,
			nonrollbackableEffects: [],
		};
		const report = finalizeReport({ ...base, mode: "fix", checks: [check()], repairs: [pending] });
		expect(report.summary.exitCode).toBe(4);
		expect(JSON.parse(renderDoctorJson(report)).summary.exitCode).toBe(4);
		expect(renderDoctorText(report)).toContain("exit: 4");
		expect(finalizeReport({ ...base, mode: "diagnose", checks: [], interrupted: true }).summary.exitCode).toBe(130);
		expect("unknownSecret" in report.checks[0].evidence).toBe(false);
	});
});
