/**
 * Deterministic coverage for the `GJC_SESSION_CONTEXT_BUDGET_BYTES` override
 * contract.
 *
 * The resolver is a pure function of its override argument, so every branch —
 * canonical accept, fail-closed fallback, ceiling, safe-integer bound, and
 * warning emission — is covered without process/module reloads. The production
 * default (512 MiB) is verified through a clean-subprocess probe because the
 * test preload deliberately pins the in-process budget to 64 MiB so the
 * overflow-reliant fixtures keep triggering the preflight; the subprocess
 * asserts the real production resolution, so the pin cannot drift from
 * production semantics silently.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import {
	resolveSessionContextBudgetBytes,
	SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT,
	SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_MAX,
} from "../../src/session/session-manager";

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const PROBE = path.join(import.meta.dir, "..", "fixtures", "session-context-budget-probe.ts");

afterEach(() => {
	vi.restoreAllMocks();
});

/** Run the probe in a fresh subprocess with a scrubbed environment. */
function probeProductionBudget(): number {
	const env = { ...process.env } as Record<string, string>;
	delete env.GJC_SESSION_CONTEXT_BUDGET_BYTES;
	const result = Bun.spawnSync({
		cmd: [process.execPath, PROBE],
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	const parsed = JSON.parse(result.stdout.toString()) as { budgetBytes: number };
	return parsed.budgetBytes;
}

describe("SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES default", () => {
	it("is the 512 MiB production default", () => {
		expect(SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT).toBe(512 * MIB);
	});

	it("resolves to the 512 MiB default in a clean production-equivalent process", () => {
		// No GJC_SESSION_CONTEXT_BUDGET_BYTES in the subprocess environment: the
		// module-load-time constant must equal the documented production default.
		expect(probeProductionBudget()).toBe(512 * MIB);
	});

	it("caps the override ceiling at 8 GiB so the memory guard stays meaningful", () => {
		expect(SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_MAX).toBe(8 * GIB);
	});
});

describe("resolveSessionContextBudgetBytes fail-closed parsing", () => {
	it.each([
		[undefined, "undefined (unset)"],
		["", "empty string"],
		["   ", "whitespace only"],
		["abc", "non-numeric"],
		["1e9", "scientific notation is not a canonical integer"],
		["512abc", "trailing garbage"],
		["0x40", "hex is not a canonical decimal integer"],
		["1.5", "fractional"],
		["-1", "negative"],
		["0", "zero"],
		["-536870912", "negative magnitude"],
		["9007199254740992", "2^53 (not a safe integer)"],
		["18446744073709551616", "2^64 (unsigned 64-bit overflow)"],
		["999999999999999999999999999999999999999", "beyond any integer range"],
		[String(8 * GIB + 1), "one past the 8 GiB ceiling"],
	])("rejects %j (%s) and falls back to the 512 MiB default", (override, _label) => {
		expect(resolveSessionContextBudgetBytes(override)).toBe(SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT);
	});

	it("warns whenever an override is dropped so a silent misconfiguration is impossible", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const result = resolveSessionContextBudgetBytes("garbage");
		expect(result).toBe(SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT);
		expect(warn).toHaveBeenCalled();
	});

	it("warns when an explicitly empty override is dropped", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(resolveSessionContextBudgetBytes("")).toBe(SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT);
		expect(warn).toHaveBeenCalled();
	});

	it("does not warn when the override is unset", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(resolveSessionContextBudgetBytes(undefined)).toBe(SESSION_CONTEXT_MATERIALIZATION_BUDGET_BYTES_DEFAULT);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("resolveSessionContextBudgetBytes canonical acceptance", () => {
	it.each([
		["1", 1, "minimum positive value"],
		[String(64 * MIB), 64 * MIB, "the former 64 MiB bound"],
		[String(512 * MIB), 512 * MIB, "the new default"],
		[String(8 * GIB), 8 * GIB, "the ceiling itself is honored"],
	])("accepts %s → %d (%s)", (override, expected, _label) => {
		expect(resolveSessionContextBudgetBytes(override)).toBe(expected);
	});

	it("does not warn for a valid override", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(resolveSessionContextBudgetBytes(String(128 * MIB))).toBe(128 * MIB);
		expect(warn).not.toHaveBeenCalled();
	});
});
