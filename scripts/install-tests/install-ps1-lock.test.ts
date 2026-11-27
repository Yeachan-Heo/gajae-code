import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireBinaryUpdateLock } from "../../packages/coding-agent/src/cli/update-cli";
import { registerOwnedDeletionRoot } from "../safe-cleanup";

// Runs the installer's real lock functions under Windows PowerShell 5.1, the shell that
// `irm .../install.ps1 | iex` uses. An install interrupted by closing the window must not leave a
// lock that refuses every later install, and a running installer must still exclude others.
const installPs1Path = path.join(import.meta.dir, "..", "install.ps1");
const powershell = process.platform === "win32" ? Bun.which("powershell.exe") : null;
const roots: Array<{ root: string; forget: () => void }> = [];

afterEach(async () => {
	for (const { root, forget } of roots.splice(0)) {
		try {
			await fs.rm(root, { recursive: true, force: true });
		} finally {
			forget();
		}
	}
});

// On Windows the OS temp root lives under the user home, so the test cleanup guard only
// permits removing a fixture root that was granted before it was created.
async function makeInstallDir(): Promise<string> {
	const root = path.join(os.tmpdir(), `gjc-install-lock-${crypto.randomUUID()}`);
	const forget = registerOwnedDeletionRoot(root);
	try {
		await fs.mkdir(root, { mode: 0o700 });
	} catch (error) {
		forget();
		throw error;
	}
	roots.push({ root, forget });
	return root;
}

/** PowerShell prelude that loads only the lock functions from install.ps1, never running the installer. */
function prelude(installDir: string): string {
	return [
		`$ast = [System.Management.Automation.Language.Parser]::ParseFile('${installPs1Path}', [ref]$null, [ref]$null)`,
		"foreach ($name in 'Get-IOErrorCode', 'Stop-OnUpdaterLockDirectory', 'Enter-InstallLock') {",
		"  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)",
		"  Invoke-Expression $fn.Extent.Text",
		"}",
		`$InstallDir = '${installDir}'`,
		`$lockFile = Join-Path $InstallDir '.gjc-install.lock'`,
	].join("\n");
}

async function runPowershell(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([powershell as string, "-NoProfile", "-NonInteractive", "-Command", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

const acquireAndReport = [
	"try {",
	"  $s = Enter-InstallLock -LockFile $lockFile -LockLine \"$PID $([guid]::NewGuid().ToString('N'))\"",
	"  'ACQUIRED'; $s.Dispose()",
	"  'LEFT=' + (Test-Path $lockFile)",
	"} catch { 'REFUSED: ' + $_.Exception.Message }",
].join("\n");

describe.skipIf(!powershell)("install.ps1 install lock", () => {
	test("a lock held by a running installer refuses others and vanishes when that installer is killed", async () => {
		const installDir = await makeInstallDir();
		const holder = Bun.spawn(
			[
				powershell as string,
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`${prelude(installDir)}\n$s = Enter-InstallLock -LockFile $lockFile -LockLine "$PID $([guid]::NewGuid().ToString('N'))"\n'HELD'\nStart-Sleep -Seconds 120`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const reader = holder.stdout.getReader();
		let held = "";
		while (!held.includes("HELD")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			held += new TextDecoder().decode(chunk.value);
		}
		expect(held).toContain("HELD");

		const contended = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
		expect(contended.stdout).toContain("REFUSED: Another GJC installer is already running");

		// Closing the terminal window kills the installer; nothing gets to run its cleanup.
		holder.kill("SIGKILL");
		await holder.exited;
		expect(await fs.exists(path.join(installDir, ".gjc-install.lock"))).toBe(false);

		const after = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
		expect(after.stdout).toContain("ACQUIRED");
		expect(after.stdout).toContain("LEFT=False");
	}, 60_000);

	test("reclaims a lock an older installer left behind for an exited process", async () => {
		const installDir = await makeInstallDir();
		const exited = Bun.spawn([process.execPath, "-e", ""]);
		await exited.exited;
		await Bun.write(path.join(installDir, ".gjc-install.lock"), `${exited.pid} ${"a".repeat(32)}\n`);

		const result = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
		expect(result.stdout).toContain(`Removed a stale installer lock left by exited pid ${exited.pid}`);
		expect(result.stdout).toContain("ACQUIRED");
		expect(result.stdout).toContain("LEFT=False");
	}, 60_000);

	test("keeps refusing an older installer's lock while its recorded process runs", async () => {
		const installDir = await makeInstallDir();
		const lockPath = path.join(installDir, ".gjc-install.lock");
		const lockLine = `${process.pid} ${"b".repeat(32)}\n`;
		await Bun.write(lockPath, lockLine);

		const result = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
		expect(result.stdout).toContain(`REFUSED: Another GJC installer (pid ${process.pid}) may still be running`);
		expect(await Bun.file(lockPath).text()).toBe(lockLine);
	}, 60_000);

	// `gjc update` locks with a directory whose `info` file records the owner pid.
	async function makeUpdaterLock(installDir: string, ownerPid: number): Promise<string> {
		const lockDir = path.join(installDir, ".gjc-install.lock");
		await fs.mkdir(lockDir);
		await Bun.write(path.join(lockDir, "info"), JSON.stringify({ pid: ownerPid, timestamp: Date.now() }));
		return lockDir;
	}

	test("reports a live gjc update lock directory and never removes it", async () => {
		const installDir = await makeInstallDir();
		const lockDir = await makeUpdaterLock(installDir, process.pid);

		const result = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
		expect(result.stdout).toContain(`held by 'gjc update' (pid ${process.pid}, which is still running)`);
		expect(result.stdout).toContain(`lock directory: ${lockDir}`);
		expect(result.stdout).toContain("delete the directory");
		expect(await fs.exists(path.join(lockDir, "info"))).toBe(true);
	}, 60_000);

	test("reports the lock directory a real gjc update holds and leaves it untouched", async () => {
		const installDir = await makeInstallDir();
		const release = await acquireBinaryUpdateLock(path.join(installDir, "gjc.exe"));
		try {
			const lockDir = path.join(installDir, ".gjc-install.lock");
			const before = await fs.stat(lockDir, { bigint: true });

			const result = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
			expect(result.stdout).toContain(`held by 'gjc update' (pid ${process.pid}, which is still running)`);

			const after = await fs.stat(lockDir, { bigint: true });
			expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
		} finally {
			await release();
		}
	}, 60_000);

	test("reports a gjc update lock directory left by an exited process and never removes it", async () => {
		const installDir = await makeInstallDir();
		const exited = Bun.spawn([process.execPath, "-e", ""]);
		await exited.exited;
		const lockDir = await makeUpdaterLock(installDir, exited.pid);

		const result = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
		expect(result.stdout).toContain(`held by 'gjc update' (pid ${exited.pid}, which has exited)`);
		expect(result.stdout).not.toContain("Another GJC installer");
		expect(await fs.exists(path.join(lockDir, "info"))).toBe(true);
	}, 60_000);

	test("reports a gjc update lock directory whose owner record is unreadable", async () => {
		const installDir = await makeInstallDir();
		const lockDir = path.join(installDir, ".gjc-install.lock");
		await fs.mkdir(lockDir);

		const result = await runPowershell(`${prelude(installDir)}\n${acquireAndReport}`);
		expect(result.stdout).toContain("held by 'gjc update' (owner unreadable)");
		expect(await fs.exists(lockDir)).toBe(true);
	}, 60_000);
});
