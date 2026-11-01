import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InstallationAclPresentError } from "../src/cli/install-activation";

const STAGED = String.raw`C:\Users\Alice\.local\bin\gjc.new.0123.exe`;

describe("InstallationAclPresentError", () => {
	it("identifies an inherited unsafe principal and preserves the ACL error code", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Users\Alice\.local\bin\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
			aclFailureInherited: true,
		});

		expect(error.code).toBe("acl_present");
		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Users\Alice\.local\bin\gjc.exe: ACE for "BUILTIN\Users" is inherited from a parent directory. Run in PowerShell: icacls 'C:\Users\Alice\.local\bin' /inheritance:d; if ($?) { icacls 'C:\Users\Alice\.local\bin' /remove 'BUILTIN\Users'; if ($?) { gjc update } }`,
		);
	});

	it("identifies an explicitly set unsafe principal when inherited is false", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailurePrincipal: "S-1-5-32-545",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Tools\gjc.exe: ACE for "S-1-5-32-545" is explicitly set. Run in PowerShell: icacls 'C:\Tools\gjc.exe' /remove '*S-1-5-32-545'; if ($?) { gjc update }`,
		);
	});

	it("omits automatic retry from inherited ACL rollback guidance", () => {
		const error = new InstallationAclPresentError(
			String.raw`C:\Tools\gjc.exe`,
			STAGED,
			{ aclFailurePrincipal: "SandboxUsers", aclFailureInherited: true, aclFailureSide: "source" },
			false,
		);
		expect(error.message).toContain(String.raw`icacls 'C:\Users\Alice\.local\bin' /remove 'SandboxUsers' }`);
		expect(error.message).not.toContain("gjc update");
	});

	it("falls back to the bare error when both diagnostic fields are absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {});

		expect(error.message).toBe("acl_present");
	});

	it("omits the remedy when the principal is absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailureInherited: true,
		});

		expect(error.message).toBe("acl_present");
	});

	it("omits the remedy when the inherited flag is absent", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
		});

		expect(error.message).toBe("acl_present");
	});

	it("quotes directory and principal names containing spaces in the ordered remedy commands", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Program Files\GJC\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`CONTOSO\Domain Users`,
			aclFailureInherited: true,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Program Files\GJC\gjc.exe: ACE for "CONTOSO\Domain Users" is inherited from a parent directory. Run in PowerShell: icacls 'C:\Program Files\GJC' /inheritance:d; if ($?) { icacls 'C:\Program Files\GJC' /remove 'CONTOSO\Domain Users'; if ($?) { gjc update } }`,
		);
	});

	it("includes the exact target file path while directing the remedy to its UNC parent directory", () => {
		const error = new InstallationAclPresentError(String.raw`\\server\share\GJC Tools\gjc-custom.exe`, STAGED, {
			aclFailurePrincipal: "Everyone",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of \\server\share\GJC Tools\gjc-custom.exe: ACE for "Everyone" is explicitly set. Run in PowerShell: icacls '\\server\share\GJC Tools\gjc-custom.exe' /remove 'Everyone'; if ($?) { gjc update }`,
		);
	});

	it("targets the file for explicit ACE removal and uses SID syntax with asterisk prefix", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Program Files\GJC\gjc.exe`, STAGED, {
			aclFailurePrincipal: "S-1-5-21-123456-123456-123456-1001",
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Program Files\GJC\gjc.exe: ACE for "S-1-5-21-123456-123456-123456-1001" is explicitly set. Run in PowerShell: icacls 'C:\Program Files\GJC\gjc.exe' /remove '*S-1-5-21-123456-123456-123456-1001'; if ($?) { gjc update }`,
		);
	});

	it("handles inherited numeric SID with correct syntax", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Tools\gjc.exe`, STAGED, {
			aclFailurePrincipal: "S-1-5-32-544",
			aclFailureInherited: true,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Tools\gjc.exe: ACE for "S-1-5-32-544" is inherited from a parent directory. Run in PowerShell: icacls 'C:\Tools' /inheritance:d; if ($?) { icacls 'C:\Tools' /remove '*S-1-5-32-544'; if ($?) { gjc update } }`,
		);
	});

	it("targets the file for explicit ACE with account name and spaces", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Program Files\GJC\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`CONTOSO\Domain Users`,
			aclFailureInherited: false,
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Program Files\GJC\gjc.exe: ACE for "CONTOSO\Domain Users" is explicitly set. Run in PowerShell: icacls 'C:\Program Files\GJC\gjc.exe' /remove 'CONTOSO\Domain Users'; if ($?) { gjc update }`,
		);
	});

	it("identifies source-side ACL failure with source indicator", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Users\Alice\.local\bin\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
			aclFailureInherited: false,
			aclFailureSide: "source",
		});

		expect(error.message).toBe(
			String.raw`acl_present during exact replacement of C:\Users\Alice\.local\bin\gjc.exe: ACE for "BUILTIN\Users" is explicitly set on the source file C:\Users\Alice\.local\bin\gjc.new.0123.exe. Run in PowerShell: icacls 'C:\Users\Alice\.local\bin\gjc.new.0123.exe' /remove 'BUILTIN\Users'; if ($?) { gjc update }`,
		);
		expect(error.code).toBe("acl_present");
	});

	it("identifies destination-side ACL failure with destination indicator", () => {
		const error = new InstallationAclPresentError(String.raw`C:\Users\Alice\.local\bin\gjc.exe`, STAGED, {
			aclFailurePrincipal: String.raw`BUILTIN\Users`,
			aclFailureInherited: false,
			aclFailureSide: "destination",
		});

		expect(error.message).toContain("on the destination file");
		expect(error.code).toBe("acl_present");
	});

	it("removes inheritance on the staged source directory when the source ACE is inherited", () => {
		const error = new InstallationAclPresentError(
			String.raw`C:\Program Files\GJC\gjc.exe`,
			String.raw`D:\Staging\gjc.new.9.exe`,
			{
				aclFailurePrincipal: "S-1-5-21-1-2-3-1001",
				aclFailureInherited: true,
				aclFailureSide: "source",
			},
		);

		expect(error.message).toContain(
			String.raw`icacls 'D:\Staging' /inheritance:d; if ($?) { icacls 'D:\Staging' /remove '*S-1-5-21-1-2-3-1001'`,
		);
		expect(error.message).not.toContain(String.raw`icacls 'C:\Program Files\GJC'`);
	});

	it.skipIf(process.platform !== "win32")("preserves the identity of an extended drive root", async () => {
		const root = path.win32.parse(os.tmpdir()).root;
		expect(root).toMatch(/^[A-Za-z]:\\$/);
		const [normal, extended] = await Promise.all([fs.stat(root), fs.stat(`\\\\?\\${root}`)]);
		expect({ dev: extended.dev, ino: extended.ino }).toEqual({ dev: normal.dev, ino: normal.ino });
	});
});

const powerShells = process.env.GJC_TEST_POWERSHELL
	? [process.env.GJC_TEST_POWERSHELL]
	: process.platform === "win32"
		? ["powershell.exe", "pwsh.exe"]
		: [undefined];

for (const powerShell of powerShells) {
	describe.skipIf(!powerShell)(`PowerShell ACL remediation (${powerShell})`, () => {
		let directory = "";
		const extension = process.platform === "win32" ? ".exe" : "";

		beforeAll(async () => {
			directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acl-mock-"));
			const mock = path.join(directory, "mock.ts");
			await Bun.write(
				mock,
				`
import * as path from "node:path";
const log = process.env.MOCK_LOG!;
const calls = await Bun.file(log).json();
calls.push({ command: path.basename(process.execPath).replace(/\\.exe$/i, ""), arguments: process.argv.slice(2) });
await Bun.write(log, JSON.stringify(calls));
if (calls.length === Number(process.env.MOCK_FAIL_AT)) process.exit(1);
`,
			);
			const icacls = path.join(directory, `icacls${extension}`);
			const build = Bun.spawn([process.execPath, "build", "--compile", mock, "--outfile", icacls], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				build.exited,
				new Response(build.stdout).text(),
				new Response(build.stderr).text(),
			]);
			expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, output: "" });
			await fs.copyFile(icacls, path.join(directory, `gjc${extension}`));
		}, 120_000);

		afterAll(async () => {
			if (directory) await fs.rm(directory, { recursive: true, force: true });
		});

		async function execute(error: InstallationAclPresentError, failAt: number) {
			const command = error.message.split("Run in PowerShell: ")[1];
			expect(command).toBeDefined();
			const log = path.join(directory, "calls.json");
			await Bun.write(log, "[]");
			const script = `
foreach ($name in @('icacls', 'gjc')) {
  $expected = Join-Path $env:MOCK_DIR ($name + $env:MOCK_EXT)
  Set-Alias -Name $name -Value $expected
  $resolved = Get-Command $name
  if ($resolved.CommandType -ne 'Alias' -or $resolved.Definition -ne $expected) { throw "Mock not found: $name" }
}
${command}
exit 0
`;
			const child = Bun.spawn([powerShell!, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
				env: {
					...process.env,
					MOCK_DIR: directory,
					MOCK_EXT: extension,
					MOCK_LOG: log,
					MOCK_FAIL_AT: String(failAt),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			return (await Bun.file(log).json()) as { command: string; arguments: string[] }[];
		}

		it("runs inherited remediation in order and stops on either failure", async () => {
			const directory = String.raw`C:\Users\O'Neil $HOME %PATH% & (test) ‘x’`;
			const principal = String.raw`DOMAIN\O'Neil $HOME %PATH% & (test) ’x’`;
			const error = new InstallationAclPresentError(`${directory}\\gjc.exe`, STAGED, {
				aclFailurePrincipal: principal,
				aclFailureInherited: true,
			});
			const first = { command: "icacls", arguments: [directory, "/inheritance:d"] };
			const second = { command: "icacls", arguments: [directory, "/remove", principal] };
			const update = { command: "gjc", arguments: ["update"] };
			expect(await execute(error, 0)).toEqual([first, second, update]);
			expect(await execute(error, 1)).toEqual([first]);
			expect(await execute(error, 2)).toEqual([first, second]);
		}, 30_000);

		it("removes the staged source SID literally and only updates on success", async () => {
			const error = new InstallationAclPresentError(String.raw`C:\Target\gjc.exe`, STAGED, {
				aclFailurePrincipal: "S-1-5-32-545",
				aclFailureInherited: false,
				aclFailureSide: "source",
			});
			const remove = { command: "icacls", arguments: [STAGED, "/remove", "*S-1-5-32-545"] };
			expect(await execute(error, 0)).toEqual([remove, { command: "gjc", arguments: ["update"] }]);
			expect(await execute(error, 1)).toEqual([remove]);
		}, 30_000);

		it("passes a space-containing UNC share root without a trailing backslash", async () => {
			const error = new InstallationAclPresentError(String.raw`\\server\Share Name\gjc.exe`, STAGED, {
				aclFailurePrincipal: "Everyone",
				aclFailureInherited: true,
			});
			const directory = String.raw`\\server\Share Name\.`;
			expect(await execute(error, 0)).toEqual([
				{ command: "icacls", arguments: [directory, "/inheritance:d"] },
				{ command: "icacls", arguments: [directory, "/remove", "Everyone"] },
				{ command: "gjc", arguments: ["update"] },
			]);
		}, 30_000);

		it("preserves extended-length drive and UNC roots", async () => {
			for (const [file, directory] of [
				[String.raw`\\?\C:\gjc.exe`, `${String.raw`\\?\C:`}\\`],
				[String.raw`\\?\UNC\server\Share Name\gjc.exe`, String.raw`\\?\UNC\server\Share Name`],
			]) {
				const error = new InstallationAclPresentError(file, STAGED, {
					aclFailurePrincipal: "Everyone",
					aclFailureInherited: true,
				});
				expect(await execute(error, 0)).toEqual([
					{ command: "icacls", arguments: [directory, "/inheritance:d"] },
					{ command: "icacls", arguments: [directory, "/remove", "Everyone"] },
					{ command: "gjc", arguments: ["update"] },
				]);
			}
		}, 30_000);
	});
}
