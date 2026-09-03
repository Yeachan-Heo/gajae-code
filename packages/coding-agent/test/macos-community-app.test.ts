import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	abortActiveCommunityAppCommandsForTest,
	COMMUNITY_APP_BUNDLE_ID,
	COMMUNITY_APP_SUPPRESS_ENV,
	communityAppAssetMatchesArchitectureForTest,
	offerMacosCommunityApp,
	parseCommunityAppChecksumForTest,
	resolveCommunityAppExecutableForTest,
	runCommunityAppCommandForTest,
} from "../src/cli/macos-community-app";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-community-app-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("macOS community app offer guards", () => {
	test("is disabled outside macOS, in automation, and when explicitly suppressed", async () => {
		expect((await offerMacosCommunityApp({ platform: "linux", stdinIsTTY: true, stdoutIsTTY: true })).status).toBe(
			"skipped",
		);
		expect((await offerMacosCommunityApp({ platform: "darwin", stdinIsTTY: false, stdoutIsTTY: false })).status).toBe(
			"skipped",
		);
		expect(
			(
				await offerMacosCommunityApp({
					platform: "darwin",
					stdinIsTTY: true,
					stdoutIsTTY: true,
					env: { CI: "true" },
					prompt: async () => {
						throw new Error("prompt must not run in CI");
					},
				})
			).status,
		).toBe("skipped");
		expect(
			(
				await offerMacosCommunityApp({
					platform: "darwin",
					stdinIsTTY: true,
					stdoutIsTTY: true,
					env: { CI: "false", GITHUB_ACTIONS: "0" },
					prompt: async () => false,
					command: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
				})
			).reason,
		).toBe("cancelled");
		expect(
			(
				await offerMacosCommunityApp({
					platform: "darwin",
					stdinIsTTY: true,
					stdoutIsTTY: true,
					env: { [COMMUNITY_APP_SUPPRESS_ENV]: "1" },
				})
			).status,
		).toBe("skipped");
	});

	test("keeps the default answer negative and parses only exact release checksums", async () => {
		const result = await offerMacosCommunityApp({
			platform: "darwin",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => false,
			command: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
		});
		expect(result).toEqual({ status: "skipped", reason: "cancelled" });
		expect(parseCommunityAppChecksumForTest(`${"a".repeat(64)}  App-macos-arm64.dmg\n`, "App-macos-arm64.dmg")).toBe(
			"a".repeat(64),
		);
		expect(
			parseCommunityAppChecksumForTest(`${"a".repeat(63)}  App-macos-arm64.dmg\n`, "App-macos-arm64.dmg"),
		).toBeUndefined();
	});

	test("accepts only matching macOS architecture assets", () => {
		expect(communityAppAssetMatchesArchitectureForTest("gajae-app-desktop-1.0.0-macos-arm64.dmg", "arm64")).toBe(
			true,
		);
		expect(communityAppAssetMatchesArchitectureForTest("gajae-app-desktop-1.0.0-macos-x64.dmg", "arm64")).toBe(false);
		expect(communityAppAssetMatchesArchitectureForTest("gajae-app-desktop-1.0.0-linux-arm64.dmg", "arm64")).toBe(
			false,
		);
		expect(communityAppAssetMatchesArchitectureForTest("../gajae-app-desktop-1.0.0-macos-arm64.dmg", "arm64")).toBe(
			false,
		);
	});

	test("rejects executable traversal and symlink escapes", async () => {
		const container = await tempDir();
		const root = path.join(container, "bundle");
		await fs.mkdir(root);
		const macOSRoot = path.join(root, "Contents", "MacOS");
		await fs.mkdir(macOSRoot, { recursive: true });
		await fs.writeFile(path.join(root, "Contents", "Info.plist"), "fixture");
		await fs.writeFile(path.join(macOSRoot, "GajaeCode"), "fixture");
		expect(await resolveCommunityAppExecutableForTest(root, "GajaeCode")).toBe(path.join(macOSRoot, "GajaeCode"));
		expect(await resolveCommunityAppExecutableForTest(root, "../../outside")).toBeUndefined();
		const nestedOutside = path.join(container, "nested-outside");
		await fs.mkdir(nestedOutside);
		await fs.mkdir(path.join(root, "Contents", "Resources"));
		await fs.symlink(nestedOutside, path.join(root, "Contents", "Resources", "Escape"));
		expect(await resolveCommunityAppExecutableForTest(root, "GajaeCode")).toBeUndefined();
		await fs.rm(path.join(root, "Contents", "Resources"), { recursive: true, force: true });
		await fs.symlink(path.join(macOSRoot, "GajaeCode"), path.join(macOSRoot, "Link"));
		expect(await resolveCommunityAppExecutableForTest(root, "Link")).toBeUndefined();
		await fs.rm(path.join(root, "Contents"), { recursive: true, force: true });
		const outside = path.join(path.dirname(root), "community-app-outside");
		await fs.mkdir(path.join(outside, "MacOS"), { recursive: true });
		await fs.writeFile(path.join(outside, "Info.plist"), "fixture");
		await fs.symlink(outside, path.join(root, "Contents"));
		expect(await resolveCommunityAppExecutableForTest(root, "GajaeCode")).toBeUndefined();
		await fs.rm(outside, { recursive: true, force: true });
		await fs.rm(path.join(root, "Contents"), { recursive: true, force: true });
		await fs.mkdir(path.join(root, "Contents", "MacOS"), { recursive: true });
		await fs.writeFile(path.join(root, "Contents", "Info.plist"), "fixture");
		await fs.writeFile(path.join(root, "Contents", "MacOS", "GajaeCode"), "fixture");
		const aliasParent = path.join(container, "community-app-alias-parent");
		const aliasRoot = path.join(aliasParent, path.basename(root));
		await fs.symlink(path.dirname(root), aliasParent);
		expect(await resolveCommunityAppExecutableForTest(aliasRoot, "GajaeCode")).toBe(
			path.join(aliasRoot, "Contents", "MacOS", "GajaeCode"),
		);
		await fs.rm(aliasParent, { recursive: true, force: true });
	});

	test("terminates a native helper when output exceeds the cap", async () => {
		const started = performance.now();
		const result = await runCommunityAppCommandForTest([
			process.execPath,
			"-e",
			'process.stdout.write("x".repeat(1024 * 1024 + 1)); setTimeout(() => {}, 60_000);',
		]);
		expect(result.exitCode).toBe(125);
		expect(performance.now() - started).toBeLessThan(10_000);
	});

	test("escalates cancellation when a native helper ignores SIGTERM", async () => {
		if (process.platform === "win32") return;
		const dir = await tempDir();
		const markerPath = path.join(dir, "helper.json");
		const helperPath = path.join(dir, "helper.ts");
		await fs.writeFile(
			helperPath,
			`const markerPath = Bun.argv.at(-1);
if (!markerPath) throw new Error("missing marker path");
await Bun.write(markerPath, JSON.stringify({ pid: process.pid }));
process.on("SIGTERM", () => {});
await Promise.withResolvers().promise;
`,
		);
		const command = runCommunityAppCommandForTest([process.execPath, helperPath, markerPath]);
		let helperPid: number | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			const marker = await fs.readFile(markerPath, "utf8").catch(() => undefined);
			if (marker) {
				helperPid = (JSON.parse(marker) as { pid: number }).pid;
				break;
			}
			await Bun.sleep(50);
		}
		if (!helperPid) throw new Error("helper did not start");
		abortActiveCommunityAppCommandsForTest();
		const result = await command;
		expect(result.reaped).toBe(true);
		expect(() => process.kill(helperPid, 0)).toThrow();
		expect(() => process.kill(-helperPid, 0)).toThrow();
	});

	test("reaps same-group descendants after the helper leader exits", async () => {
		if (process.platform === "win32") return;
		const dir = await tempDir();
		const markerPath = path.join(dir, "descendant.json");
		const helperPath = path.join(dir, "leader.ts");
		await fs.writeFile(
			helperPath,
			`const markerPath = Bun.argv.at(-1);
if (!markerPath) throw new Error("missing marker path");
const descendant = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); await Promise.withResolvers().promise"], {
	stdout: "ignore",
	stderr: "ignore",
});
await Bun.write(markerPath, JSON.stringify({ descendantPid: descendant.pid }));
await Bun.sleep(100);
process.exit(0);
`,
		);
		const result = await runCommunityAppCommandForTest([process.execPath, helperPath, markerPath]);
		const { descendantPid } = JSON.parse(await fs.readFile(markerPath, "utf8")) as { descendantPid: number };
		expect(result.reaped).toBe(true);
		expect(() => process.kill(descendantPid, 0)).toThrow();
	}, 12_000);

	test("fails closed when the canonical release or checksum is unavailable", async () => {
		const command = async () => ({ exitCode: 1, stdout: "", stderr: "" });
		const logs: string[] = [];
		const missing = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			log: message => logs.push(message),
			fetchImpl: async () => new Response("missing", { status: 404 }),
		});
		expect(missing.status).toBe("failed");
		expect(logs[0]).toContain("devswha/gajae-code-app");

		const badChecksum = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			fetchImpl: async url => {
				if (url.includes("/releases/latest")) {
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							assets: [
								{
									name: "gajae-app-desktop-1.0.0-macos-arm64.dmg",
									browser_download_url:
										"https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/gajae-app-desktop-1.0.0-macos-arm64.dmg",
								},
								{
									name: "gajae-app-desktop-1.0.0-macos-arm64.dmg.sha256",
									browser_download_url:
										"https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/gajae-app-desktop-1.0.0-macos-arm64.dmg.sha256",
								},
							],
						}),
					);
				}
				return new Response(
					url.endsWith(".dmg")
						? new Uint8Array([1])
						: `${"0".repeat(64)}  gajae-app-desktop-1.0.0-macos-arm64.dmg\n`,
				);
			},
		});
		expect(badChecksum.reason).toContain("checksum");
	});
});

