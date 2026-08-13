import { describe, expect, it } from "bun:test";
import {
	parseLinuxProcStartTime,
	parseLinuxProcState,
	parseLinuxProcTtyDevice,
	probeLinuxProcPid,
	probeLinuxProcPidSync,
	readLinuxProcStartTime,
	readLinuxProcStartTimeSync,
} from "@gajae-code/coding-agent/gjc-runtime/linux-proc";

/**
 * Build a `/proc/<pid>/stat`-shaped string with configurable identity fields.
 * The comm field is wrapped in parentheses and may itself contain spaces/parens;
 * the parser must anchor on the *last* `)`.
 */
function procStat(comm: string, field22: string, ttyDevice = "0", extraAfterClose = "", state = "S"): string {
	const fields = [state, "0", "0", "0", ttyDevice, ...Array.from({ length: 14 }, () => "0"), field22];
	return `1 (${comm}) ${fields.join(" ")}${extraAfterClose}`;
}

describe("parseLinuxProcStartTime", () => {
	it("parses field 22 from a valid stat string", () => {
		expect(parseLinuxProcStartTime(procStat("init", "1234"))).toBe("1234");
	});

	it("anchors on the last closing paren when comm contains parens and spaces", () => {
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
		const shortFields = ["S", "0", "0", "0", "0", ...Array.from({ length: 13 }, () => "0")];
		expect(parseLinuxProcStartTime(`1 (owner) ${shortFields.join(" ")}`)).toBeNull();
	});

	it("returns null when field 22 is non-numeric", () => {
		expect(parseLinuxProcStartTime(procStat("owner", "not-a-number"))).toBeNull();
		expect(parseLinuxProcStartTime(procStat("owner", ""))).toBeNull();
	});

	it("rejects malformed record boundaries and fields", () => {
		expect(parseLinuxProcStartTime(`x${procStat("owner", "1234")}`)).toBeNull();
		expect(parseLinuxProcStartTime(procStat("owner", "1234").replace(") ", ")"))).toBeNull();
		expect(parseLinuxProcStartTime(procStat("owner", "1234").replace(") S", ") 1"))).toBeNull();
		expect(parseLinuxProcStartTime(`${procStat("owner", "1234")}\nsecond record`)).toBeNull();
		expect(parseLinuxProcStartTime(`${procStat("owner", "1234")}\0`)).toBeNull();
	});

	it("accepts a single terminal newline and fields after field 22", () => {
		expect(parseLinuxProcStartTime(`${procStat("owner", "1234", "0", " 99 100")}\n`)).toBe("1234");
	});

	it("parses a large numeric start time", () => {
		expect(parseLinuxProcStartTime(procStat("tmux", "18446744073709551615"))).toBe("18446744073709551615");
	});

	it("accepts every single-letter Linux process state code", () => {
		for (const state of ["K", "W", "x"]) {
			expect(parseLinuxProcStartTime(procStat("owner", "1234", "0", "", state))).toBe("1234");
		}
	});
});

describe("parseLinuxProcState", () => {
	it("returns the exact single-letter process state", () => {
		expect(parseLinuxProcState(procStat("running", "1234", "0", "", "R"))).toBe("R");
		expect(parseLinuxProcState(procStat("zombie", "1234", "0", "", "Z"))).toBe("Z");
	});

	it("rejects malformed process states", () => {
		expect(parseLinuxProcState(procStat("owner", "1234").replace(") S", ") ZZ"))).toBeNull();
	});
});

describe("parseLinuxProcTtyDevice", () => {
	it("parses field 7 from a valid stat string", () => {
		expect(parseLinuxProcTtyDevice(procStat("owner", "1234", "2049"))).toBe("2049");
	});
});

describe("probeLinuxProcPidSync", () => {
	it("returns an explicit unsupported result on non-Linux platforms", () => {
		if (process.platform === "linux") return;
		expect(probeLinuxProcPidSync(process.pid)).toEqual({ kind: "unverifiable", reason: "unsupported_platform" });
	});

	it("returns a live identity for the current PID on Linux", () => {
		if (process.platform !== "linux") return;
		const probe = probeLinuxProcPidSync(process.pid);
		expect(probe.kind).toBe("live");
		if (probe.kind !== "live") return;
		expect(probe.state).toMatch(/^[A-Za-z]$/);
		expect(probe.startTime).toMatch(/^\d+$/);
		expect(probe.ttyDevice).toMatch(/^-?\d+$/);
	});

	it("returns an explicit invalid-pid result", () => {
		expect(probeLinuxProcPidSync(0)).toEqual({ kind: "unverifiable", reason: "invalid_pid" });
		expect(probeLinuxProcPidSync(-1)).toEqual({ kind: "unverifiable", reason: "invalid_pid" });
		expect(probeLinuxProcPidSync(Number.NaN)).toEqual({ kind: "unverifiable", reason: "invalid_pid" });
	});

	it("returns absent for a PID whose /proc entry cannot be read", () => {
		if (process.platform !== "linux") return;
		expect(probeLinuxProcPidSync(2_147_483_647)).toEqual({ kind: "absent" });
	});
});

describe("probeLinuxProcPid", () => {
	it("returns an explicit unsupported result on non-Linux platforms", async () => {
		if (process.platform === "linux") return;
		expect(await probeLinuxProcPid(process.pid)).toEqual({ kind: "unverifiable", reason: "unsupported_platform" });
	});

	it("returns a live identity for the current PID on Linux", async () => {
		if (process.platform !== "linux") return;
		const probe = await probeLinuxProcPid(process.pid);
		expect(probe.kind).toBe("live");
		if (probe.kind !== "live") return;
		expect(probe.startTime).toMatch(/^\d+$/);
		expect(probe.ttyDevice).toMatch(/^-?\d+$/);
	});

	it("returns an explicit invalid-pid result", async () => {
		expect(await probeLinuxProcPid(0)).toEqual({ kind: "unverifiable", reason: "invalid_pid" });
		expect(await probeLinuxProcPid(-1)).toEqual({ kind: "unverifiable", reason: "invalid_pid" });
	});
});

describe("readLinuxProcStartTimeSync", () => {
	it("returns null on non-Linux platforms", () => {
		if (process.platform === "linux") return;
		expect(readLinuxProcStartTimeSync(process.pid)).toBeNull();
	});

	it("returns a non-null numeric start time for the current PID on Linux", () => {
		if (process.platform !== "linux") return;
		const startTime = readLinuxProcStartTimeSync(process.pid);
		expect(startTime).not.toBeNull();
		expect(startTime).toMatch(/^\d+$/);
	});
});

describe("readLinuxProcStartTime", () => {
	it("returns null on non-Linux platforms", async () => {
		if (process.platform === "linux") return;
		expect(await readLinuxProcStartTime(process.pid)).toBeNull();
	});

	it("returns a non-null numeric start time for the current PID on Linux", async () => {
		if (process.platform !== "linux") return;
		const startTime = await readLinuxProcStartTime(process.pid);
		expect(startTime).not.toBeNull();
		expect(startTime).toMatch(/^\d+$/);
	});
});
