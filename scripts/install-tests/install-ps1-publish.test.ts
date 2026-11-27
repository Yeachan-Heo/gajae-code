import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOwnedDeletionRoot } from "../safe-cleanup";

// Runs the installer's real publish and recovery functions under Windows PowerShell 5.1.
// On NTFS a running gjc.exe cannot be deleted but can be renamed, so publishing must be a rename
// swap that keeps the old binary until the new one is verified, and every failure path must leave
// either a working gjc.exe or a printed path to the preserved one.
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

async function makeDir(): Promise<string> {
	const root = path.join(os.tmpdir(), `gjc-install-publish-${crypto.randomUUID()}`);
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

function prelude(installDir: string): string {
	return [
		`$ast = [System.Management.Automation.Language.Parser]::ParseFile('${installPs1Path}', [ref]$null, [ref]$null)`,
		"foreach ($name in 'Move-InstallFile', 'Restore-PreviousBinary', 'Remove-OwnedFile', 'Publish-Binary') {",
		"  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)",
		"  Invoke-Expression $fn.Extent.Text",
		"}",
		`$InstallDir = '${installDir}'`,
		`$out = Join-Path $InstallDir 'gjc.exe'`,
		`$download = Join-Path $InstallDir '.gjc.download.test'`,
		`$backup = Join-Path $InstallDir '.gjc.bak.test'`,
		`$rejected = Join-Path $InstallDir '.gjc.rejected.test'`,
	].join("\n");
}

async function runPowershell(
	script: string,
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([powershell as string, "-NoProfile", "-NonInteractive", "-Command", script], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

const publishAndReport = [
	"$report = & {",
	"  try { Publish-Binary -SourcePath $download -TargetPath $out -BackupPath $backup -RejectedPath $rejected -ExpectedVersion '1.2.3'; 'PUBLISHED' }",
	"  catch { 'ERROR: ' + $_.Exception.Message }",
	// Out-String wraps at the host width by default, which splits long temp paths mid-word.
	"} 3>&1 | Out-String -Width 4096",
].join("\n");

describe.skipIf(!powershell)("install.ps1 binary publish", () => {
	test("replaces a gjc.exe that is running", async () => {
		const installDir = await makeDir();
		const exePath = path.join(installDir, "gjc.exe");
		await fs.copyFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"), exePath);
		const running = Bun.spawn([exePath, "-n", "120", "127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
		try {
			await Bun.sleep(500);
			expect(running.exitCode).toBeNull();
			await Bun.write(path.join(installDir, ".gjc.download.test"), "new-binary");

			const result = await runPowershell(
				`${prelude(installDir)}\nfunction Assert-InstalledBinary { param($ExePath, $ExpectedVersion) }\n${publishAndReport}\n$report`,
			);
			expect(result.stdout).toContain("PUBLISHED");
			expect(await Bun.file(exePath).text()).toBe("new-binary");
			expect(await fs.exists(path.join(installDir, ".gjc.download.test"))).toBe(false);
			expect(await fs.exists(path.join(installDir, ".gjc.rejected.test"))).toBe(false);
			// The running image cannot be deleted, so the old binary is left behind; its path must be printed
			// because the installer never deletes files by name pattern.
			const backupPath = path.join(installDir, ".gjc.bak.test");
			expect(await fs.exists(backupPath)).toBe(true);
			expect(result.stdout).toContain(`kept at ${backupPath}`);
		} finally {
			running.kill("SIGKILL");
			await running.exited;
		}
	}, 60_000);

	test("a failed verification restores the previous binary and leaves no backup", async () => {
		const installDir = await makeDir();
		await Bun.write(path.join(installDir, "gjc.exe"), "old-binary");
		await Bun.write(path.join(installDir, ".gjc.download.test"), "bad-binary");

		const result = await runPowershell(
			`${prelude(installDir)}\nfunction Assert-InstalledBinary { param($ExePath, $ExpectedVersion) throw 'smoke failed' }\n${publishAndReport}\n$report`,
		);
		expect(result.stdout).toContain("ERROR: Verification failed; existing install was preserved if one existed. smoke failed");
		expect(await Bun.file(path.join(installDir, "gjc.exe")).text()).toBe("old-binary");
		expect(await fs.readdir(installDir)).toEqual(["gjc.exe"]);
	}, 60_000);

	test("a failed move of the new binary restores the previous one", async () => {
		const installDir = await makeDir();
		await Bun.write(path.join(installDir, "gjc.exe"), "old-binary");

		const result = await runPowershell(
			`${prelude(installDir)}\nfunction Assert-InstalledBinary { param($ExePath, $ExpectedVersion) }\n${publishAndReport}\n$report`,
		);
		expect(result.stdout).toContain("ERROR: Failed to publish the downloaded binary.");
		expect(await Bun.file(path.join(installDir, "gjc.exe")).text()).toBe("old-binary");
		expect(await fs.readdir(installDir)).toEqual(["gjc.exe"]);
	}, 60_000);

	test("a failed restore keeps the backup, prints its path, and reports the original error", async () => {
		const installDir = await makeDir();
		await Bun.write(path.join(installDir, "gjc.exe"), "old-binary");
		await Bun.write(path.join(installDir, ".gjc.download.test"), "bad-binary");

		// Holding the new binary open with no sharing blocks both the rename-aside and the delete,
		// so the previous binary cannot be put back.
		const result = await runPowershell(
			[
				prelude(installDir),
				"function Assert-InstalledBinary { param($ExePath, $ExpectedVersion) $script:held = New-Object System.IO.FileStream($ExePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); throw 'smoke failed' }",
				publishAndReport,
				"$script:held.Dispose()",
				"$report",
			].join("\n"),
		);
		expect(result.stdout).toContain("ERROR: Verification failed; existing install was preserved if one existed. smoke failed");
		expect(result.stdout).toContain(`preserved at ${path.join(installDir, ".gjc.bak.test")}`);
		expect(await Bun.file(path.join(installDir, ".gjc.bak.test")).text()).toBe("old-binary");
	}, 60_000);

	test("a first install whose rejected binary cannot be retired says it is still at gjc.exe", async () => {
		const installDir = await makeDir();
		await Bun.write(path.join(installDir, ".gjc.download.test"), "bad-binary");

		// Holding the published binary open with no sharing blocks both the rename and the delete.
		const result = await runPowershell(
			[
				prelude(installDir),
				"function Assert-InstalledBinary { param($ExePath, $ExpectedVersion) $script:held = New-Object System.IO.FileStream($ExePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); throw 'smoke failed' }",
				publishAndReport,
				"$script:held.Dispose()",
				"$report",
			].join("\n"),
		);
		expect(result.stdout).toContain("ERROR: Verification failed");
		expect(result.stdout).toContain(`The binary that failed verification is still at ${path.join(installDir, "gjc.exe")}`);
	}, 60_000);

	test("a first install with a failed verification leaves nothing behind", async () => {
		const installDir = await makeDir();
		await Bun.write(path.join(installDir, ".gjc.download.test"), "bad-binary");

		const result = await runPowershell(
			`${prelude(installDir)}\nfunction Assert-InstalledBinary { param($ExePath, $ExpectedVersion) throw 'smoke failed' }\n${publishAndReport}\n$report`,
		);
		expect(result.stdout).toContain("ERROR: Verification failed");
		expect(await fs.readdir(installDir)).toEqual([]);
	}, 60_000);
});