describe("macOS community app verified installation", () => {
	test("verifies checksum, bundle identity, signature, architecture, cleanup, and launch", async () => {
		const homeDir = await tempDir();
		const dmg = new Uint8Array([1, 2, 3, 4]);
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const checksumUrl = `${dmgUrl}.sha256`;
		const calls: string[][] = [];
		let failCopy = false;
		const command = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "/usr/bin/plutil") {
				const bundle = argv.at(-1)?.replace(/\/Contents\/Info\.plist$/, "") ?? "";
				if (!(await fs.stat(bundle).catch(() => undefined))) return { exitCode: 1, stdout: "", stderr: "missing" };
				return {
					exitCode: 0,
					stdout: argv.includes("CFBundleExecutable") ? "GajaeCode\n" : `${COMMUNITY_APP_BUNDLE_ID}\n`,
					stderr: "",
				};
			}
			if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "attach") {
				const mount = argv[argv.indexOf("-mountpoint") + 1];
				await fs.mkdir(path.join(mount, "Gajae Code App.app", "Contents", "MacOS"), { recursive: true });
				await fs.writeFile(path.join(mount, "Gajae Code App.app", "Contents", "Info.plist"), "fixture");
				await fs.writeFile(path.join(mount, "Gajae Code App.app", "Contents", "MacOS", "GajaeCode"), "fixture");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (argv[0] === "/usr/bin/ditto") {
				if (failCopy) return { exitCode: 1, stdout: "", stderr: "copy failed" };
				await fs.cp(argv[1], argv[2], { recursive: true });
			}
			return { exitCode: 0, stdout: argv[0] === "/usr/bin/lipo" ? "arm64" : "", stderr: "" };
		};
		const result = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			homeDir,
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			fetchImpl: async url => {
				if (url.includes("/releases/latest")) {
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							assets: [
								{ name: dmgName, browser_download_url: dmgUrl },
								{ name: `${dmgName}.sha256`, browser_download_url: checksumUrl },
							],
						}),
					);
				}
				if (url === dmgUrl) return new Response(dmg);
				return new Response(`${createHash("sha256").update(dmg).digest("hex")}  ${dmgName}\n`);
			},
		});
		expect(result.status).toBe("installed");
		expect(calls.some(call => call[0] === "/usr/bin/codesign")).toBe(true);
		expect(calls.filter(call => call[0] === "/usr/sbin/spctl")).toHaveLength(2);
		expect(calls.some(call => call[0] === "/usr/bin/hdiutil" && call[1] === "detach")).toBe(true);
		expect(calls.some(call => call[0] === "/usr/bin/open")).toBe(true);
		expect(await fs.stat(path.join(homeDir, "Applications", "Gajae Code App.app"))).toBeTruthy();
		await fs.rm(path.join(homeDir, "Applications", "Gajae Code App.app"), { recursive: true, force: true });
		failCopy = true;
		const failedCopy = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			homeDir,
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			fetchImpl: async url => {
				if (url.includes("/releases/latest")) {
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							assets: [
								{ name: dmgName, browser_download_url: dmgUrl },
								{ name: `${dmgName}.sha256`, browser_download_url: checksumUrl },
							],
						}),
					);
				}
				if (url === dmgUrl) return new Response(dmg);
				return new Response(`${createHash("sha256").update(dmg).digest("hex")}  ${dmgName}\n`);
			},
		});
		expect(failedCopy.status).toBe("failed");
		expect(calls.some(call => call[0] === "/usr/bin/ditto" && failCopy)).toBe(true);
		await expect(fs.stat(path.join(homeDir, "Applications", "Gajae Code App.app"))).rejects.toThrow();
	});
});

