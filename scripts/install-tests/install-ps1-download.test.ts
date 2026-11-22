import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerOwnedDeletionRoot } from "../safe-cleanup";

const repoRoot = path.join(import.meta.dir, "..", "..");
const installPs1Path = path.join(repoRoot, "scripts", "install.ps1");
const windowsPowershell = process.platform === "win32" ? Bun.which("powershell.exe") : null;

function psLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

// Parse, but never dot-source or invoke, the installer entry point.
function downloadPrelude(root: string, origin: string): string {
	return [
		'$ErrorActionPreference = "Stop"',
		'if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw "Requires Windows PowerShell 5.1" }',
		"$parseErrors = $null",
		`$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(installPs1Path)}, [ref]$null, [ref]$parseErrors)`,
		'if ($parseErrors.Count) { throw ($parseErrors | Out-String) }',
		"foreach ($name in 'Get-DefaultProxyUri', 'Save-ReleaseAsset', 'Get-WebExceptionStatus', 'Get-FileSha256Lower', 'Get-ChecksumForAsset', 'Assert-Checksum') {",
		"  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)",
		'  if (-not $fn) { throw "Missing extracted function: $name" }',
		"  Invoke-Expression $fn.Extent.Text",
		"}",
		`$InstallDir = ${psLiteral(root)}`,
		`$GithubReleases = ${psLiteral(origin)}`,
		"$UserAgent = 'gjc-installer-download-contract-test'",
		"$BinarySha256Asset = 'checksums.sha256'",
		"$BinaryManifestAsset = 'manifest.json'",
		"$out = Join-Path $InstallDir 'download.bin'",
	].join("\n");
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	const deadline = Promise.withResolvers<T>();
	const timer = setTimeout(() => deadline.reject(new Error(`PowerShell exceeded ${milliseconds}ms deadline`)), milliseconds);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function runDownloadPowershell(
	root: string,
	script: string,
	curlFailure = false,
	extraEnv: Record<string, string> = {},
): Promise<string> {
	if (!windowsPowershell) throw new Error("Windows PowerShell 5.1 is required");
	const stdoutPath = path.join(root, "stdout.log");
	const stderrPath = path.join(root, "stderr.log");
	// File-backed capture cannot hang waiting for a descendant to close a pipe.
	const child = Bun.spawn([windowsPowershell, "-NoProfile", "-NonInteractive", "-Command", script], {
		env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", ...extraEnv },
		stdout: Bun.file(stdoutPath),
		stderr: Bun.file(stderrPath),
		timeout: 20_000,
		killSignal: "SIGKILL",
	});
	try {
		const exitCode = await bounded(child.exited, 23_000);
		const stdout = await Bun.file(stdoutPath).text();
		const stderr = await Bun.file(stderrPath).text();
		expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
		if (curlFailure) expect(stderr).toContain("curl:");
		else expect(stderr).toBe("");
		return stdout;
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await bounded(child.exited, 2_000);
	}
}

const downloadBytes = new Uint8Array([71, 74, 67, 0, 255, 13, 10, 42]);
const downloadDigest = crypto.createHash("sha256").update(downloadBytes).digest("hex");

interface DownloadFixture {
	root: string;
	origin: string;
	requests: string[];
}

async function withDownloadFixture(run: (fixture: DownloadFixture) => Promise<void>): Promise<void> {
	const root = path.join(os.tmpdir(), `gjc-install-download-${crypto.randomUUID()}`);
	const forgetRoot = registerOwnedDeletionRoot(root);
	const requests: string[] = [];
	try {
		await fs.mkdir(root);
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const route = new URL(request.url).pathname;
				requests.push(route);
				if (route === "/redirect") return new Response(null, { status: 302, headers: { Location: "/body" } });
				if (route === "/body") return new Response(downloadBytes);
				if (route === "/valid/checksums.sha256") return new Response(`${downloadDigest}  gjc.exe\n`);
				if (route === "/mismatch/checksums.sha256") return new Response(`${"0".repeat(64)}  gjc.exe\n`);
				if (route === "/unlisted/checksums.sha256") return new Response(`${downloadDigest}  other.exe\n`);
				if (route === "/fallback/manifest.json") {
					return Response.json({ binaries: [{ name: "gjc.exe", sha256: downloadDigest }] });
				}
				return new Response("missing integrity asset", { status: 404 });
			},
		});
		try {
			await run({ root, origin: `http://127.0.0.1:${server.port}`, requests });
		} finally {
			await server.stop(true);
		}
	} finally {
		try {
			await fs.rm(root, { recursive: true, force: true });
		} finally {
			forgetRoot();
		}
	}
}

