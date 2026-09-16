import { describe, expect, test } from "bun:test";
import type { DoctorAction } from "../src/cli/doctor/args";
import { journalRepairSupported } from "../src/cli/doctor/repairs";

const JOURNAL_BACKED: DoctorAction[] = [
	"config.set-validated",
	"mcp.set-startup-policy",
	"permissions.restrict-owned-config",
	"install.repair-managed-link",
	"plugin.quarantine-selected",
	"service.detach-owned-stale-artifact",
];
const JOURNAL_FREE: DoctorAction[] = [
	"install.restore-binary",
	"plugin.restore-known-artifact",
	"service.restart-owned",
];

describe("journal-backed repair platform gate", () => {
	// The Rust journal authority only implements its durability primitives for
	// Linux and macOS; createExact answers unsupported_platform on every other
	// host, so these lanes must be refused before any mutation rather than after
	// authorization.
	test.each(JOURNAL_BACKED)("%s stays supported only on linux and darwin", action => {
		expect(journalRepairSupported(action, "linux")).toBe(true);
		expect(journalRepairSupported(action, "darwin")).toBe(true);
	});

	// win32 and the other Unix platforms lack the native journal implementation,
	// so a journal-backed repair must be refused up front on all of them.
	test.each(JOURNAL_BACKED)("%s is unsupported off linux/darwin", action => {
		expect(journalRepairSupported(action, "win32")).toBe(false);
		expect(journalRepairSupported(action, "freebsd")).toBe(false);
		expect(journalRepairSupported(action, "openbsd")).toBe(false);
	});

	test.each(JOURNAL_FREE)("%s is not gated: it is fenced by its own protocol", action => {
		expect(journalRepairSupported(action, "win32")).toBe(true);
		expect(journalRepairSupported(action, "freebsd")).toBe(true);
		expect(journalRepairSupported(action, "openbsd")).toBe(true);
		expect(journalRepairSupported(action, "linux")).toBe(true);
		expect(journalRepairSupported(action, "darwin")).toBe(true);
	});
});

describe("doctor --help documents the Windows limitation", () => {
	test("names the unsupported repair set and the working diagnose path", async () => {
		const source = await Bun.file(new URL("../src/cli/doctor-cli.ts", import.meta.url)).text();
		for (const action of JOURNAL_BACKED) expect(source).toContain(action);
		expect(source).toContain("unsupported on Windows");
		expect(source).toContain("--dry-run work");
	});
});
