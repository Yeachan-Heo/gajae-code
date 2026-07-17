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
		// GitHub and bun.sh reject; every download then fails with "Could not
		// create SSL/TLS secure channel".
		const tlsIndex = installer.indexOf("[Net.SecurityProtocolType]::Tls12");
		expect(tlsIndex).toBeGreaterThan(-1);
		for (const networkCall of ["Invoke-RestMethod", "Invoke-WebRequest", "irm bun.sh"]) {
			const callIndex = installer.indexOf(networkCall);
			expect(callIndex).toBeGreaterThan(-1);
			expect(tlsIndex).toBeLessThan(callIndex);
		}
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
