import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const nativeEntryUrl = new URL("../native/index.js", import.meta.url).href;

async function runProbe(
	enabled: boolean,
	reportDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const environment = Object.fromEntries(
		Object.entries(Bun.env).filter(
			([key, value]) =>
				key !== "GJC_NATIVE_CRASH_DIAGNOSTICS" && key !== "GJC_CRASH_DIAGNOSTICS_DIR" && value !== undefined,
		),
	) as Record<string, string>;
	environment.GJC_CRASH_DIAGNOSTICS_DIR = reportDir;
	if (enabled) environment.GJC_NATIVE_CRASH_DIAGNOSTICS = "1";
	const script = `import { initNativeCrashDiagnostics } from ${JSON.stringify(nativeEntryUrl)}; process.stdout.write(String(initNativeCrashDiagnostics()));`;
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: repoRoot,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { stdout: child.stdout.toString(), stderr: child.stderr.toString(), exitCode: child.exitCode };
}

describe("native crash diagnostics opt-in guard", () => {
	test("does not enable the hook or create output when the opt-in flag is absent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-diagnostics-"));
		try {
			const reportDir = path.join(root, "reports");
			const child = await runProbe(false, reportDir);
			expect(child.exitCode).toBe(0);
			expect(child.stderr).toBe("");
			expect(child.stdout).toBe("false");
			await expect(fs.stat(reportDir)).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("enables only when explicitly requested and writes nothing until a panic", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-diagnostics-"));
		try {
			const reportDir = path.join(root, "reports");
			const child = await runProbe(true, reportDir);
			expect(child.exitCode).toBe(0);
			expect(child.stderr).toBe("");
			expect(child.stdout).toBe("true");
			await expect(fs.stat(reportDir)).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
