import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const entry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const DOCTOR_EXIT_CODES = new Set([0, 1, 2, 3, 4, 130]);

async function invoke(args: string[], env: Record<string, string | undefined> = {}) {
	const proc = Bun.spawn([process.execPath, entry, ...args], {
		cwd: repoRoot,
		env: { PATH: process.env.PATH ?? "", ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, stdout, stderr };
}

async function isolatedHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
	const home = await mkdtemp(path.join(tmpdir(), "gjc-doctor-"));
	return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

describe("doctor bootstrap", () => {
	it("renders help without loading the normal command graph", async () => {
		const result = await invoke(["doctor", "--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage: gjc doctor");
		// Help must not touch the isolated child boundary or any doctor collector output.
		expect(result.stdout).not.toContain("schemaVersion");
	});

	it("rejects malformed repair invocations with usage exit before spawning any worker", async () => {
		const result = await invoke(["doctor", "--fix"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--fix requires");
		expect(result.stdout).toBe("");
	});

	it("rejects malformed repair invocations as a structured JSON envelope with --json", async () => {
		const result = await invoke(["doctor", "--fix", "--json"]);
		expect(result.code).toBe(2);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.schemaVersion).toBe(1);
		expect(parsed.command).toBe("doctor");
		expect(parsed.summary.exitCode).toBe(2);
		expect(parsed.error.code).toBe("invalid_arguments");
	});

	it("keeps the internal worker route unreachable without the exact per-spawn token", async () => {
		// A user (or another process) invoking the internal argv marker directly,
		// without ever having received the supervisor's per-spawn token, must land
		// on the ordinary invalid-invocation usage path — never the protocol
		// worker's confirmation-refusal behavior, and never a hang waiting on
		// stdin for an "init" message that will never arrive.
		const result = await invoke(["--internal-doctor-worker"], {});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("invalid internal worker invocation");
	});

	it("keeps the internal worker route unreachable with a malformed token shape", async () => {
		const result = await invoke(["--internal-doctor-worker"], { GJC_DOCTOR_WORKER_TOKEN: "not-a-real-token" });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("invalid internal worker invocation");
	});

	it("keeps malloc guard admission ahead of doctor and still produces a valid report envelope", async () => {
		const { home, cleanup } = await isolatedHome();
		try {
			const result = await invoke(["doctor", "--json", "--check", "runtime"], {
				HOME: home,
				MallocStackLogging: "1",
				MallocStackLoggingNoCompact: "1",
			});
			// Not a length tautology: the malloc re-exec boundary must still land on
			// the doctor command and complete it as a well-formed report, not merely
			// emit *some* bytes to *some* stream.
			expect(DOCTOR_EXIT_CODES.has(result.code)).toBe(true);
			const parsed = JSON.parse(result.stdout);
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.command).toBe("doctor");
			expect(typeof parsed.summary.exitCode).toBe("number");
			expect(parsed.summary.exitCode).toBe(result.code);
		} finally {
			await cleanup();
		}
	});

	it("runs a real diagnose pass through the isolated child boundary and returns a bounded, well-formed report", async () => {
		const { home, cleanup } = await isolatedHome();
		try {
			const startedAt = Date.now();
			const result = await invoke(["doctor", "--json", "--check", "runtime", "--check", "config"], { HOME: home });
			const elapsedMs = Date.now() - startedAt;
			// The isolated worker boundary must terminate well inside its own
			// deadline plus verified-termination grace, not hang indefinitely.
			expect(elapsedMs).toBeLessThan(30_000);
			expect(DOCTOR_EXIT_CODES.has(result.code)).toBe(true);
			const parsed = JSON.parse(result.stdout);
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.command).toBe("doctor");
			expect(parsed.mode).toBe("diagnose");
			expect(Array.isArray(parsed.checks)).toBe(true);
			expect(Array.isArray(parsed.repairs)).toBe(true);
			expect(parsed.repairs.length).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("bounds a diagnose pass by an explicit --timeout-ms without hanging past it", async () => {
		const { home, cleanup } = await isolatedHome();
		try {
			const startedAt = Date.now();
			const result = await invoke(["doctor", "--json", "--timeout-ms", "1000"], { HOME: home });
			const elapsedMs = Date.now() - startedAt;
			// A short --timeout-ms must never let the isolated worker (or its own
			// subprocess probes) run substantially past the requested budget, even
			// when the deadline forces incomplete coverage.
			expect(elapsedMs).toBeLessThan(15_000);
			expect(DOCTOR_EXIT_CODES.has(result.code)).toBe(true);
			const parsed = JSON.parse(result.stdout);
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.command).toBe("doctor");
		} finally {
			await cleanup();
		}
	});

	it("never leaks the internal worker token or a raw stack trace into doctor output", async () => {
		const { home, cleanup } = await isolatedHome();
		try {
			const diagnose = await invoke(["doctor", "--json", "--check", "runtime"], { HOME: home });
			const combined = `${diagnose.stdout}${diagnose.stderr}`;
			expect(combined).not.toMatch(/GJC_DOCTOR_WORKER_TOKEN/);
			expect(combined).not.toMatch(/\bat [A-Za-z_$][\w$.<>]*\s*\(/); // Node/Bun stack-frame shape
			expect(combined).not.toContain(home);

			const rejectedWorker = await invoke(["--internal-doctor-worker"], {});
			const rejectedCombined = `${rejectedWorker.stdout}${rejectedWorker.stderr}`;
			expect(rejectedCombined).not.toMatch(/GJC_DOCTOR_WORKER_TOKEN=/);
			expect(rejectedCombined).not.toMatch(/\bat [A-Za-z_$][\w$.<>]*\s*\(/);
		} finally {
			await cleanup();
		}
	});

	it("rejects a target that does not match the stable doctor ID grammar without spawning a worker", async () => {
		const result = await invoke([
			"doctor",
			"--fix",
			"--repair",
			"config.set-validated",
			"--target",
			"not-a-stable-id",
			"--set-value-json",
			"true",
			"--json",
		]);
		expect(result.code).toBe(2);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.summary.exitCode).toBe(2);
	});
});
