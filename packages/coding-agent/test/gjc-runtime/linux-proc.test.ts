import { describe, expect, it } from "bun:test";
import {
	parseLinuxProcStartTime,
	readLinuxProcStartTime,
	readLinuxProcStartTimeSync,
} from "@gajae-code/coding-agent/gjc-runtime/linux-proc";

/**
 * Build a `/proc/<pid>/stat`-shaped string with a configurable comm field and
 * a start-time token (field 22) at index 19 after the closing paren. The comm
 * field is wrapped in parentheses and may itself contain spaces/parens; the
 * parser must anchor on the *last* `)`.
 */
function procStat(comm: string, field22: string, extraAfterClose = ""): string {
	// Fields 3..22 (indices 0..19 after the closing paren). Field 22 is index 19.
	const fields = ["S", ...Array.from({ length: 18 }, () => "0"), field22];
	return `1 (${comm}) ${fields.join(" ")}${extraAfterClose}`;
}

describe("parseLinuxProcStartTime", () => {
	it("parses field 22 from a valid stat string", () => {
		expect(parseLinuxProcStartTime(procStat("init", "1234"))).toBe("1234");
	});

	it("anchors on the last closing paren when comm contains parens and spaces", () => {
		// comm = "foo ) bar baz" — the parser must skip the inner `)` and use the last one.
		expect(parseLinuxProcStartTime(procStat("foo ) bar baz", "99999"))).toBe("99999");
	});

	it("returns null for null and undefined input", () => {
		expect(parseLinuxProcStartTime(null)).toBeNull();
		expect(parseLinuxProcStartTime(undefined)).toBeNull();
	});

	it("returns null for empty string input", () => {
		expect(parseLinuxProcStartTime("")).toBeNull();
	});

	it("returns null when the closing paren is missing", () => {
		expect(parseLinuxProcStartTime("1 (no-close S 0 0 1234")).toBeNull();
		expect(parseLinuxProcStartTime("malformed")).toBeNull();
	});

	it("returns null when field 22 is absent (too few trailing fields)", () => {
		// Only 19 trailing fields (indices 0..18) — field 22 (index 19) is missing.
		const shortFields = ["S", ...Array.from({ length: 17 }, () => "0")];
		expect(parseLinuxProcStartTime(`1 (owner) ${shortFields.join(" ")}`)).toBeNull();
	});

	it("returns null when field 22 is non-numeric", () => {
		expect(parseLinuxProcStartTime(procStat("owner", "not-a-number"))).toBeNull();
		expect(parseLinuxProcStartTime(procStat("owner", ""))).toBeNull();
	});

	it("rejects malformed record boundaries and fields", () => {
		expect(parseLinuxProcStartTime(`x${procStat("owner", "1234")}`)).toBeNull();
		expect(parseLinuxProcStartTime(procStat("owner", "1234").replace(") ", ")"))).toBeNull();
		expect(parseLinuxProcStartTime(procStat("owner", "1234").replace(") S", ") Q"))).toBeNull();
		expect(parseLinuxProcStartTime(`${procStat("owner", "1234")}\nsecond record`)).toBeNull();
		expect(parseLinuxProcStartTime(`${procStat("owner", "1234")}\0`)).toBeNull();
	});

	it("accepts a single terminal newline and fields after field 22", () => {
		expect(parseLinuxProcStartTime(`${procStat("owner", "1234", " 99 100")}\n`)).toBe("1234");
	});

	it("parses a large numeric start time", () => {
		expect(parseLinuxProcStartTime(procStat("tmux", "18446744073709551615"))).toBe("18446744073709551615");
	});
});

describe("readLinuxProcStartTimeSync", () => {
	it("returns null on non-Linux platforms", () => {
		if (process.platform === "linux") return; // not applicable here
		expect(readLinuxProcStartTimeSync(process.pid)).toBeNull();
	});

	it("returns a non-null numeric start time for the current PID on Linux", () => {
		if (process.platform !== "linux") return; // skipped on non-Linux
		const startTime = readLinuxProcStartTimeSync(process.pid);
		expect(startTime).not.toBeNull();
		expect(startTime).toMatch(/^\d+$/);
	});

	it("returns null for an invalid PID", () => {
		expect(readLinuxProcStartTimeSync(0)).toBeNull();
		expect(readLinuxProcStartTimeSync(-1)).toBeNull();
		expect(readLinuxProcStartTimeSync(Number.NaN)).toBeNull();
	});

	it("returns null for a PID whose /proc entry cannot be read", () => {
		if (process.platform !== "linux") return; // skipped on non-Linux
		// PID 2147483647 is effectively guaranteed not to exist / be unreadable.
		expect(readLinuxProcStartTimeSync(2_147_483_647)).toBeNull();
	});
});

describe("readLinuxProcStartTime", () => {
	it("returns null on non-Linux platforms", async () => {
		if (process.platform === "linux") return; // not applicable here
		expect(await readLinuxProcStartTime(process.pid)).toBeNull();
	});

	it("returns a non-null numeric start time for the current PID on Linux", async () => {
		if (process.platform !== "linux") return; // skipped on non-Linux
		const startTime = await readLinuxProcStartTime(process.pid);
		expect(startTime).not.toBeNull();
		expect(startTime).toMatch(/^\d+$/);
	});

	it("returns null for an invalid PID", async () => {
		expect(await readLinuxProcStartTime(0)).toBeNull();
		expect(await readLinuxProcStartTime(-1)).toBeNull();
	});
});
