import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearPsmuxDetectionCache,
	detectPsmux,
	GJC_PSMUX_COMMAND_ENV,
	GJC_PSMUX_DETECTION_ENV,
	GJC_PSMUX_FORCE_DETECT_ENV,
	probePsmux,
	PSMUX_BINARY_NAMES,
	resolveGjcTmuxBinary,
} from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";

function psmuxVersionOutput(): string {
	return "psmux 3.3.0\n";
}

function tmuxVersionOutput(): string {
	return "tmux 3.3\n";
}

function failingRunner() {
	return () => ({ exitCode: 1, stdout: "", stderr: "command not found" });
}

function buildRunner(versionOutput: string | null) {
	return (command: string, args: string[]) => {
		if (versionOutput === null) return { exitCode: 1, stdout: "", stderr: "missing" };
		return { exitCode: 0, stdout: versionOutput, stderr: "" };
	};
}

beforeEach(() => {
	clearPsmuxDetectionCache();
});

afterEach(() => {
	clearPsmuxDetectionCache();
});

describe("PSMUX_BINARY_NAMES", () => {
	it("includes psmux, pmux, and tmux so any psmux install resolves", () => {
		expect(PSMUX_BINARY_NAMES).toContain("psmux");
		expect(PSMUX_BINARY_NAMES).toContain("pmux");
		expect(PSMUX_BINARY_NAMES).toContain("tmux");
	});
});

describe("detectPsmux", () => {
	it("returns true when the binary reports a psmux version banner", () => {
		const detected = detectPsmux("psmux", {
			env: {},
			runner: buildRunner(psmuxVersionOutput()),
			force: true,
		});
		expect(detected).toBe(true);
	});

	it("returns false when the binary reports a generic tmux banner", () => {
		const detected = detectPsmux("psmux", {
			env: {},
			runner: buildRunner(tmuxVersionOutput()),
			force: true,
		});
		expect(detected).toBe(false);
	});

	it("returns false when the probe runner cannot execute the binary", () => {
		const detected = detectPsmux("nonexistent-fake-tmux-binary-xyz", {
			env: {},
			runner: failingRunner(),
			force: true,
		});
		expect(detected).toBe(false);
	});

	it("honors GJC_PSMUX_DETECTION=off and never reports psmux", () => {
		const detected = detectPsmux("psmux", {
			env: { [GJC_PSMUX_DETECTION_ENV]: "off" },
			runner: buildRunner(psmuxVersionOutput()),
			force: true,
		});
		expect(detected).toBe(false);
	});

	it("re-probes every call when GJC_PSMUX_FORCE_DETECT is set", () => {
		let calls = 0;
		const runner = (command: string, args: string[]) => {
			calls += 1;
			return { exitCode: 0, stdout: calls === 1 ? "tmux 3.3\n" : "psmux 3.3.0\n", stderr: "" };
		};
		detectPsmux("psmux", {
			env: { [GJC_PSMUX_FORCE_DETECT_ENV]: "1" },
			runner,
			force: true,
		});
		detectPsmux("psmux", {
			env: { [GJC_PSMUX_FORCE_DETECT_ENV]: "1" },
			runner,
			force: true,
		});
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	it("caches the verdict for repeated identical probes", () => {
		let calls = 0;
		const runner = (command: string, args: string[]) => {
			calls += 1;
			return { exitCode: 0, stdout: "psmux 3.3.0\n", stderr: "" };
		};
		// First call: probes and caches. Subsequent calls must not re-probe.
		detectPsmux("psmux", { env: {}, runner, force: false });
		const callsAfterFirst = calls;
		detectPsmux("psmux", { env: {}, runner, force: false });
		detectPsmux("psmux", { env: {}, runner, force: false });
		expect(calls).toBe(callsAfterFirst);
	});

	it("treats an explicit GJC_PSMUX_COMMAND override as authoritative", () => {
		const detected = detectPsmux("psmux", {
			env: { [GJC_PSMUX_COMMAND_ENV]: "psmux" },
			runner: failingRunner(),
			force: true,
		});
		expect(detected).toBe(true);
	});
});

describe("resolveGjcTmuxBinary", () => {
	it("returns the explicit GJC_TMUX_COMMAND override when set", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: { GJC_TMUX_COMMAND: "/custom/tmux" },
			runner: failingRunner(),
		});
		expect(resolved.command).toBe("/custom/tmux");
		expect(resolved.viaExplicitOverride).toBe(true);
		expect(resolved.isPsmux).toBe(false);
	});

	it("falls back to GJC_TEAM_TMUX_COMMAND when GJC_TMUX_COMMAND is unset", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: { GJC_TEAM_TMUX_COMMAND: "team-tmux" },
			runner: failingRunner(),
		});
		expect(resolved.command).toBe("team-tmux");
		expect(resolved.viaExplicitOverride).toBe(true);
	});

	it("returns tmux as the POSIX default when no override and no binary on PATH", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: {},
			runner: failingRunner(),
		});
		expect(resolved.command).toBe("tmux");
		expect(resolved.viaExplicitOverride).toBe(false);
		expect(resolved.isPsmux).toBe(false);
	});

	it("flags the resolved command as psmux when the probe matches", () => {
		const resolved = resolveGjcTmuxBinary({
			platform: "linux",
			env: {},
			runner: buildRunner(psmuxVersionOutput()),
		});
		expect(resolved.isPsmux).toBe(true);
	});
});

describe("probePsmux", () => {
	it("returns the captured version banner for matched probes", () => {
		const probe = probePsmux("psmux", {
			env: {},
			runner: buildRunner(psmuxVersionOutput()),
			force: true,
		});
		expect(probe.isPsmux).toBe(true);
		expect(probe.versionOutput).toContain("psmux");
	});

	it("reports an empty probe when the runner cannot find the binary", () => {
		const probe = probePsmux("nonexistent-fake-tmux-binary-xyz", {
			env: {},
			runner: failingRunner(),
			force: true,
		});
		expect(probe.isPsmux).toBe(false);
		expect(probe.versionOutput).toBe("");
	});
});
