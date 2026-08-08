import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BinaryUpdateFlow } from "../src/cli/update-cli";
import {
	buildReleaseBinaryUrlForTest,
	compareVersionsForTest,
	formatBinaryDownloadFailureMessageForTest,
	formatManualUpdateInstructionsForTest,
	formatVerificationFailureForTest,
	fsyncFileForTest,
	getLatestReleaseForTest,
	parseReportedVersionForTest,
	parseUpdateArgs,
	replaceBinaryForUpdate,
	resolveNpmManagedTargetForTest,
	resolveUpdateDecision,
	resolveUpdateMethodForTest,
	runBinaryUpdateFlow,
	runPackageManagerUpdateForTest,
	runUpdateCommand,
} from "../src/cli/update-cli";
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

describe("update-cli release lookup", () => {
	const isolated = {
		homeDir: "/nonexistent-home",
		platform: "darwin" as const,
		readFile: async () => undefined,
	};

	it("asks the registry configured through npm config instead of the public one", async () => {
		const requested: string[] = [];

		const release = await getLatestReleaseForTest({
			...isolated,
			lookupEnv: name =>
				name === "npm_config_registry" ? "https://nexus.example.com/repository/npm-all/" : undefined,
			fetchImpl: async url => {
				requested.push(url);
				return { ok: true, status: 200, statusText: "OK", json: async () => ({ version: "9.9.9" }) };
			},
		});

		expect(requested).toEqual(["https://nexus.example.com/repository/npm-all/@gajae-code/coding-agent/latest"]);
		expect(release).toEqual({
			tag: "v9.9.9",
			version: "9.9.9",
			registry: "https://nexus.example.com/repository/npm-all",
			warnings: [],
		});
	});

	it("surfaces the failing url and status so blocked registries are diagnosable", async () => {
		const failing = getLatestReleaseForTest({
			...isolated,
			lookupEnv: () => undefined,
			fetchImpl: async () => ({
				ok: false,
				status: 503,
				statusText: "",
				json: async () => ({}),
			}),
		});

		await expect(failing).rejects.toThrow("https://registry.npmjs.org/@gajae-code/coding-agent/latest responded 503");
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

	it("reports actionable Unix manual update commands for unsupported fallback paths", () => {
		const instructions = formatManualUpdateInstructionsForTest("linux");

		expect(instructions).toContain("bun install -g @gajae-code/coding-agent@latest");
		expect(instructions).toContain("npm, pnpm, or another package manager");
		expect(instructions).toContain(
			"curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh | sh -s -- --binary",
		);
	});

	it("reports actionable Windows manual update commands for unsupported fallback paths", () => {
		const instructions = formatManualUpdateInstructionsForTest("win32");

		expect(instructions).toContain("bun install -g @gajae-code/coding-agent@latest");
		expect(instructions).toContain("npm, pnpm, or another package manager");
		expect(instructions).toContain(
			"irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1 | iex",
		);
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

	it("includes actionable guidance when a release asset download fails", () => {
		const message = formatBinaryDownloadFailureMessageForTest(
			"gjc-linux-x64",
			"https://github.com/Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-linux-x64",
			"Not Found",
			"linux",
		);

		expect(message).toContain("Download failed for gjc-linux-x64");
		expect(message).toContain("Yeachan-Heo/gajae-code/releases/download/v0.2.3/gjc-linux-x64");
		expect(message).toContain("bun install -g @gajae-code/coding-agent@latest");
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
		expect(message).toContain("bun install -g @gajae-code/coding-agent@latest");
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
			"bun install -g @gajae-code/coding-agent@latest",
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
		expect(calls).toEqual([
			`download https://example.test/gjc -> ${targetPath}.new`,
			`fsync ${targetPath}.new`,
			"beforeReplace",
			`replace ${targetPath}.new -> ${targetPath}`,
			"verify 1.2.3",
		]);
		expect(calls).not.toContain(`removeTemp ${targetPath}.new`);
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

		expect(calls).toEqual([`download ${targetPath}.new`, "fsync", `removeTemp ${targetPath}.new`]);
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
				},
			);
			expect(seenChannels).toEqual(["nightly"]);
			expect(output.join("\n")).toContain("Update channel: nightly (npm dist-tag nightly)");
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
				},
			);
			expect(output.join("\n")).toContain("Already up to date");
			expect(output.join("\n")).not.toContain("Forcing reinstall");
		} finally {
			logSpy.mockRestore();
		}
	});
});

describe("update-cli channel robustness", () => {
	it("rejects a trailing value-less --channel instead of silently ignoring it", () => {
		expect(() => parseUpdateArgs(["update", "--channel"])).toThrow("Missing value for --channel");
	});

	it("requests the nightly dist-tag route for nightly lookups", async () => {
		const requested: string[] = [];
		const release = await getLatestReleaseForTest({
			homeDir: "/nonexistent-home",
			platform: "darwin",
			readFile: async () => undefined,
			lookupEnv: () => undefined,
			channel: "nightly",
			fetchImpl: async url => {
				requested.push(url);
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ version: "1.2.3-nightly.1.1.gabc" }),
				};
			},
		});

		expect(requested).toEqual(["https://registry.npmjs.org/@gajae-code/coding-agent/nightly"]);
		expect(release.version).toBe("1.2.3-nightly.1.1.gabc");
	});

	it("falls back to the packument dist-tags entry for the requested channel", async () => {
		const requested: string[] = [];
		const release = await getLatestReleaseForTest({
			homeDir: "/nonexistent-home",
			platform: "darwin",
			readFile: async () => undefined,
			lookupEnv: () => undefined,
			channel: "nightly",
			fetchImpl: async url => {
				requested.push(url);
				if (url.endsWith("/nightly")) {
					return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
				}
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						"dist-tags": { latest: "1.2.3", nightly: "1.2.4-nightly.1.1.gabc" },
					}),
				};
			},
		});

		expect(requested).toEqual([
			"https://registry.npmjs.org/@gajae-code/coding-agent/nightly",
			"https://registry.npmjs.org/@gajae-code/coding-agent",
		]);
		expect(release.version).toBe("1.2.4-nightly.1.1.gabc");
	});

	it("fails closed with workflow guidance when no nightly has ever been published", async () => {
		const failing = getLatestReleaseForTest({
			homeDir: "/nonexistent-home",
			platform: "darwin",
			readFile: async () => undefined,
			lookupEnv: () => undefined,
			channel: "nightly",
			fetchImpl: async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) }),
		});

		await expect(failing).rejects.toThrow("nightly channel has no published release yet");
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