describe("macOS community app attach cleanup", () => {
	test("aborts an in-flight DMG stream and removes its temporary root", async () => {
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const dmg = new Uint8Array([11, 12, 13]);
		const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("gjc-community-app-")));
		const abortController = new AbortController();
		const calls: string[][] = [];
		const offer = offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			signal: abortController.signal,
			command: async argv => {
				calls.push(argv);
				return { exitCode: argv[0] === "/usr/bin/mdfind" ? 1 : 0, stdout: "", stderr: "" };
			},
			fetchImpl: async (url, init) => {
				if (url.includes("/releases/latest"))
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							assets: [
								{ name: dmgName, browser_download_url: dmgUrl },
								{ name: `${dmgName}.sha256`, browser_download_url: `${dmgUrl}.sha256` },
							],
						}),
					);
				if (url === dmgUrl) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(dmg);
								init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
									once: true,
								});
							},
						}),
					);
				}
				return new Response(`${createHash("sha256").update(dmg).digest("hex")}  ${dmgName}\n`);
			},
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			const current = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("gjc-community-app-"));
			if (current.some(name => !before.has(name))) break;
			await Bun.sleep(25);
		}
		abortController.abort();
		expect((await offer).status).toBe("failed");
		expect(calls.some(call => call[0] === "/usr/bin/hdiutil" && call[1] === "detach")).toBe(false);
		const after = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("gjc-community-app-")));
		expect(after).toEqual(before);
	});

	test("removes temporary state when attach returns failure or throws before mounting", async () => {
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const dmg = new Uint8Array([5, 6, 7]);
		const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("gjc-community-app-")));
		for (const mode of ["return", "throw", "partial-return", "partial-throw"] as const) {
			const calls: string[][] = [];
			const command = async (argv: string[]) => {
				calls.push(argv);
				if (argv[0] === "/usr/bin/mdfind") return { exitCode: 1, stdout: "", stderr: "" };
				if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "attach") {
					if (mode.startsWith("partial")) {
						const mount = argv[argv.indexOf("-mountpoint") + 1];
						const replacement = `${mount}-replacement`;
						await fs.mkdir(replacement);
						await fs.rm(mount, { recursive: true, force: true });
						await fs.rename(replacement, mount);
					}
					if (mode === "throw" || mode === "partial-throw") throw new Error("attach failed");
					return { exitCode: 1, stdout: "", stderr: "attach failed" };
				}
				if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "detach") return { exitCode: 0, stdout: "", stderr: "" };
				return { exitCode: 1, stdout: "", stderr: "" };
			};
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				env: {},
				stdinIsTTY: true,
				stdoutIsTTY: true,
				prompt: async () => true,
				command,
				cleanupCommand: command,
				fetchImpl: async url => {
					if (url.includes("/releases/latest"))
						return new Response(
							JSON.stringify({
								tag_name: "v1.0.0",
								assets: [
									{ name: dmgName, browser_download_url: dmgUrl },
									{ name: `${dmgName}.sha256`, browser_download_url: `${dmgUrl}.sha256` },
								],
							}),
						);
					if (url === dmgUrl) return new Response(dmg);
					return new Response(`${createHash("sha256").update(dmg).digest("hex")}  ${dmgName}\n`);
				},
			});
			expect(result.status).toBe("failed");
			const detached = calls.some(call => call[0] === "/usr/bin/hdiutil" && call[1] === "detach");
			expect(detached).toBe(mode.startsWith("partial"));
		}
		const after = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("gjc-community-app-")));
		expect(after).toEqual(before);
	});

	test("refuses pathname detach when an attached mount identity changes", async () => {
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const dmg = new Uint8Array([8, 9, 10]);
		const calls: string[][] = [];
		const logs: string[] = [];
		let mountPoint: string | undefined;
		const command = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "/usr/bin/mdfind") return { exitCode: 1, stdout: "", stderr: "" };
			if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "attach") {
				mountPoint = argv[argv.indexOf("-mountpoint") + 1];
				const replacement = `${mountPoint}-attached`;
				await fs.mkdir(path.join(replacement, "Gajae Code App.app", "Contents", "MacOS"), { recursive: true });
				await fs.writeFile(path.join(replacement, "Gajae Code App.app", "Contents", "Info.plist"), "fixture");
				await fs.writeFile(
					path.join(replacement, "Gajae Code App.app", "Contents", "MacOS", "GajaeCode"),
					"fixture",
				);
				await fs.rm(mountPoint, { recursive: true, force: true });
				await fs.rename(replacement, mountPoint);
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (argv[0] === "/usr/bin/plutil") {
				if (!mountPoint) throw new Error("mountpoint was not captured");
				const replacement = `${mountPoint}-changed`;
				await fs.mkdir(replacement);
				await fs.rm(mountPoint, { recursive: true, force: true });
				await fs.rename(replacement, mountPoint);
				return { exitCode: 1, stdout: "", stderr: "changed" };
			}
			if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "detach") return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		const result = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			log: message => logs.push(message),
			fetchImpl: async url => {
				if (url.includes("/releases/latest"))
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							assets: [
								{ name: dmgName, browser_download_url: dmgUrl },
								{ name: `${dmgName}.sha256`, browser_download_url: `${dmgUrl}.sha256` },
							],
						}),
					);
				if (url === dmgUrl) return new Response(dmg);
				return new Response(`${createHash("sha256").update(dmg).digest("hex")}  ${dmgName}\n`);
			},
		});
		expect(result.status).toBe("failed");
		expect(calls.some(call => call[0] === "/usr/bin/hdiutil" && call[1] === "detach")).toBe(false);
		expect(logs).toContain("Optional community app cleanup warning: mountpoint identity changed; refusing detach");
		if (!mountPoint) throw new Error("mountpoint was not captured");
		const tempRoot = path.dirname(mountPoint);
		expect(await fs.stat(tempRoot)).toBeTruthy();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});
});
