import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BinaryUpdateFlow } from "../src/cli/update-cli";
import {
	assertSupportedLinuxLibcForTest,
	buildReleaseBinaryUrlForTest,
	compareVersionsForTest,
	defaultUserBinaryPathForTest,
	formatBinaryDownloadFailureMessageForTest,
	formatManualUpdateInstructionsForTest,
	formatVerificationFailureForTest,
	fsyncFileForTest,
	getLatestReleaseForTest,
	hasManagedNotifySetup,
	isProtectedSourcePathForTest,
	parseReportedVersionForTest,
	parseUpdateArgs,
	recoverWindowsUpdateJournal,
	replaceBinaryForUpdate,
	resolveGjcPathForTest,
	resolveNpmManagedTargetForTest,
	resolveUpdateDecision,
	resolveUpdateMethodForTest,
	runBinaryUpdateFlow,
	runManagedNotifyRecovery,
	runPackageManagerUpdateForTest,
	runPostUpdateRecoveryForTest,
	runUpdateCommand,
	sanitizeVerificationOutputForTest,
	verifyInstalledVersionForTest,
	verifyMigrationTargetAdapterForTest,
	verifyMigrationTargetForTest,
} from "../src/cli/update-cli";
import { Settings } from "../src/config/settings";
import { distTagForChannel, isUpdateChannel } from "../src/config/update-channel";
import { initTheme } from "../src/modes/theme/theme";
import { DEFAULT_NPM_REGISTRY } from "../src/utils/npm-registry";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dir, "../../..");

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("update-cli recovery command surface", () => {
	it("advertises update-recovery so verified runtimes can feature-probe it", async () => {
		const result = Bun.spawnSync([process.execPath, "src/cli.ts", "update", "--help"], {
			cwd: path.join(repoRoot, "packages", "coding-agent"),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("update-recovery");
	});
});

describe("update-cli release lookup", () => {
	const isolated = {
		lookupEnv: () => undefined,
	};

	it("asks GitHub releases/latest for the stable channel", async () => {
		const requested: string[] = [];

		const release = await getLatestReleaseForTest({
			...isolated,
			fetchImpl: async url => {
				requested.push(String(url));
				return new Response(JSON.stringify({ tag_name: "v9.9.9", draft: false, prerelease: false }), {
					status: 200,
				});
			},
		});

		expect(requested).toEqual(["https://api.github.com/repos/Yeachan-Heo/gajae-code/releases/latest"]);
		expect(release).toEqual({
			tag: "v9.9.9",
			version: "9.9.9",
			registry: "https://github.com/Yeachan-Heo/gajae-code",
			warnings: [],
		});
	});

	it("surfaces the failing url and status so blocked GitHub APIs are diagnosable", async () => {
		const failing = getLatestReleaseForTest({
			...isolated,
			fetchImpl: async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }),
		});

		await expect(failing).rejects.toThrow(
			"https://api.github.com/repos/Yeachan-Heo/gajae-code/releases/latest responded 503",
		);
	});
});

describe("update-cli install target detection", () => {
	it("uses bun update when prioritized gjc is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/gjc", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized gjc is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/gjc", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/gjc", undefined);

		expect(method).toBe("binary");
	});

	it("detects a Windows npm wrapper shim and avoids one-file binary replacement", () => {
		const seenRoots: Array<{ packageName: string; packageRoot: string }> = [];
		const target = resolveNpmManagedTargetForTest(
			"C:\\Users\\alice\\AppData\\Roaming\\npm\\gjc.cmd",
			"win32",
			(packageName, packageRoot) => {
				seenRoots.push({ packageName, packageRoot });
				return packageName === "gajae-code";
			},
		);

		expect(target).toEqual({ manager: "npm", packageName: "gajae-code" });
		expect(seenRoots[0]).toEqual({
			packageName: "gajae-code",
			packageRoot: "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\gajae-code",
		});
	});

	it("detects PowerShell npm wrapper shims so gjc.ps1 is updated through npm too", () => {
		const target = resolveNpmManagedTargetForTest(
			"C:\\Users\\alice\\AppData\\Roaming\\npm\\gjc.ps1",
			"win32",
			packageName => packageName === "gajae-code",
		);

		expect(target).toEqual({ manager: "npm", packageName: "gajae-code" });
	});

	it("does not classify missing Windows node_modules roots as npm-managed", () => {
		const target = resolveNpmManagedTargetForTest(
			"C:\\Users\\alice\\AppData\\Roaming\\npm\\gjc.cmd",
			"win32",
			() => false,
		);

		expect(target).toBeUndefined();
	});

	it("keeps non-Windows package-manager-like shims on the existing bun/binary classifier", () => {
		const target = resolveNpmManagedTargetForTest("/usr/local/bin/gjc", "linux", () => true);

		expect(target).toBeUndefined();
	});
});

