import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

it("keeps crash diagnostics inert without GJC_NATIVE_CRASH_DIAGNOSTICS", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-optin-"));
	try {
		const nativeUrl = new URL("../native/index.js", import.meta.url).href;
		const script = `import { initNativeCrashDiagnostics } from ${JSON.stringify(nativeUrl)};\nif (initNativeCrashDiagnostics() !== false) throw new Error("diagnostics unexpectedly enabled");`;
		const env = { ...process.env, HOME: home, USERPROFILE: home };
		delete env.GJC_NATIVE_CRASH_DIAGNOSTICS;
		delete env.GJC_CRASH_DIAGNOSTICS_DIR;
		const child = Bun.spawn([process.execPath, "-e", script], {
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("");
		expect(await Bun.file(path.join(home, ".gjc", "logs")).exists()).toBe(false);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}, 30_000);
