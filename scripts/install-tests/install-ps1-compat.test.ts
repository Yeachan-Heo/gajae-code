import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..");
const installPs1Path = path.join(repoRoot, "scripts", "install.ps1");
const pwsh = Bun.which("pwsh");

describe("install.ps1 Windows PowerShell 5.1 compatibility", () => {
	test("avoids parameters that only exist on PowerShell 6+", async () => {
		const installer = await Bun.file(installPs1Path).text();

		// The documented install path (`irm ... | iex`) runs under Windows
		// PowerShell 5.1. ConvertFrom-Json -AsHashtable was added in PowerShell
		// 6.0; on 5.1 it throws a parameter binding error, and the surrounding
		// catch used to reset $settings to @{} and silently drop every existing
		// settings.json key.
		expect(installer).not.toContain("-AsHashtable");
	});

	test("opts in to TLS 1.2 before any network call", async () => {
		const installer = await Bun.file(installPs1Path).text();

		// .NET Framework-based PowerShell 5.1 can default to TLS 1.0, which
		// GitHub rejects; every download then fails with "Could not create
		// SSL/TLS secure channel".
		const tlsIndex = installer.indexOf("[Net.SecurityProtocolType]::Tls12");
		expect(tlsIndex).toBeGreaterThan(-1);
		for (const networkCall of ["Invoke-RestMethod", "Invoke-WebRequest"]) {
			const callIndex = installer.indexOf(networkCall);
			expect(callIndex).toBeGreaterThan(-1);
			expect(tlsIndex).toBeLessThan(callIndex);
		}
	});

	test("default path is a GitHub binary install and never downloads Bun", async () => {
		const installer = await Bun.file(installPs1Path).text();
		expect(installer).not.toContain("irm bun.sh");
		expect(installer).not.toContain("Install-Bun");
		expect(installer).toContain("This installer never downloads Bun");
		expect(installer).toContain("Install-Binary");
		expect(installer).toContain("gajae-release-binaries.sha256");
		expect(installer).toContain("--smoke-test");
		expect(installer).toContain("Restored previous gjc binary");
		expect(installer).toContain("nightly");
		expect(installer).not.toContain("Default: use bun if available");
		expect(installer).toContain("Putting $InstallDir first on PATH");
		expect(installer).toContain("Failed to publish the downloaded binary");
		expect(installer).toContain('^v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+\\.\\d+\\.g[0-9a-f]+$');
		expect(installer).toContain("Test-TrustedGithubUri");
		expect(installer).toContain("Assert-OfficialGithubOrigins");
		expect(installer).toContain("FileMode]::CreateNew");
		expect(installer).toContain("FileOptions]::DeleteOnClose");
		expect(installer).toContain("Refusing to replace symlink");
		expect(installer).toContain("FileAttributes]::ReparsePoint");
		expect(installer).toContain("-UseBasicParsing");
		expect(installer).not.toContain('No checksum asset on $Tag');
		expect(installer).toContain('$env:Path = "$InstallDir;"');
		expect(installer).toContain("[System.IO.File]::Move($Source, $Destination)");
		expect(installer).not.toContain("Move-Item -Force");
		expect(installer).toContain('throw "Unsupported architecture: x86');
		expect(installer).toContain("PROCESSOR_ARCHITEW6432");
		expect(installer).toContain("Test-StableReleaseTag");
		expect(installer).toContain("Refusing non-stable release tag");
	});

	test.skipIf(!pwsh)("parses without syntax errors under PowerShell", async () => {
		const script = [
			"$errors = $null",
			`[System.Management.Automation.Language.Parser]::ParseFile('${installPs1Path}', [ref]$null, [ref]$errors) | Out-Null`,
			"if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }",
			"exit 0",
		].join("; ");
		const proc = Bun.spawn([pwsh as string, "-NoProfile", "-Command", script], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		expect(stdout.trim()).toBe("");
		expect(exitCode).toBe(0);
	});
});