describe("update-cli binary release assets", () => {
	it("does not mistake an installed musl loader for the active libc", () => {
		expect(() => assertSupportedLinuxLibcForTest("2.35", true)).not.toThrow();
	});

	it("detects a genuine musl host when no glibc runtime is active", () => {
		expect(() => assertSupportedLinuxLibcForTest(undefined, true)).toThrow("Unsupported libc: musl");
	});

	it("fails closed when neither an active glibc runtime nor a musl loader can be detected", () => {
		expect(() => assertSupportedLinuxLibcForTest(undefined, false)).toThrow(
			"Unable to verify an active glibc runtime",
		);
	});

	it("does not accept an empty glibc runtime report", () => {
		expect(() => assertSupportedLinuxLibcForTest("   ", true)).toThrow("Unsupported libc: musl");
	});

	it("does not accept an unparseable glibc runtime report", () => {
		expect(() => assertSupportedLinuxLibcForTest("not-a-version", true)).toThrow("Unsupported libc: musl");
		expect(() => assertSupportedLinuxLibcForTest("not-a-version", false)).toThrow(
			"Unable to verify an active glibc runtime",
		);
		expect(() => assertSupportedLinuxLibcForTest("2.x", false)).toThrow("Unable to verify an active glibc runtime");
	});

	it("accepts a trimmed major-minor glibc runtime report", () => {
		expect(() => assertSupportedLinuxLibcForTest(" 2.35 ", true)).not.toThrow();
	});

	it("downloads fallback binaries from the current owner release repository", () => {
		expect(buildReleaseBinaryUrlForTest("0.2.3", "linux", "x64")).toBe(
			"https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-linux-x64",
		);
	});

	it("uses the existing Windows .exe release asset name", () => {
		expect(buildReleaseBinaryUrlForTest("0.2.3", "win32", "x64")).toBe(
			"https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-windows-x64.exe",
		);
	});
	it("rejects Windows ARM64 because no release asset exists", () => {
		expect(() => buildReleaseBinaryUrlForTest("0.2.3", "win32", "arm64")).toThrow("Unsupported architecture: arm64");
	});

	it("reports actionable Unix manual update commands for unsupported fallback paths", () => {
		const instructions = formatManualUpdateInstructionsForTest("linux");

		expect(instructions).toContain(
			"curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh",
		);
		expect(instructions).toContain("Bun is only required for source development/build");
		expect(instructions).not.toContain("bun install -g");
	});

	it("reports actionable Windows manual update commands for unsupported fallback paths", () => {
		const instructions = formatManualUpdateInstructionsForTest("win32");

		expect(instructions).toContain(
			"irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1 | iex",
		);
		expect(instructions).toContain("Bun is only required for source development/build");
		expect(instructions).not.toContain("bun install -g");
	});

	it("keeps manual reinstall guidance aligned with bundled installer repositories", async () => {
		const instructions = formatManualUpdateInstructionsForTest("linux");
		const shellInstaller = await Bun.file(path.join(repoRoot, "scripts/install.sh")).text();
		const windowsInstaller = await Bun.file(path.join(repoRoot, "scripts/install.ps1")).text();

		expect(instructions).toContain("raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh");
		expect(shellInstaller).toContain('REPO="Yeachan-Heo/gajae-code"');
		expect(windowsInstaller).toContain('$Repo = "Yeachan-Heo/gajae-code"');
		expect(formatManualUpdateInstructionsForTest("win32")).toContain(
			"raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1",
		);
	});

	it("reports smoke-test failures as stale or partial update risk", () => {
		const message = formatVerificationFailureForTest(
			{
				ok: false,
				actual: "0.6.1",
				smokeTestFailed: true,
				smokeTestOutput: "native addon\nrelease\tmismatch",
			},
			"0.6.1",
		);

		expect(message).toContain("--smoke-test failed");
		expect(message).toContain("stale or partial update");
		expect(message).toContain("native addon release mismatch");
		expect(message).not.toContain("undefined");
	});

	it("preserves Bun version guard stderr when installed version verification fails", async () => {
		const verification = await verifyInstalledVersionForTest({
			expectedVersion: "0.15.6",
			runtimePath: "/Users/test/.bun/bin/gjc",
			runVersion: async () => ({
				exitCode: 1,
				stderr:
					"error: gjc requires Bun >= 1.4.0, but the running Bun is v1.3.14.\n  detected Bun runtime: /Users/test/.bun/bin/bun\n",
				stdout: "",
			}),
		});
		const message = formatVerificationFailureForTest(verification, "0.15.6");

		expect(message).toContain("requires Bun >= 1.4.0");
		expect(message).toContain("running Bun is v1.3.14");
		expect(message).toContain("at /Users/test/.bun/bin/gjc");
	});

	it("uses stdout when failed installed version verification has no stderr", async () => {
		const verification = await verifyInstalledVersionForTest({
			expectedVersion: "0.15.6",
			runtimePath: "/opt/gjc",
			runVersion: async () => ({ exitCode: 1, stderr: "", stdout: "runtime bootstrap failed on stdout\n" }),
		});

		expect(formatVerificationFailureForTest(verification, "0.15.6")).toContain("runtime bootstrap failed on stdout");
	});

	it("still parses successful installed version output", async () => {
		const verification = await verifyInstalledVersionForTest({
			expectedVersion: "0.15.6",
			runtimePath: "C:\\Tools\\gjc.exe",
			runVersion: async runtimePath => {
				expect(runtimePath).toBe("C:\\Tools\\gjc.exe");
				return { exitCode: 0, stderr: "", stdout: "gjc/0.15.6\n" };
			},
		});

		expect(verification).toEqual({
			ok: true,
			actual: "0.15.6",
			path: "C:\\Tools\\gjc.exe",
		});
	});

	it("keeps the generic fallback when failed installed version verification has no output", () => {
		const output = sanitizeVerificationOutputForTest("  \n\t", "");

		expect(
			formatVerificationFailureForTest({ ok: false, path: "C:\\Tools\\gjc.exe", versionOutput: output }, "0.15.6"),
		).toBe("could not verify updated version at C:\\Tools\\gjc.exe");
	});

	it("bounds failed installed version verification output", () => {
		const output = sanitizeVerificationOutputForTest("x".repeat(1_000), undefined);

		expect(output).toHaveLength(512);
		expect(output).toEndWith("...");
	});

	it("redacts secrets before reporting failed installed version verification output", () => {
		const output = sanitizeVerificationOutputForTest(
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz api_key=sk-abcdefghijklmnopqrstuvwxyz012345",
			undefined,
		);

		expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
		expect(output).toContain("redacted");
	});

	it("includes actionable guidance when a release asset download fails", () => {
		const message = formatBinaryDownloadFailureMessageForTest(
			"gjc-linux-x64",
			"https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-linux-x64",
			"Not Found",
			"linux",
		);

		expect(message).toContain("Download failed for gjc-linux-x64");
		expect(message).toContain("Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-linux-x64");
		expect(message).toContain(
			"curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh",
		);
	});

	it("points at the mirror that named the version when the GitHub asset is missing", () => {
		const message = formatBinaryDownloadFailureMessageForTest(
			"gjc-linux-x64",
			"https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-linux-x64",
			"Not Found",
			"linux",
			"Version 0.2.3 was resolved from https://nexus.example.com/npm, not https://registry.npmjs.org; a version published only to that registry has no matching GitHub release asset.",
		);

		expect(message).toContain("Download failed for gjc-linux-x64");
		expect(message).toContain("was resolved from https://nexus.example.com/npm");
		expect(message).toContain(
			"curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh",
		);
	});

	it("says nothing about provenance when the public registry named the version", () => {
		const message = formatBinaryDownloadFailureMessageForTest(
			"gjc-linux-x64",
			"https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-linux-x64",
			"Not Found",
			"linux",
		);

		expect(message).not.toContain("was resolved from");
	});

	it("includes actionable guidance when the platform has no release asset", () => {
		expect(() => buildReleaseBinaryUrlForTest("0.2.3", "freebsd", "x64")).toThrow(
			"curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh",
		);
	});
});