const requireSystemCurl = [
	"$systemCurl = Join-Path $env:SystemRoot 'System32\\curl.exe'",
	'if (-not (Test-Path -LiteralPath $systemCurl -PathType Leaf)) { throw "Required actual system curl.exe is missing: $systemCurl" }',
	"'CURL=' + $systemCurl",
].join("\n");

describe.skipIf(!windowsPowershell)("install.ps1 extracted Windows PowerShell 5.1 download contracts", () => {
	test("system curl follows loopback redirects and preserves exact downloaded bytes", async () => {
		await withDownloadFixture(async ({ root, origin, requests }) => {
			const stdout = await runDownloadPowershell(root, [
				downloadPrelude(root, origin), requireSystemCurl,
				`Save-ReleaseAsset -Uri ${psLiteral(`${origin}/redirect`)} -OutFile $out`,
				"'DIGEST=' + (Get-FileSha256Lower $out)",
			].join("\n"));
			expect(stdout).toContain("CURL=");
			expect(stdout).toContain(`DIGEST=${downloadDigest}`);
			expect(new Uint8Array(await Bun.file(path.join(root, "download.bin")).arrayBuffer())).toEqual(downloadBytes);
			expect(requests).toEqual(["/redirect", "/body"]);
		});
	}, 30_000);

	test("system curl maps HTTP 404 and deletes its failed output", async () => {
		await withDownloadFixture(async ({ root, origin, requests }) => {
			await Bun.write(path.join(root, "download.bin"), "owned partial output");
			const stdout = await runDownloadPowershell(root, [
				downloadPrelude(root, origin), requireSystemCurl,
				`try { Save-ReleaseAsset -Uri ${psLiteral(`${origin}/missing`)} -OutFile $out; throw 'UNEXPECTED_SUCCESS' }`,
				"catch { 'STATUS=' + (Get-WebExceptionStatus $_); 'FAILURE=' + $_.Exception.Message }",
				"'OUTPUT_EXISTS=' + (Test-Path -LiteralPath $out)",
			].join("\n"));
			expect(stdout).toContain("STATUS=404");
			expect(stdout).toContain("HTTP 404, curl exit 0");
			expect(stdout).toContain("OUTPUT_EXISTS=False");
			expect(await Bun.file(path.join(root, "download.bin")).exists()).toBe(false);
			expect(requests).toEqual(["/missing"]);
		});
	}, 30_000);

	test("system curl sends the download through the proxy resolved for the URI", async () => {
		await withDownloadFixture(async ({ root, origin, requests }) => {
			const proxied: string[] = [];
			const proxy = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					proxied.push(request.url);
					return fetch(request.url);
				},
			});
			try {
				const stdout = await runDownloadPowershell(
					root,
					[
						downloadPrelude(root, origin),
						requireSystemCurl,
						`function Get-DefaultProxyUri { param([string]$Uri) 'http://127.0.0.1:${proxy.port}' }`,
						`Save-ReleaseAsset -Uri ${psLiteral(`${origin}/body`)} -OutFile $out`,
						"'DIGEST=' + (Get-FileSha256Lower $out)",
					].join("\n"),
					false,
					{ NO_PROXY: "", no_proxy: "" },
				);
				expect(stdout).toContain(`DIGEST=${downloadDigest}`);
				expect(proxied).toEqual([`${origin}/body`]);
				expect(requests).toEqual(["/body"]);
			} finally {
				await proxy.stop(true);
			}
		});
	}, 30_000);

	test("Get-DefaultProxyUri follows WebRequest.DefaultWebProxy and is direct when it is null or bypassed", async () => {
		await withDownloadFixture(async ({ root, origin }) => {
			const stdout = await runDownloadPowershell(
				root,
				[
					downloadPrelude(root, origin),
					"[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy('http://proxy.invalid:3128', $false, @('bypassed\\.invalid'))",
					"'PROXIED=' + (Get-DefaultProxyUri -Uri 'https://github.com/x')",
					"'BYPASSED=[' + (Get-DefaultProxyUri -Uri 'https://bypassed.invalid/x') + ']'",
					"[System.Net.WebRequest]::DefaultWebProxy = $null",
					"'NULL=[' + (Get-DefaultProxyUri -Uri 'https://github.com/x') + ']'",
				].join("\n"),
			);
			expect(stdout).toContain("PROXIED=http://proxy.invalid:3128/");
			expect(stdout).toContain("BYPASSED=[]");
			expect(stdout).toContain("NULL=[]");
		});
	}, 30_000);

	test("a direct connection ignores proxy environment variables that Invoke-WebRequest ignores", async () => {
		await withDownloadFixture(async ({ root, origin, requests }) => {
			const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
			const deadProxy = `http://127.0.0.1:${dead.port}`;
			await dead.stop(true);
			const stdout = await runDownloadPowershell(
				root,
				[
					downloadPrelude(root, origin),
					requireSystemCurl,
					"[System.Net.WebRequest]::DefaultWebProxy = $null",
					"if ($null -ne (Get-DefaultProxyUri -Uri 'http://127.0.0.1/')) { throw 'DefaultWebProxy null must resolve to direct' }",
					`Save-ReleaseAsset -Uri ${psLiteral(`${origin}/body`)} -OutFile $out`,
					"'DIGEST=' + (Get-FileSha256Lower $out)",
				].join("\n"),
				false,
				{ NO_PROXY: "", no_proxy: "", http_proxy: deadProxy, ALL_PROXY: deadProxy, all_proxy: deadProxy },
			);
			expect(stdout).not.toContain("curl.exe could not download");
			expect(stdout).toContain(`DIGEST=${downloadDigest}`);
			expect(requests).toEqual(["/body"]);
		});
	}, 30_000);

	test("native stderr turned into error records does not pre-empt the exit code under $ErrorActionPreference Stop", async () => {
		await withDownloadFixture(async ({ root, origin, requests }) => {
			const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
			const deadProxy = `http://127.0.0.1:${dead.port}`;
			await dead.stop(true);
			// `2>&1` on the call makes PowerShell 5.1 wrap curl's stderr (the progress bar, --show-error) in error
			// records, as ISE, remoting and PSNativeCommandUseErrorActionPreference do; Stop would throw on them.
			const stdout = await runDownloadPowershell(
				root,
				[
					downloadPrelude(root, origin),
					requireSystemCurl,
					`Save-ReleaseAsset -Uri ${psLiteral(`${origin}/body`)} -OutFile $out -ShowProgress 2>&1 | Out-Null`,
					"'PROGRESS_DIGEST=' + (Get-FileSha256Lower $out)",
					"Remove-Item -LiteralPath $out",
					`function Get-DefaultProxyUri { param([string]$Uri) '${deadProxy}' }`,
					`$captured = Save-ReleaseAsset -Uri ${psLiteral(`${origin}/body`)} -OutFile $out 2>&1`,
					"'FAILURE_DIGEST=' + (Get-FileSha256Lower $out)",
				].join("\n"),
				false,
				{ NO_PROXY: "", no_proxy: "" },
			);
			expect(stdout).toContain(`PROGRESS_DIGEST=${downloadDigest}`);
			expect(stdout).toContain(`FAILURE_DIGEST=${downloadDigest}`);
			expect(stdout).toContain("curl.exe could not download");
			expect(requests).toEqual(["/body", "/body"]);
		});
	}, 30_000);

	test("a curl failure without an HTTP status falls back to Invoke-WebRequest", async () => {
		await withDownloadFixture(async ({ root, origin, requests }) => {
			const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
			const deadProxy = `http://127.0.0.1:${dead.port}`;
			await dead.stop(true);
			const stdout = await runDownloadPowershell(
				root,
				[
					downloadPrelude(root, origin),
					requireSystemCurl,
					// Only curl.exe is pointed at the dead proxy; Invoke-WebRequest resolves its own proxy.
					`function Get-DefaultProxyUri { param([string]$Uri) '${deadProxy}' }`,
					`Save-ReleaseAsset -Uri ${psLiteral(`${origin}/body`)} -OutFile $out`,
					"'DIGEST=' + (Get-FileSha256Lower $out)",
				].join("\n"),
				true,
				{ NO_PROXY: "", no_proxy: "" },
			);
			expect(stdout).toContain("curl.exe could not download");
			expect(stdout).toContain(`DIGEST=${downloadDigest}`);
			expect(requests).toEqual(["/body"]);
		});
	}, 30_000);

	test("system curl reports a refused loopback transport, falls back, and cleans partial output without changing neighbors", async () => {
		await withDownloadFixture(async ({ root, origin }) => {
			const refused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
			const refusedUri = `http://127.0.0.1:${refused.port}/refused`;
			await refused.stop(true);
			await Bun.write(path.join(root, "download.bin"), "owned partial output");
			await Bun.write(path.join(root, "gjc.exe"), "existing target");
			await Bun.write(path.join(root, "sentinel"), "untouched sentinel");
			const stdout = await runDownloadPowershell(root, [
				downloadPrelude(root, origin), requireSystemCurl,
				`try { Save-ReleaseAsset -Uri ${psLiteral(refusedUri)} -OutFile $out; throw 'UNEXPECTED_SUCCESS' }`,
				"catch { 'STATUS=' + (Get-WebExceptionStatus $_); 'FAILURE=' + $_.Exception.Message }",
				"'OUTPUT_EXISTS=' + (Test-Path -LiteralPath $out)",
			].join("\n"), true);
			expect(stdout).toContain("STATUS=0");
			expect(stdout).toContain("curl.exe could not download");
			expect(stdout).toContain("HTTP 0, curl exit 7");
			expect(stdout).toMatch(/FAILURE=\S/);
			expect(stdout).toContain("OUTPUT_EXISTS=False");
			expect(await Bun.file(path.join(root, "download.bin")).exists()).toBe(false);
			expect(await Bun.file(path.join(root, "gjc.exe")).text()).toBe("existing target");
			expect(await Bun.file(path.join(root, "sentinel")).text()).toBe("untouched sentinel");
		});
	}, 30_000);

	test("real Invoke-WebRequest fallback restores ProgressPreference after success and HTTP failure", async () => {
		await withDownloadFixture(async ({ root, origin, requests }) => {
			const stdout = await runDownloadPowershell(root, [
				downloadPrelude(root, origin),
				// A fake SystemRoot breaks .NET proxy configuration as well as curl.
				// Simulate only availability; Invoke-WebRequest still performs real I/O.
				"$systemCurl = Join-Path $env:SystemRoot 'System32\\curl.exe'",
				"$script:curlAbsenceChecks = 0",
				"function Invoke-WithoutCurl { param($Uri, $OutFile) function Test-Path { param([string]$LiteralPath) if ($LiteralPath -eq $systemCurl) { $script:curlAbsenceChecks++; return $false }; Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath }; Save-ReleaseAsset -Uri $Uri -OutFile $OutFile }",
				"$ProgressPreference = 'Continue'",
				`Invoke-WithoutCurl -Uri ${psLiteral(`${origin}/body`)} -OutFile $out`,
				"'SUCCESS_PROGRESS=' + $ProgressPreference",
				"'DIGEST=' + (Get-FileSha256Lower $out)",
				"$ProgressPreference = 'Stop'",
				`try { Invoke-WithoutCurl -Uri ${psLiteral(`${origin}/missing`)} -OutFile (Join-Path $InstallDir 'missing.bin'); throw 'UNEXPECTED_SUCCESS' }`,
				"catch { 'FAILURE_STATUS=' + (Get-WebExceptionStatus $_) }",
				"'FAILURE_PROGRESS=' + $ProgressPreference",
				"'CURL_ABSENCE_CHECKS=' + $script:curlAbsenceChecks",
			].join("\n"));
			expect(stdout).toContain("SUCCESS_PROGRESS=Continue");
			expect(stdout).toContain(`DIGEST=${downloadDigest}`);
			expect(stdout).toContain("FAILURE_STATUS=404");
			expect(stdout).toContain("FAILURE_PROGRESS=Stop");
			expect(stdout).toContain("CURL_ABSENCE_CHECKS=2");
			expect(new Uint8Array(await Bun.file(path.join(root, "download.bin")).arrayBuffer())).toEqual(downloadBytes);
			expect(requests).toEqual(["/body", "/missing"]);
		});
	}, 30_000);

	for (const scenario of ["valid", "mismatch", "unlisted", "fallback", "missing"] as const) {
		test(`Assert-Checksum ${scenario} uses downloaded integrity assets and preserves existing files`, async () => {
			await withDownloadFixture(async ({ root, origin, requests }) => {
				await Bun.write(path.join(root, "download.bin"), downloadBytes);
				await Bun.write(path.join(root, "gjc.exe"), "existing target");
				await Bun.write(path.join(root, "sentinel"), "untouched sentinel");
				// Other operations' integrity temps must not be swept by this call.
				await Bun.write(path.join(root, ".gjc.sha256.neighbor"), "neighbor sums");
				await Bun.write(path.join(root, ".gjc.manifest.neighbor"), "neighbor manifest");
				const stdout = await runDownloadPowershell(root, [
					downloadPrelude(root, origin), requireSystemCurl,
					`try { Assert-Checksum -Tag ${psLiteral(scenario)} -AssetName 'gjc.exe' -DownloadedPath $out; 'INTEGRITY=VERIFIED' }`,
					"catch { 'INTEGRITY=REFUSED'; 'FAILURE=' + $_.Exception.Message }",
					"'DIGEST=' + (Get-FileSha256Lower $out)",
				].join("\n"));
				if (scenario === "valid" || scenario === "fallback") {
					expect(stdout).toContain("INTEGRITY=VERIFIED");
					expect(stdout).not.toContain("INTEGRITY=REFUSED");
				} else {
					expect(stdout).toContain("INTEGRITY=REFUSED");
					expect(stdout).not.toContain("INTEGRITY=VERIFIED");
					const reason = scenario === "mismatch" ? "Checksum mismatch" : scenario === "unlisted" ? "did not list gjc.exe" : "has no checksum assets";
					expect(stdout).toContain(reason);
				}
				expect(stdout).toContain(`DIGEST=${downloadDigest}`);
				expect(new Uint8Array(await Bun.file(path.join(root, "download.bin")).arrayBuffer())).toEqual(downloadBytes);
				expect(await Bun.file(path.join(root, "gjc.exe")).text()).toBe("existing target");
				expect(await Bun.file(path.join(root, "sentinel")).text()).toBe("untouched sentinel");
				expect(await Bun.file(path.join(root, ".gjc.sha256.neighbor")).text()).toBe("neighbor sums");
				expect(await Bun.file(path.join(root, ".gjc.manifest.neighbor")).text()).toBe("neighbor manifest");
				const temps = (await fs.readdir(root)).filter(name => name.startsWith(".gjc.sha256.") || name.startsWith(".gjc.manifest."));
				expect(temps.sort()).toEqual([".gjc.manifest.neighbor", ".gjc.sha256.neighbor"]);
				const expectedRequests = [`/${scenario}/checksums.sha256`];
				if (scenario === "fallback" || scenario === "missing") expectedRequests.push(`/${scenario}/manifest.json`);
				expect(requests).toEqual(expectedRequests);
			});
		}, 30_000);
	}
});
