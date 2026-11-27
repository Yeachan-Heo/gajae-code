import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-doctor-help-"));
		try {
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					`--config=${path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml")}`,
					path.resolve(import.meta.dir, "../src/cli.ts"),
					"doctor",
					"--help",
				],
				{
					cwd: home,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: home,
						GJC_CODING_AGENT_DIR: path.join(home, ".gjc"),
						BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exitCode).toBe(0);
				expect(stderr).toBe("");
				expect(stdout).toContain("Usage: gjc doctor");
				for (const action of JOURNAL_BACKED) expect(stdout).toContain(action);
				expect(stdout).toContain("unsupported on Windows");
				expect(stdout).toContain("--dry-run work");
			} finally {
				clearTimeout(timer);
			}
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});
});
