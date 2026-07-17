import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BinaryUpdateFlow } from "../src/cli/update-cli";
import {
	buildReleaseBinaryUrlForTest,
	formatBinaryDownloadFailureMessageForTest,
	formatManualUpdateInstructionsForTest,
	formatVerificationFailureForTest,
	fsyncFileForTest,
	replaceBinaryForUpdate,
	resolveNpmManagedTargetForTest,
	resolveUpdateMethodForTest,
	runBinaryUpdateFlow,
	runPackageManagerUpdateForTest,
	runUpdateCommand,
} from "../src/cli/update-cli";
import { initTheme } from "../src/modes/theme/theme";

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
						getLatestRelease: async () => ({ tag: "v999.0.0", version: "999.0.0" }),
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
						getLatestRelease: async () => ({ tag: "v999.0.0", version: "999.0.0" }),
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