describe("update-cli package-manager verification", () => {
	it("treats a nonzero bun install as successful when the installed runtime verifies", async () => {
		const warnings: string[] = [];
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(message => {
			warnings.push(String(message));
		});
		try {
			const result = await runPackageManagerUpdateForTest({
				managerName: "bun",
				expectedVersion: "0.7.8",
				runInstall: async () => ({
					exitCode: 1,
					text: () => 'Fail extracting tarball for "@gajae-code/natives"',
				}),
				verifyInstalledRuntime: async expectedVersion => ({
					ok: true,
					actual: expectedVersion,
					path: "/Users/test/.bun/bin/gjc",
				}),
				printRecoveredVerification: () => {},
			});

			expect(result.ok).toBe(true);
			expect(result.actual).toBe("0.7.8");
			expect(warnings.join("\n")).toContain("bun exited with 1");
			expect(warnings.join("\n")).toContain("Treating the update as installed");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("verifies a zero-exit install once and prints success and restart guidance once", async () => {
		await initTheme();
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		let verificationCalls = 0;
		try {
			const result = await runPackageManagerUpdateForTest({
				managerName: "bun",
				expectedVersion: "0.7.8",
				runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
				verifyInstalledRuntime: async expectedVersion => {
					verificationCalls += 1;
					return { ok: true, actual: expectedVersion, path: "/Users/test/.bun/bin/gjc" };
				},
			});

			expect(result.ok).toBe(true);
			expect(verificationCalls).toBe(1);
			expect(output.filter(line => line.includes("Updated to 0.7.8"))).toHaveLength(1);
			expect(output.filter(line => line.includes("Restart gjc to use the new version"))).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("rejects a zero-exit stale install with verification-specific diagnostics and no success output", async () => {
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		let verificationCalls = 0;
		try {
			await expect(
				runPackageManagerUpdateForTest({
					managerName: "bun",
					expectedVersion: "0.7.8",
					runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
					verifyInstalledRuntime: async () => {
						verificationCalls += 1;
						return { ok: false, actual: "0.7.7", path: "/Users/test/.bun/bin/gjc" };
					},
				}),
			).rejects.toThrow("bun install exited successfully, but the selected gjc runtime failed verification");
			expect(verificationCalls).toBe(1);
			expect(output.join("\n")).not.toContain("install failed with exit code 0");
			expect(output.filter(line => line.includes("Updated to"))).toHaveLength(0);
			expect(output.filter(line => line.includes("Restart gjc"))).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("keeps package-manager nonzero failures hard when runtime verification does not prove the update landed", async () => {
		await expect(
			runPackageManagerUpdateForTest({
				managerName: "bun",
				expectedVersion: "0.7.8",
				runInstall: async () => ({
					exitCode: 1,
					text: () => 'Fail extracting tarball for "@gajae-code/natives"',
				}),
				verifyInstalledRuntime: async () => ({
					ok: false,
					actual: "0.7.7",
					path: "/Users/test/.bun/bin/gjc",
				}),
			}),
		).rejects.toThrow("Fail extracting tarball");
	});
});

describe("update-cli command verification failures", () => {
	it("exits without refreshing defaults when a zero-exit install leaves a stale runtime", async () => {
		const output: string[] = [];
		const errors: string[] = [];
		const exitCodes: number[] = [];
		const sentinel = new Error("exit");
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => {
			errors.push(String(message));
		});
		let verificationCalls = 0;
		let refreshCalls = 0;
		try {
			await expect(
				runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => ({
							tag: "v999.0.0",
							version: "999.0.0",
							registry: DEFAULT_NPM_REGISTRY,
							warnings: [],
						}),
						resolveUpdateTarget: async () => ({ method: "bun" }),
						performUpdate: async (_target, expectedVersion) => {
							await runPackageManagerUpdateForTest({
								managerName: "bun",
								expectedVersion,
								runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
								verifyInstalledRuntime: async () => {
									verificationCalls += 1;
									return { ok: false, actual: "0.0.1", path: "/test/gjc" };
								},
							});
						},
						refreshInstalledDefaultSkills: async () => {
							refreshCalls += 1;
						},
						exit: code => {
							exitCodes.push(code);
							throw sentinel;
						},
					},
				),
			).rejects.toBe(sentinel);
			expect(verificationCalls).toBe(1);
			expect(exitCodes).toEqual([1]);
			expect(refreshCalls).toBe(0);
			expect(errors.join("\n")).toContain(
				"install exited successfully, but the selected gjc runtime failed verification",
			);
			expect(errors.join("\n")).toContain("still reports 0.0.1 (expected 999.0.0)");
			expect(errors.join("\n")).not.toContain("install failed with exit code 0");
			expect(output.filter(line => line.includes("Updated to") || line.includes("Restart gjc"))).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("exits without refreshing defaults when a zero-exit install fails its smoke test", async () => {
		const output: string[] = [];
		const errors: string[] = [];
		const exitCodes: number[] = [];
		const sentinel = new Error("exit");
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => {
			errors.push(String(message));
		});
		let verificationCalls = 0;
		let refreshCalls = 0;
		try {
			await expect(
				runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => ({
							tag: "v999.0.0",
							version: "999.0.0",
							registry: DEFAULT_NPM_REGISTRY,
							warnings: [],
						}),
						resolveUpdateTarget: async () => ({ method: "bun" }),
						performUpdate: async (_target, expectedVersion) => {
							await runPackageManagerUpdateForTest({
								managerName: "bun",
								expectedVersion,
								runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
								verifyInstalledRuntime: async () => {
									verificationCalls += 1;
									return {
										ok: false,
										actual: "999.0.0",
										path: "/test/gjc",
										smokeTestFailed: true,
										smokeTestOutput: "native addon mismatch",
									};
								},
							});
						},
						refreshInstalledDefaultSkills: async () => {
							refreshCalls += 1;
						},
						exit: code => {
							exitCodes.push(code);
							throw sentinel;
						},
					},
				),
			).rejects.toBe(sentinel);
			expect(verificationCalls).toBe(1);
			expect(exitCodes).toEqual([1]);
			expect(refreshCalls).toBe(0);
			expect(errors.join("\n")).toContain("--smoke-test failed");
			expect(errors.join("\n")).toContain("native addon mismatch");
			expect(errors.join("\n")).toContain(
				"install exited successfully, but the selected gjc runtime failed verification",
			);
			expect(errors.join("\n")).not.toContain("install failed with exit code 0");
			expect(output.filter(line => line.includes("Updated to") || line.includes("Restart gjc"))).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});

describe("update-cli managed notification recovery", () => {
	const release = {
		tag: "v999.0.0",
		version: "999.0.0",
		registry: DEFAULT_NPM_REGISTRY,
		warnings: [],
	};

	describe("standalone migration preflight", () => {
		const target = { method: "migrate" as const, path: "/standalone/gjc", previousPath: "/shim/gjc" };

		it("verifies the release checksum before executing the migration target", async () => {
			const calls: string[] = [];
			const result = await verifyMigrationTargetForTest({
				runtimePath: target.path,
				verifyChecksum: async () => {
					calls.push("checksum");
				},
				verifyRuntime: async () => {
					calls.push("runtime");
					return { ok: true, actual: release.version, path: target.path };
				},
			});
			expect(calls).toEqual(["checksum", "runtime"]);
			expect(result).toEqual({ ok: true, actual: release.version, path: target.path });
		});

		it("holds the binary update lock across migration preflight", async () => {
			const root = await makeTempDir();
			const runtimePath = path.join(root, "gjc");
			const lockPath = path.join(root, ".gjc-install.lock");
			await runUpdateCommand(
				{ force: false, check: false },
				{
					getLatestRelease: async () => release,
					resolveUpdateTarget: async () => ({ method: "migrate", path: runtimePath }),
					verifyMigrationTarget: async () => {
						expect(fsNode.existsSync(lockPath)).toBe(true);
						return { ok: true, actual: release.version, path: runtimePath };
					},
				},
			);
			expect(fsNode.existsSync(lockPath)).toBe(false);
		});

		it("does not execute a missing or tampered migration target when checksum verification fails", async () => {
			const calls: string[] = [];
			const result = await verifyMigrationTargetForTest({
				runtimePath: target.path,
				verifyChecksum: async () => {
					calls.push("checksum");
					throw new Error("checksum mismatch");
				},
				verifyRuntime: async () => {
					calls.push("runtime");
					return { ok: true, actual: release.version, path: target.path };
				},
			});
			expect(calls).toEqual(["checksum"]);
			expect(result).toEqual({ ok: false, path: target.path });
		});

		it("passes the release tag, binary asset, and target path to checksum verification", async () => {
			const checksumCalls: Array<{ tag: string; assetName: string; filePath: string }> = [];
			const result = await verifyMigrationTargetAdapterForTest({
				release,
				runtimePath: target.path,
				verifyChecksum: async options => {
					checksumCalls.push(options);
				},
				verifyRuntime: async (expectedVersion, runtimePath) => ({
					ok: true,
					actual: expectedVersion,
					path: runtimePath,
				}),
			});
			// Derive the expected asset from the production platform mapping so the
			// assertion stays host-faithful (including the Windows `.exe` name) and
			// fails loudly through the same unsupported-platform errors.
			const assetName = path.posix.basename(
				buildReleaseBinaryUrlForTest(release.version, process.platform, process.arch),
			);
			expect(checksumCalls).toEqual([{ tag: release.tag, assetName, filePath: target.path }]);
			expect(result).toEqual({ ok: true, actual: release.version, path: target.path });
		});

		it("keeps a checksum-valid but stale or smoke-failing target on the migration path", async () => {
			const calls: string[] = [];
			const result = await verifyMigrationTargetForTest({
				runtimePath: target.path,
				verifyChecksum: async () => {
					calls.push("checksum");
				},
				verifyRuntime: async () => {
					calls.push("runtime");
					return {
						ok: false,
						actual: release.version,
						path: target.path,
						smokeTestFailed: true,
					};
				},
			});
			expect(calls).toEqual(["checksum", "runtime"]);
			expect(result).toEqual({
				ok: false,
				actual: release.version,
				path: target.path,
				smokeTestFailed: true,
			});
		});

		it("skips update recovery and defaults refresh when the standalone target already verifies", async () => {
			const calls: string[] = [];
			const output: string[] = [];
			const logSpy = vi.spyOn(console, "log").mockImplementation(message => output.push(String(message)));
			try {
				await runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => release,
						resolveUpdateTarget: async () => target,
						verifyMigrationTarget: async (expectedRelease, runtimePath) => {
							expect(expectedRelease).toEqual(release);
							expect(runtimePath).toBe(target.path);
							return { ok: true, actual: expectedRelease.version, path: runtimePath };
						},
						performUpdate: async () => {
							calls.push("update");
							return { ok: true, path: target.path };
						},
						runPostUpdateRecovery: async () => {
							calls.push("recovery");
						},
						refreshInstalledDefaultSkills: async () => {
							calls.push("refresh");
						},
					},
				);
				expect(calls).toEqual([]);
				expect(output.join("\n")).toContain(
					`Standalone gjc ${release.version} is already installed and verified at ${target.path}`,
				);
				expect(output.join("\n")).toContain(`${target.previousPath} shadows it on PATH.`);
				expect(output.join("\n")).toContain("must precede the shim directory");
			} finally {
				logSpy.mockRestore();
			}
		});

		it("leaves a shim-first repeated invocation non-mutating after standalone verification", async () => {
			const calls: string[] = [];
			for (let attempt = 0; attempt < 2; attempt++) {
				await runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => release,
						resolveUpdateTarget: async () => target,
						verifyMigrationTarget: async () => {
							calls.push("verify standalone");
							return { ok: true, actual: release.version, path: target.path };
						},
						performUpdate: async () => {
							calls.push("update");
							return { ok: true, path: target.path };
						},
						runPostUpdateRecovery: async () => {
							calls.push("recovery");
						},
						refreshInstalledDefaultSkills: async () => {
							calls.push("refresh");
						},
					},
				);
			}
			expect(calls).toEqual(["verify standalone", "verify standalone"]);
		});

		it("reports a verified shadowed target in check mode without performing an update", async () => {
			const calls: string[] = [];
			await runUpdateCommand(
				{ force: false, check: true },
				{
					getLatestRelease: async () => release,
					resolveUpdateTarget: async () => target,
					verifyMigrationTarget: async () => {
						calls.push("verify");
						return { ok: true, actual: release.version, path: target.path };
					},
					performUpdate: async () => {
						calls.push("update");
						return { ok: true, path: target.path };
					},
				},
			);
			expect(calls).toEqual(["verify"]);
		});

		it("skips an already verified nightly migration target", async () => {
			const calls: string[] = [];
			const nightlyRelease = {
				...release,
				tag: "v999.0.0-nightly.20260828000000.1.gabcdef123456",
				version: "999.0.0-nightly.20260828000000.1.gabcdef123456",
			};
			await runUpdateCommand(
				{ force: false, check: false, channel: "nightly" },
				{
					getLatestRelease: async options => {
						expect(options?.channel).toBe("nightly");
						return nightlyRelease;
					},
					resolveUpdateTarget: async () => target,
					verifyMigrationTarget: async expectedRelease => {
						calls.push("verify");
						expect(expectedRelease).toEqual(nightlyRelease);
						return { ok: true, actual: nightlyRelease.version, path: target.path };
					},
					performUpdate: async () => {
						calls.push("update");
						return { ok: true, path: target.path };
					},
				},
			);
			expect(calls).toEqual(["verify"]);
		});

		it("migrates when the standalone target is stale or fails its smoke test", async () => {
			const calls: string[] = [];
			await runUpdateCommand(
				{ force: false, check: false },
				{
					getLatestRelease: async () => release,
					resolveUpdateTarget: async () => target,
					verifyMigrationTarget: async () => ({
						ok: false,
						actual: release.version,
						path: target.path,
						smokeTestFailed: true,
					}),
					performUpdate: async () => {
						calls.push("update");
						return { ok: true, path: target.path };
					},
					runPostUpdateRecovery: async () => {
						calls.push("recovery");
					},
					refreshInstalledDefaultSkills: async () => {
						calls.push("refresh");
					},
				},
			);
			expect(calls).toEqual(["update", "recovery", "refresh"]);
		});

		it("keeps a successful update successful when the optional app offer rejects", async () => {
			const calls: string[] = [];
			await runUpdateCommand(
				{ force: false, check: false },
				{
					platform: "darwin",
					getLatestRelease: async () => release,
					resolveUpdateTarget: async () => ({ method: "binary", path: "/standalone/gjc" }),
					performUpdate: async () => ({ ok: true, path: "/standalone/gjc" }),
					runPostUpdateRecovery: async () => {
						calls.push("recovery");
					},
					refreshInstalledDefaultSkills: async () => {
						calls.push("refresh");
					},
					offerCommunityApp: async runtimePath => {
						calls.push(`offer:${runtimePath}`);
						throw new Error("detach failed");
					},
				},
			);
			expect(calls).toEqual(["recovery", "refresh", "offer:/standalone/gjc"]);
		});

		it("runs the optional app offer from a verified migration runtime", async () => {
			const calls: string[] = [];
			const events: string[] = [];
			await runUpdateCommand(
				{ force: false, check: false },
				{
					platform: "darwin",
					getLatestRelease: async () => release,
					resolveUpdateTarget: async () => target,
					verifyMigrationTarget: async () => ({ ok: true, actual: release.version, path: target.path }),
					offerCommunityApp: async runtimePath => {
						calls.push(`offer:${runtimePath}`);
					},
					recordTelemetryEvent: event => events.push(event),
				},
			);
			expect(calls).toEqual(["offer:/standalone/gjc"]);
			expect(events).toContain("update_install_completed");
		});

		it("capability-gates the offer command on the verified update runtime", async () => {
			const calls: string[] = [];
			await runUpdateCommand(
				{ force: false, check: false },
				{
					platform: "darwin",
					getLatestRelease: async () => release,
					resolveUpdateTarget: async () => ({ method: "binary", path: "/standalone/gjc" }),
					performUpdate: async () => ({ ok: true, path: "/standalone/gjc" }),
					runPostUpdateRecovery: async () => {
						calls.push("recovery");
					},
					refreshInstalledDefaultSkills: async () => {
						calls.push("refresh");
					},
					supportsCommunityApp: async runtimePath => {
						calls.push(`support:${runtimePath}`);
						return true;
					},
					spawnCommunityApp: async argv => {
						calls.push(argv.join("|"));
						return 0;
					},
				},
			);
			expect(calls).toEqual([
				"recovery",
				"refresh",
				"support:/standalone/gjc",
				"/standalone/gjc|--internal-macos-community-app-offer",
			]);
		});

		it("does not preflight a migration target when the release decision is already up to date", async () => {
			const calls: string[] = [];
			await runUpdateCommand(
				{ force: false, check: false },
				{
					getLatestRelease: async () => ({ ...release, version: "0.0.1" }),
					resolveUpdateTarget: async () => target,
					verifyMigrationTarget: async () => {
						calls.push("verify");
						return { ok: true, path: target.path };
					},
					performUpdate: async () => {
						calls.push("update");
						return { ok: true, path: target.path };
					},
				},
			);
			expect(calls).toEqual([]);
		});

		it("bypasses migration preflight when force is set", async () => {
			const calls: string[] = [];
			await runUpdateCommand(
				{ force: true, check: false },
				{
					getLatestRelease: async () => release,
					resolveUpdateTarget: async () => target,
					verifyMigrationTarget: async () => {
						calls.push("verify");
						return { ok: true, path: target.path };
					},
					performUpdate: async () => {
						calls.push("update");
						return { ok: true, path: target.path };
					},
					runPostUpdateRecovery: async () => {
						calls.push("recovery");
					},
					refreshInstalledDefaultSkills: async () => {
						calls.push("refresh");
					},
				},
			);
			expect(calls).toEqual(["update", "recovery", "refresh"]);
		});
	});

	function configuredSettings(overrides: Record<string, unknown> = {}): Settings {
		return Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.enabled": true,
			"notifications.telegram.botToken": "telegram-secret",
			"notifications.telegram.chatId": "42",
			...overrides,
		} as never);
	}

	it("executes recovery through the verified runtime with an argv array and propagates nonzero exits", async () => {
		const argv: Array<readonly string[]> = [];
		await runPostUpdateRecoveryForTest(
			"/verified path/gjc;not-a-shell",
			async args => {
				argv.push(args);
				return 0;
			},
			async () => true,
		);
		expect(argv).toEqual([["/verified path/gjc;not-a-shell", "update", "update-recovery"]]);
		await expect(
			runPostUpdateRecoveryForTest(
				"/verified/gjc",
				async () => 23,
				async () => true,
			),
		).rejects.toThrow("the verified installed runtime exited 23");
	});

	it("uses the bounded legacy handoff only when the verified target lacks update-recovery", async () => {
		const argv: string[][] = [];
		await runPostUpdateRecoveryForTest(
			"/older stable/gjc",
			async args => {
				argv.push(args);
				return 0;
			},
			async () => false,
			async () => ["discord"],
		);
		expect(argv).toEqual([
			["/older stable/gjc", "daemon", "stop", "discord", "--force"],
			["/older stable/gjc", "daemon", "reload", "discord"],
			["/older stable/gjc", "notify", "recovery"],
		]);
	});

	it("targets a Slack-only durable provider during legacy recovery", async () => {
		const argv: string[][] = [];
		await runPostUpdateRecoveryForTest(
			"/older stable/gjc",
			async args => {
				argv.push(args);
				return 0;
			},
			async () => false,
			async () => ["slack"],
		);
		expect(argv).toEqual([
			["/older stable/gjc", "daemon", "stop", "slack", "--force"],
			["/older stable/gjc", "daemon", "reload", "slack"],
			["/older stable/gjc", "notify", "recovery"],
		]);
	});

	it("fails fast when a legacy recovery stage fails", async () => {
		const argv: string[][] = [];
		await expect(
			runPostUpdateRecoveryForTest(
				"/older/gjc",
				async args => {
					argv.push(args);
					return args[2] === "reload" ? 17 : 0;
				},
				async () => false,
				async () => ["slack"],
			),
		).rejects.toThrow("legacy post-update daemon reload exited 17");
		expect(argv).toEqual([
			["/older/gjc", "daemon", "stop", "slack", "--force"],
			["/older/gjc", "daemon", "reload", "slack"],
		]);
	});

	it("uses canonical global provider completeness, including globally disabled configured credentials", () => {
		expect(hasManagedNotifySetup(Settings.isolated())).toBe(false);
		expect(hasManagedNotifySetup(configuredSettings({ "notifications.enabled": false }))).toBe(true);
		expect(hasManagedNotifySetup(configuredSettings({ "notifications.telegram.enabled": false }))).toBe(false);
		expect(
			hasManagedNotifySetup(
				configuredSettings({
					"notifications.telegram.botToken": " ",
					"notifications.discord.enabled": true,
				}),
			),
		).toBe(false);
		expect(
			hasManagedNotifySetup(
				configuredSettings({
					"notifications.discord.enabled": true,
					"notifications.discord.botToken": "discord-secret",
					"notifications.discord.applicationId": "app",
					"notifications.discord.guildId": "guild",
					"notifications.discord.parentChannelId": "channel",
					"notifications.telegram.enabled": "malformed",
				}),
			),
		).toBe(true);
	});

	it.each(["binary", "bun", "npm"] as const)("runs the verified %s lifecycle in exact order", async method => {
		const calls: string[] = [];
		const target =
			method === "binary"
				? { method, path: "/verified/gjc" }
				: method === "npm"
					? { method, packageName: "gajae-code" }
					: { method };
		await runUpdateCommand(
			{ force: false, check: false },
			{
				getLatestRelease: async () => release,
				resolveUpdateTarget: async () => target,
				performUpdate: async () => {
					calls.push("verified install");
					return { ok: true, path: "/verified/gjc" };
				},
				runPostUpdateRecovery: async runtimePath => {
					expect(runtimePath).toBe("/verified/gjc");
					await runManagedNotifyRecovery({
						settings: async () => configuredSettings({ "notifications.enabled": false }),
						stopDaemon: async settings => {
							expect(settings).toBeDefined();
							calls.push("stop --force");
						},
						restartDaemon: async () => {
							calls.push("restart");
						},
						recoverNotifications: async () => {
							calls.push("notify recovery");
						},
					});
				},
				refreshInstalledDefaultSkills: async () => {
					calls.push("refresh defaults");
				},
			},
		);
		expect(calls).toEqual(["verified install", "stop --force", "restart", "notify recovery", "refresh defaults"]);
	});

	it.each([
		["stop", ["verified install", "stop --force"]],
		["restart", ["verified install", "stop --force", "restart"]],
		["recovery", ["verified install", "stop --force", "restart", "notify recovery"]],
	] as [string, string[]][])("fails closed after %s lifecycle failure", async (failure, expectedCalls) => {
		const calls: string[] = [];
		const errors: string[] = [];
		const exits: number[] = [];
		const sentinel = new Error("exit");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => errors.push(String(message)));
		try {
			await expect(
				runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => release,
						resolveUpdateTarget: async () => ({ method: "bun" }),
						performUpdate: async () => {
							calls.push("verified install");
							return { ok: true, path: "/verified/gjc" };
						},
						runPostUpdateRecovery: async () =>
							await runManagedNotifyRecovery({
								settings: async () => configuredSettings(),
								stopDaemon: async () => {
									calls.push("stop --force");
									if (failure === "stop") throw new Error("stop failed");
								},
								restartDaemon: async () => {
									calls.push("restart");
									if (failure === "restart") throw new Error("restart failed");
								},
								recoverNotifications: async () => {
									calls.push("notify recovery");
									if (failure === "recovery") throw new Error("recovery failed");
								},
							}),
						refreshInstalledDefaultSkills: async () => {
							calls.push("refresh defaults");
						},
						exit: code => {
							exits.push(code);
							throw sentinel;
						},
					},
				),
			).rejects.toBe(sentinel);
			expect(calls).toEqual(expectedCalls);
			expect(exits).toEqual([1]);
			const stage =
				failure === "stop" ? "daemon stop --force" : failure === "restart" ? "daemon restart" : "notify recovery";
			expect(errors.join("\n")).toContain(`Post-update ${stage} failed`);
			expect(errors.join("\n")).not.toContain("telegram-secret");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("reports recovery failure as partial success after the installed runtime verifies", async () => {
		const errors: string[] = [];
		const sentinel = new Error("exit");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => errors.push(String(message)));
		try {
			await expect(
				runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => release,
						resolveUpdateTarget: async () => ({ method: "bun" }),
						performUpdate: async () => ({ ok: true, path: "/verified/gjc" }),
						runPostUpdateRecovery: async () => {
							throw new Error("restart failed");
						},
						exit: () => {
							throw sentinel;
						},
					},
				),
			).rejects.toBe(sentinel);
			expect(errors.join("\n")).toContain(
				"Updated to 999.0.0, but post-update recovery failed: Error: restart failed",
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("does not initialize notification recovery for checks, up-to-date responses, failed installs, or missing verified runtime identity", async () => {
		let settingsCalls = 0;
		const lifecycle = {
			runPostUpdateRecovery: async () => {
				settingsCalls += 1;
			},
		};
		await runUpdateCommand(
			{ force: false, check: true },
			{
				getLatestRelease: async () => release,
				resolveUpdateTarget: async () => ({ method: "binary", path: "/tmp/gjc" }),
				...lifecycle,
			},
		);
		await runUpdateCommand(
			{ force: false, check: false },
			{
				getLatestRelease: async () => ({ ...release, version: "0.0.1" }),
				resolveUpdateTarget: async () => ({ method: "binary", path: "/tmp/gjc" }),
				...lifecycle,
			},
		);
		await runUpdateCommand(
			{ force: false, check: false },
			{
				getLatestRelease: async () => release,
				resolveUpdateTarget: async () => ({ method: "bun" }),
				performUpdate: async () => {
					throw new Error("rollback verified");
				},
				...lifecycle,
				exit: () => undefined as never,
			},
		);
		await runUpdateCommand(
			{ force: false, check: false },
			{
				getLatestRelease: async () => release,
				resolveUpdateTarget: async () => ({ method: "bun" }),
				performUpdate: async () => {},
				...lifecycle,
			},
		);
		expect(settingsCalls).toBe(0);
	});

	it("runs the verified runtime for an unconfigured install but performs no lifecycle operations", async () => {
		const calls: string[] = [];
		await runUpdateCommand(
			{ force: false, check: false },
			{
				getLatestRelease: async () => release,
				resolveUpdateTarget: async () => ({ method: "bun" }),
				performUpdate: async () => ({ ok: true, path: "/verified/gjc" }),
				runPostUpdateRecovery: async runtimePath => {
					expect(runtimePath).toBe("/verified/gjc");
					await runManagedNotifyRecovery({
						settings: async () => Settings.isolated(),
						stopDaemon: async () => {
							calls.push("stop");
						},
						restartDaemon: async () => {
							calls.push("restart");
						},
						recoverNotifications: async () => {
							calls.push("recovery");
						},
					});
				},
			},
		);
		expect(calls).toEqual([]);
	});
});

describe("update-cli install lock", () => {
	it("locks the same file the POSIX installer uses", async () => {
		const source = await Bun.file(path.resolve(import.meta.dir, "../src/cli/update-cli.ts")).text();
		expect(source).toContain(".gjc-install.lock");
		expect(source).not.toContain("No checksum asset on");
		expect(source).not.toContain(".update-lock");
		expect(source).toContain(`Remove ${String.fromCharCode(36)}{lockFile} only after confirming`);
	});
});

describe("update-cli windows journal recovery", () => {
	it("promotes .next over the live target and does not strand the prior binary", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const backupPath = `${targetPath}.bak`;
		const nextPath = `${targetPath}.next`;
		const journalPath = `${targetPath}.update-journal`;
		await Bun.write(targetPath, "old");
		await Bun.write(nextPath, "new");
		await Bun.write(journalPath, JSON.stringify({ target: targetPath, backup: backupPath, next: nextPath }));
		await recoverWindowsUpdateJournal(journalPath);
		expect(await Bun.file(targetPath).text()).toBe("new");
		expect(await Bun.file(nextPath).exists()).toBe(false);
		expect(await Bun.file(journalPath).exists()).toBe(false);
		const leftovers = (await fs.readdir(dir)).filter(name => name.includes(".bak.recover."));
		expect(leftovers).toEqual([]);
	});
	it("promotes .next even when the journal backup path already exists", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const backupPath = `${targetPath}.bak`;
		const nextPath = `${targetPath}.next`;
		const journalPath = `${targetPath}.update-journal`;
		await Bun.write(targetPath, "old");
		await Bun.write(nextPath, "new");
		await Bun.write(backupPath, "stale-backup");
		await Bun.write(journalPath, JSON.stringify({ target: targetPath, backup: backupPath, next: nextPath }));
		await recoverWindowsUpdateJournal(journalPath);
		expect(await Bun.file(targetPath).text()).toBe("new");
		expect(await Bun.file(backupPath).text()).toBe("stale-backup");
		expect(await Bun.file(nextPath).exists()).toBe(false);
		expect(await Bun.file(journalPath).exists()).toBe(false);
		const leftovers = (await fs.readdir(dir)).filter(name => name.includes(".bak.recover."));
		expect(leftovers).toEqual([]);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous gjc binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
	it("installs a fresh binary when the migration target does not exist yet", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(tempPath, "new binary");

		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(result.ok).toBe(true);
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
	it("refuses to replace a destination symlink", async () => {
		const dir = await makeTempDir();
		const realPath = path.join(dir, "real");
		const targetPath = path.join(dir, "gjc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(realPath, "managed");
		await fs.symlink(realPath, targetPath);
		await Bun.write(tempPath, "new binary");
		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			}),
		).rejects.toThrow("Refusing to replace symlink");
		expect(fsNode.lstatSync(targetPath).isSymbolicLink()).toBe(true);
		expect(await Bun.file(realPath).text()).toBe("managed");
	});
	it("does not delete the live binary when backup copy fails", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");
		const originalCopy = fsNode.promises.copyFile;
		const copy = vi.spyOn(fsNode.promises, "copyFile").mockImplementation(async (src, dest, flags) => {
			if (String(src) === targetPath) {
				const err = new Error("EPERM: copy") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return originalCopy(src, dest, flags as number | undefined);
		});
		try {
			await expect(
				replaceBinaryForUpdate({
					targetPath,
					tempPath,
					backupPath,
					expectedVersion: "15.1.8",
					verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
				}),
			).rejects.toThrow("EPERM");
			expect(await Bun.file(targetPath).text()).toBe("old binary");
		} finally {
			copy.mockRestore();
		}
	});

	it("keeps a verified replacement when backup cleanup hits EPERM", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc.cmd");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");
		const originalUnlink = fsNode.promises.unlink;
		const unlinkSpy = vi.spyOn(fsNode.promises, "unlink").mockImplementation(async filePath => {
			if (String(filePath) === backupPath && fsNode.existsSync(backupPath)) {
				const err = new Error("EPERM: operation not permitted, unlink");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			}
			return await originalUnlink(filePath);
		});

		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});

			expect(result.ok).toBe(true);
			expect(result.cleanupWarning).toContain("Installed update, but could not remove backup file");
			expect(result.cleanupWarning).toContain(backupPath);
			expect(await Bun.file(targetPath).text()).toBe("new binary");
			expect(await Bun.file(tempPath).exists()).toBe(false);
			expect(await Bun.file(backupPath).text()).toBe("old binary");
		} finally {
			unlinkSpy.mockRestore();
		}
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "gjc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli download durability", () => {
	it("fsyncs a written file without altering its contents", async () => {
		const dir = await makeTempDir();
		const filePath = path.join(dir, "gjc.new");
		await Bun.write(filePath, "downloaded binary bytes");

		await fsyncFileForTest(filePath);

		expect(await Bun.file(filePath).text()).toBe("downloaded binary bytes");
	});

	it("rejects when the target file does not exist", async () => {
		const dir = await makeTempDir();
		await expect(fsyncFileForTest(path.join(dir, "missing.new"))).rejects.toThrow();
	});

	it("closes the fsync file descriptor on success", async () => {
		const close = vi.fn(async () => {});
		const open = vi.spyOn(fsNode.promises, "open").mockResolvedValue({
			sync: async () => {},
			close,
		} as unknown as Awaited<ReturnType<typeof fsNode.promises.open>>);
		try {
			await fsyncFileForTest("/irrelevant/path");
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			open.mockRestore();
		}
	});

	it("closes the fsync file descriptor even when sync fails", async () => {
		const close = vi.fn(async () => {});
		const open = vi.spyOn(fsNode.promises, "open").mockResolvedValue({
			sync: async () => {
				throw new Error("EIO: sync failed");
			},
			close,
		} as unknown as Awaited<ReturnType<typeof fsNode.promises.open>>);
		try {
			await expect(fsyncFileForTest("/irrelevant/path")).rejects.toThrow("sync failed");
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			open.mockRestore();
		}
	});
});

describe("update-cli binary update flow", () => {
	it("downloads, fsyncs, then replaces and verifies in that order", async () => {
		const calls: string[] = [];
		const targetPath = "/opt/gjc/bin/gjc";
		const flow: BinaryUpdateFlow = {
			download: async (url, tempPath) => {
				calls.push(`download ${url} -> ${tempPath}`);
			},
			fsync: async filePath => {
				calls.push(`fsync ${filePath}`);
			},
			replace: async options => {
				calls.push(`replace ${options.tempPath} -> ${options.targetPath}`);
				return options.verifyInstalledVersion(options.expectedVersion);
			},
			verifyInstalledVersion: async expected => {
				calls.push(`verify ${expected}`);
				return { ok: true, actual: expected, path: targetPath };
			},
			removeTemp: async filePath => {
				calls.push(`removeTemp ${filePath}`);
			},
			beforeReplace: () => {
				calls.push("beforeReplace");
			},
		};

		const result = await runBinaryUpdateFlow(targetPath, "https://example.test/gjc", "1.2.3", flow);

		expect(result.ok).toBe(true);
		expect(calls[0]).toMatch(new RegExp(`^download https://example.test/gjc -> ${targetPath}\\.new\\.`));
		expect(calls[1]).toMatch(new RegExp(`^fsync ${targetPath}\\.new\\.`));
		expect(calls[2]).toBe("beforeReplace");
		expect(calls[3]).toMatch(new RegExp(`^replace ${targetPath}\\.new\\..* -> ${targetPath}$`));
		expect(calls[4]).toBe("verify 1.2.3");
		expect(calls.some(call => call.startsWith("removeTemp "))).toBe(false);
	});

	it("aborts before replacement/verification when fsync fails", async () => {
		const calls: string[] = [];
		const targetPath = "/opt/gjc/bin/gjc";
		const flow: BinaryUpdateFlow = {
			download: async (_url, tempPath) => {
				calls.push(`download ${tempPath}`);
			},
			fsync: async () => {
				calls.push("fsync");
				throw new Error("EIO: fsync failed");
			},
			replace: async () => {
				calls.push("replace");
				return { ok: true };
			},
			verifyInstalledVersion: async () => {
				calls.push("verify");
				return { ok: true };
			},
			removeTemp: async filePath => {
				calls.push(`removeTemp ${filePath}`);
			},
		};

		await expect(runBinaryUpdateFlow(targetPath, "https://example.test/gjc", "1.2.3", flow)).rejects.toThrow(
			"fsync failed",
		);

		expect(calls[0]).toMatch(new RegExp(`^download ${targetPath}\\.new\\.`));
		expect(calls[1]).toBe("fsync");
		expect(calls[2]).toMatch(new RegExp(`^removeTemp ${targetPath}\\.new\\.`));
		expect(calls).not.toContain("replace");
		expect(calls).not.toContain("verify");
	});
});

describe("update-cli release channels", () => {
	it("maps channels to npm dist-tags without ever pointing nightly at latest", () => {
		expect(distTagForChannel("stable")).toBe("latest");
		expect(distTagForChannel("nightly")).toBe("nightly");
	});

	it("accepts only known channel names", () => {
		expect(isUpdateChannel("stable")).toBe(true);
		expect(isUpdateChannel("nightly")).toBe(true);
		expect(isUpdateChannel("beta")).toBe(false);
		expect(isUpdateChannel("")).toBe(false);
	});

	it("parses --channel from spaced and equals forms", () => {
		expect(parseUpdateArgs(["update", "--channel", "nightly"])).toEqual({
			force: false,
			check: false,
			channel: "nightly",
		});
		expect(parseUpdateArgs(["update", "--channel=stable", "--check"])).toEqual({
			force: false,
			check: true,
			channel: "stable",
		});
	});

	it("omits channel when the flag is absent and rejects unknown channels", () => {
		expect(parseUpdateArgs(["update", "--force"])).toEqual({ force: true, check: false });
		expect(parseUpdateArgs(["other"])).toBeUndefined();
		expect(() => parseUpdateArgs(["update", "--channel", "beta"])).toThrow('Invalid --channel "beta"');
		expect(() => parseUpdateArgs(["update", "--channel=nightlyy"])).toThrow("Invalid --channel");
	});

	it("orders nightly prereleases with real semver semantics", () => {
		// A prerelease is older than the stable release with the same core version.
		expect(compareVersionsForTest("0.12.12", "0.12.12-nightly.20260805044024.123.gabcdef123456")).toBeGreaterThan(0);
		// A nightly of a newer core beats the previous stable.
		expect(compareVersionsForTest("0.12.12-nightly.20260805044024.123.gabcdef123456", "0.12.11")).toBeGreaterThan(0);
		// Later nightly timestamps sort after earlier ones.
		expect(
			compareVersionsForTest(
				"0.12.12-nightly.20260806044024.123.gabcdef123456",
				"0.12.12-nightly.20260805044024.123.gabcdef123456",
			),
		).toBeGreaterThan(0);
		expect(compareVersionsForTest("0.12.11", "0.12.11")).toBe(0);
	});

	it("passes the requested channel to the release lookup and prints it for non-stable channels", async () => {
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		const seenChannels: string[] = [];
		try {
			await runUpdateCommand(
				{ force: false, check: true, channel: "nightly" },
				{
					getLatestRelease: async options => {
						seenChannels.push(options?.channel ?? "stable");
						return {
							tag: "v999.0.0-nightly.1.1.gabc",
							version: "999.0.0-nightly.1.1.gabc",
							registry: DEFAULT_NPM_REGISTRY,
							warnings: [],
						};
					},
					resolveUpdateTarget: async () => ({ method: "binary", path: "/tmp/gjc" }),
				},
			);
			expect(seenChannels).toEqual(["nightly"]);
			expect(output.join("\n")).toContain("Update channel: nightly (GitHub prerelease)");
			expect(output.join("\n")).toContain("New version available: 999.0.0-nightly.1.1.gabc");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("defaults to the stable channel and stays silent about it", async () => {
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		const seenChannels: string[] = [];
		try {
			await runUpdateCommand(
				{ force: false, check: false },
				{
					getLatestRelease: async options => {
						seenChannels.push(options?.channel ?? "stable");
						return { tag: "v0.0.1", version: "0.0.1", registry: DEFAULT_NPM_REGISTRY, warnings: [] };
					},
					resolveUpdateTarget: async () => ({ method: "binary", path: "/tmp/gjc" }),
				},
			);
			expect(seenChannels).toEqual(["stable"]);
			expect(output.join("\n")).toContain("Already up to date");
			expect(output.join("\n")).not.toContain("Update channel:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("treats a same-version nightly as up to date instead of NaN-forcing a reinstall", async () => {
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		try {
			// VERSION is the current stable core; a nightly of the same core must not
			// produce the misleading "Forcing reinstall" path without --force.
			await runUpdateCommand(
				{ force: false, check: false, channel: "nightly" },
				{
					getLatestRelease: async () => ({
						tag: "v0.0.0-nightly.1.1.gabc",
						version: "0.0.0-nightly.1.1.gabc",
						registry: DEFAULT_NPM_REGISTRY,
						warnings: [],
					}),
					resolveUpdateTarget: async () => ({ method: "binary", path: "/tmp/gjc" }),
				},
			);
			expect(output.join("\n")).toContain("Already up to date");
			expect(output.join("\n")).not.toContain("Forcing reinstall");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("prefers the compiled executable over PATH lookup", () => {
		expect(
			resolveGjcPathForTest({
				compiled: true,
				execPath: "/opt/gjc/gjc",
				whichPath: "/usr/bin/gjc",
			}),
		).toBe(path.resolve("/opt/gjc/gjc"));
		expect(
			resolveGjcPathForTest({
				compiled: false,
				execPath: "/opt/gjc/gjc",
				whichPath: "/usr/bin/gjc",
			}),
		).toBe("/usr/bin/gjc");
	});
	it("resolves compiled execPath through a symlink", async () => {
		const dir = await makeTempDir();
		const realFile = path.join(dir, "gjc-real");
		const link = path.join(dir, "gjc-link");
		await Bun.write(realFile, "binary");
		await fs.symlink(realFile, link);
		expect(
			resolveGjcPathForTest({
				compiled: true,
				execPath: link,
				whichPath: "/usr/bin/gjc",
			}),
		).toBe(await fs.realpath(link));
	});

	it("fails closed when the install target cannot be resolved", async () => {
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => {
			output.push(String(message));
		});
		try {
			await runUpdateCommand(
				{ force: false, check: false },
				{
					getLatestRelease: async () => ({
						tag: "v0.15.0",
						version: "0.15.0",
						registry: DEFAULT_NPM_REGISTRY,
						warnings: [],
					}),
					resolveUpdateTarget: async () => {
						throw new Error(
							"Current install at /home/alice/.local/bin/gjc is a package-manager shim in the default binary directory",
						);
					},
					exit: ((code?: number) => {
						throw new Error(`exit ${code ?? 0}`);
					}) as typeof process.exit,
				},
			);
			throw new Error("expected exit");
		} catch (err) {
			expect(String(err)).toContain("exit 1");
			expect(output.join("\n")).toContain("package-manager shim in the default binary directory");
			expect(output.join("\n")).not.toContain("Already up to date");
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});

describe("update-cli channel robustness", () => {
	it("rejects a trailing value-less --channel instead of silently ignoring it", () => {
		expect(() => parseUpdateArgs(["update", "--channel"])).toThrow("Missing value for --channel");
	});

	it("requests the GitHub prerelease list for nightly lookups", async () => {
		const requested: string[] = [];
		const release = await getLatestReleaseForTest({
			lookupEnv: () => undefined,
			channel: "nightly",
			fetchImpl: async url => {
				requested.push(String(url));
				return new Response(
					JSON.stringify([
						{ tag_name: "v1.2.3", draft: false, prerelease: false },
						{ tag_name: "v1.2.3-nightly.1.1.gabc", draft: false, prerelease: true },
					]),
					{ status: 200 },
				);
			},
		});

		expect(requested).toEqual(["https://api.github.com/repos/Yeachan-Heo/gajae-code/releases?per_page=40"]);
		expect(release.version).toBe("1.2.3-nightly.1.1.gabc");
	});

	it("fails closed with workflow guidance when no nightly has ever been published", async () => {
		const failing = getLatestReleaseForTest({
			lookupEnv: () => undefined,
			channel: "nightly",
			fetchImpl: async () => new Response("[]", { status: 200 }),
		});

		await expect(failing).rejects.toThrow("nightly channel has no published GitHub prerelease yet");
	});

	it("exits cleanly instead of crashing when the channel reports an unparseable version", async () => {
		const errors: string[] = [];
		const exitCodes: number[] = [];
		const sentinel = new Error("exit");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => {
			errors.push(String(message));
		});
		try {
			await expect(
				runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => ({
							tag: "vnot-a-semver",
							version: "not-a-semver",
							registry: DEFAULT_NPM_REGISTRY,
							warnings: [],
						}),
						resolveUpdateTarget: async () => ({ method: "binary", path: "/tmp/gjc" }),
						exit: code => {
							exitCodes.push(code);
							throw sentinel;
						},
					},
				),
			).rejects.toBe(sentinel);
			expect(exitCodes).toEqual([1]);
			expect(errors.join("\n")).toContain('unparseable version "not-a-semver"');
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("resolves update decisions across the channel matrix", () => {
		// Nightly build switching back to stable installs the semver-lower target.
		expect(
			resolveUpdateDecision({
				comparison: -1,
				force: false,
				channel: "stable",
				currentVersion: "0.12.12-nightly.20260805044024.123.gabcdef123456",
			}),
		).toEqual({ install: true, kind: "switch-back" });
		// The reverse direction never downgrades silently: a same-core nightly
		// behind the installed stable still requires --force.
		expect(
			resolveUpdateDecision({ comparison: -1, force: false, channel: "nightly", currentVersion: "0.12.12" }),
		).toEqual({ install: false, kind: "up-to-date" });
		expect(
			resolveUpdateDecision({ comparison: -1, force: true, channel: "nightly", currentVersion: "0.12.12" }),
		).toEqual({ install: true, kind: "force" });
		// A stable build on the stable channel never treats an older release as a switch-back.
		expect(
			resolveUpdateDecision({ comparison: -1, force: false, channel: "stable", currentVersion: "0.12.12" }),
		).toEqual({ install: false, kind: "up-to-date" });
		// Ordinary newer-version and equal-version behavior is unchanged.
		expect(
			resolveUpdateDecision({ comparison: 1, force: false, channel: "stable", currentVersion: "0.12.11" }),
		).toEqual({ install: true, kind: "new-version" });
		expect(
			resolveUpdateDecision({ comparison: 0, force: false, channel: "stable", currentVersion: "0.12.11" }),
		).toEqual({ install: false, kind: "up-to-date" });
		expect(
			resolveUpdateDecision({
				comparison: 0,
				force: false,
				channel: "stable",
				currentVersion: "0.12.11",
				migrate: true,
			}),
		).toEqual({ install: true, kind: "migrate" });
		expect(
			resolveUpdateDecision({
				comparison: -1,
				force: false,
				channel: "stable",
				currentVersion: "0.12.11",
				migrate: true,
			}),
		).toEqual({ install: false, kind: "up-to-date" });
	});
});

describe("update-cli reported version parsing", () => {
	it("parses stable and nightly prerelease version output", () => {
		expect(parseReportedVersionForTest("gjc/0.12.11")).toBe("0.12.11");
		expect(parseReportedVersionForTest("gjc/0.12.12-nightly.20260805044024.123456789.g6dd873fd26b8\n")).toBe(
			"0.12.12-nightly.20260805044024.123456789.g6dd873fd26b8",
		);
		expect(parseReportedVersionForTest("gjc: no version")).toBeUndefined();
	});
});
describe("update-cli binary-first target policy", () => {
	it("installs standalone binaries under the user install dir, not Bun's global bin", () => {
		expect(defaultUserBinaryPathForTest("linux", { GJC_INSTALL_DIR: "/tmp/gjc-bin", HOME: "/home/alice" })).toBe(
			"/tmp/gjc-bin/gjc",
		);
		expect(
			defaultUserBinaryPathForTest("win32", { GJC_INSTALL_DIR: "D:\\tools", USERPROFILE: "C:\\Users\\alice" }),
		).toBe("D:\\tools\\gjc.exe");
		expect(defaultUserBinaryPathForTest("linux", { HOME: "/home/alice" })).toBe("/home/alice/.local/bin/gjc");
	});

	it("protects this repository checkout from self-overwrite", () => {
		expect(isProtectedSourcePathForTest(path.join(repoRoot, "packages/coding-agent/src/cli.ts"))).toBe(true);
		expect(isProtectedSourcePathForTest("/tmp/unrelated/gjc")).toBe(false);
	});

	it("keeps bun-global path detection as a shim classifier, not an install method", () => {
		expect(resolveUpdateMethodForTest("/Users/test/.bun/bin/gjc", "/Users/test/.bun/bin")).toBe("bun");
		expect(resolveUpdateMethodForTest("/Users/test/.local/bin/gjc", "/Users/test/.bun/bin")).toBe("binary");
	});
});
