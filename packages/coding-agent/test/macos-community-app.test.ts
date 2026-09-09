import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Interface } from "node:readline/promises";
import type { Process as NativeProcess } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import {
	abortActiveCommunityAppCommandsForTest,
	COMMUNITY_APP_BUNDLE_ID,
	COMMUNITY_APP_SIGNING_AUTHORITY,
	COMMUNITY_APP_SUPPRESS_ENV,
	COMMUNITY_APP_TEAM_ID,
	communityAppAssetMatchesArchitectureForTest,
	hasExpectedCommunityAppSignatureForTest,
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
	test("discloses third-party terms before the default-no prompt", async () => {
		const events: string[] = [];
		const question = spyOn(Interface.prototype, "question").mockImplementation(async query => {
			events.push(query);
			return "";
		});
		try {
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				env: {},
				stdinIsTTY: true,
				stdoutIsTTY: true,
				command: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
				log: message => events.push(message),
				fetchImpl: async () => {
					throw new Error("declining must not fetch");
				},
			});
			expect(result).toEqual({ status: "skipped", reason: "cancelled" });
			expect(events).toHaveLength(2);
			for (const term of [
				"experimental",
				"community-built",
				"THIRD-PARTY",
				"separately licensed",
				"no first-party support",
				"https://github.com/devswha/gajae-code-app",
			])
				expect(events[0]).toContain(term);
			expect(events[1]).toContain("[y/N]");
		} finally {
			question.mockRestore();
		}
	});

	test("skips automation and non-TTY offers without disclosure or discovery", async () => {
		for (const guard of [
			{ stdinIsTTY: false },
			{ stdoutIsTTY: false },
			...["CI", "GITHUB_ACTIONS", "GJC_NONINTERACTIVE", "NONINTERACTIVE", COMMUNITY_APP_SUPPRESS_ENV].map(key => ({
				env: { [key]: "true" },
			})),
			{ env: { npm_lifecycle_event: "postinstall" } },
			{ env: { npm_command: "install" } },
		]) {
			const logs: string[] = [];
			let discovered = false;
			let prompted = false;
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				env: {},
				stdinIsTTY: true,
				stdoutIsTTY: true,
				...guard,
				log: message => logs.push(message),
				command: async () => {
					discovered = true;
					return { exitCode: 1, stdout: "", stderr: "" };
				},
				prompt: async () => {
					prompted = true;
					return false;
				},
			});
			expect(result.status).toBe("skipped");
			expect(logs).toEqual([]);
			expect(discovered).toBe(false);
			expect(prompted).toBe(false);
		}
	});

	test("false automation flags do not suppress consent", async () => {
		for (const value of ["false", " FALSE ", "0", "no", "off", "", "   "]) {
			const logs: string[] = [];
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				env: { NONINTERACTIVE: value, npm_lifecycle_event: value, npm_command: value },
				stdinIsTTY: true,
				stdoutIsTTY: true,
				command: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
				log: message => logs.push(message),
				prompt: async () => {
					expect(logs).toHaveLength(1);
					return false;
				},
			});
			expect(result.reason).toBe("cancelled");
		}
	});

	test("bounds and sanitizes failure logs without mutating failure data", async () => {
		const reason = `bad /tmp/app\r\nforged\t\x1b[31mred\x1b[0m\x00\u2028\u202e${"x".repeat(4096)}`;
		for (const failDiscovery of [true, false]) {
			const logs: string[] = [];
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				env: {},
				stdinIsTTY: true,
				stdoutIsTTY: true,
				command: async () => {
					if (failDiscovery) throw new Error(reason);
					return { exitCode: 1, stdout: "", stderr: "" };
				},
				prompt: async () => {
					throw new Error(reason);
				},
				log: message => logs.push(message),
			});
			expect(result).toEqual({ status: "failed", reason });
			expect(logs).toHaveLength(failDiscovery ? 1 : 2);
			const failureLog = logs.at(-1)!;
			expect(failureLog.length).toBe(1024);
			expect(failureLog).toContain("bad /tmp/app forged red");
			expect(failureLog).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u202e]/u);
			expect(failureLog.endsWith("...")).toBe(true);
		}
	});

	test("latches the first signal when later signals differ", async () => {
		const originalExitCode = process.exitCode;
		try {
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				env: {},
				stdinIsTTY: true,
				stdoutIsTTY: true,
				command: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
				prompt: async () => {
					// Invoke only this offer's handlers, not the test runner's signal handlers.
					process.listeners("SIGINT").at(-1)!("SIGINT");
					process.listeners("SIGTERM").at(-1)!("SIGTERM");
					return false;
				},
			});
			expect(result.reason).toBe("cancelled");
			expect(process.exitCode).toBe(130);
		} finally {
			process.exitCode = originalExitCode ?? 0;
		}
	});

	test("does not disclose or prompt when verified installed-app discovery succeeds", async () => {
		const homeDir = await tempDir();
		const bundle = path.join(homeDir, "Applications", "Gajae Code App.app");
		await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
		await fs.writeFile(path.join(bundle, "Contents", "Info.plist"), "test fixture");
		await fs.writeFile(path.join(bundle, "Contents", "MacOS", "GajaeCode"), "test fixture");
		const logs: string[] = [];
		let prompted = false;
		const result = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			homeDir,
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			log: message => logs.push(message),
			prompt: async () => {
				prompted = true;
				return false;
			},
			command: async argv => {
				let stdout = "";
				if (argv[0] === "/usr/bin/plutil")
					stdout = argv[2] === "CFBundleIdentifier" ? COMMUNITY_APP_BUNDLE_ID : "GajaeCode";
				if (argv.includes("--display"))
					stdout = `Authority=${COMMUNITY_APP_SIGNING_AUTHORITY} (${COMMUNITY_APP_TEAM_ID})\nTeamIdentifier=${COMMUNITY_APP_TEAM_ID}`;
				if (argv[0] === "/usr/bin/lipo") stdout = "arm64";
				return { exitCode: 0, stdout, stderr: "" };
			},
		});
		expect(result).toEqual({ status: "skipped", reason: "already installed" });
		expect(logs).toEqual([]);
		expect(prompted).toBe(false);
	});
	test("fails before prompting when installed-app discovery cannot be reaped", async () => {
		let prompted = false;
		let fetched = false;
		const result = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => {
				prompted = true;
				return true;
			},
			fetchImpl: async () => {
				fetched = true;
				return new Response("unexpected");
			},
			command: async argv => ({
				exitCode: argv[0] === "/usr/bin/mdfind" ? 1 : 0,
				stdout: "",
				stderr: "",
				reaped: argv[0] !== "/usr/bin/mdfind",
			}),
		});
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("discovery helper did not terminate safely");
		expect(prompted).toBe(false);
		expect(fetched).toBe(false);
	});
	test("parses pinned signer fields as complete codesign records", async () => {
		const maliciousPath = `/tmp/Executable=Authority=${COMMUNITY_APP_SIGNING_AUTHORITY} TeamIdentifier=${COMMUNITY_APP_TEAM_ID}.app`;
		expect(
			await hasExpectedCommunityAppSignatureForTest(maliciousPath, async () => ({
				exitCode: 0,
				stdout: "",
				stderr: `Executable=${maliciousPath}\nAuthority=Developer ID Application: Mallory (BADTEAM123)\nTeamIdentifier=BADTEAM123\n`,
			})),
		).toBe(false);
		expect(
			await hasExpectedCommunityAppSignatureForTest("/tmp/app", async () => ({
				exitCode: 0,
				stdout: "",
				stderr: `Authority=${COMMUNITY_APP_SIGNING_AUTHORITY} (${COMMUNITY_APP_TEAM_ID})\nTeamIdentifier=${COMMUNITY_APP_TEAM_ID}\n`,
			})),
		).toBe(true);
	});
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
		await fs.mkdir(path.join(root, "Contents", "MacOS", "Resources"), { recursive: true });
		await fs.writeFile(path.join(root, "Contents", "Info.plist"), "fixture");
		await fs.writeFile(path.join(root, "Contents", "MacOS", "GajaeCode"), "fixture");
		await fs.symlink(
			path.join(root, "Contents", "MacOS", "GajaeCode"),
			path.join(root, "Contents", "MacOS", "Resources", "AbsoluteLink"),
		);
		expect(await resolveCommunityAppExecutableForTest(root, "GajaeCode")).toBeUndefined();
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
		const started = performance.now();
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
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	test("reaps same-group descendants after the helper leader exits", async () => {
		if (process.platform === "win32") return;
		const dir = await tempDir();
		const markerPath = path.join(dir, "descendant.json");
		const helperPath = path.join(dir, "leader.ts");
		const capturedPath = path.join(dir, "captured");
		await fs.writeFile(
			helperPath,
			`const markerPath = Bun.argv.at(-1);
if (!markerPath) throw new Error("missing marker path");
const descendant = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); await Promise.withResolvers().promise"], {
	stdout: "ignore",
	stderr: "ignore",
});
await Bun.write(markerPath, JSON.stringify({ descendantPid: descendant.pid }));
const deadline = Date.now() + 8000;
while (!(await Bun.file(${JSON.stringify(capturedPath)}).exists())) {
	if (Date.now() > deadline) { descendant.kill("SIGKILL"); await descendant.exited; throw new Error("descendant was never captured"); }
	await Bun.sleep(10);
}
process.exit(0);
`,
		);
		const result = await runCommunityAppCommandForTest([process.execPath, helperPath, markerPath], () => {
			void Bun.write(capturedPath, "captured");
		});
		const { descendantPid } = JSON.parse(await fs.readFile(markerPath, "utf8")) as { descendantPid: number };
		expect(result.exitCode).toBe(0);
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
		expect(logs.at(-1)).toContain("Optional community app offer unavailable:");
		expect(logs.at(-1)).toContain("devswha/gajae-code-app");

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
				if (url.includes("/releases?")) {
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

		let cancelled = false;
		const neverEndingDmg = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const malformedChecksum = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			fetchImpl: async url => {
				if (url.includes("/releases?"))
					return Response.json({
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
					});
				return url.endsWith(".dmg") ? new Response(neverEndingDmg) : new Response("malformed\n");
			},
		});
		expect(malformedChecksum.reason).toContain("does not name the DMG");
		expect(cancelled).toBe(true);

		let rejectedFetchAborted = false;
		let rejectedStreamCancelled = false;
		const rejectedChecksum = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			fetchImpl: async (url, init) => {
				if (url.includes("/releases?"))
					return Response.json({
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
					});
				if (url.endsWith(".sha256")) throw new Error("checksum fetch failed");
				init?.signal?.addEventListener("abort", () => {
					rejectedFetchAborted = true;
				});
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1]));
						},
						cancel() {
							rejectedStreamCancelled = true;
						},
					}),
				);
			},
		});
		expect(rejectedChecksum.reason).toContain("checksum fetch failed");
		expect(rejectedFetchAborted).toBe(true);
		expect(rejectedStreamCancelled).toBe(true);
	});
});

describe("macOS community app verified installation", () => {
	test("installs a published prerelease after checksum, identity, signature, and architecture verification", async () => {
		const homeDir = await tempDir();
		const dmg = new Uint8Array([1, 2, 3, 4]);
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const checksumUrl = `${dmgUrl}.sha256`;
		const calls: string[][] = [];
		let signingTeam = COMMUNITY_APP_TEAM_ID;
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
			if (argv[0] === "/usr/bin/codesign" && argv.includes("--display"))
				return {
					exitCode: 0,
					stdout: "",
					stderr: `Authority=${COMMUNITY_APP_SIGNING_AUTHORITY} (${signingTeam})\nTeamIdentifier=${signingTeam}\n`,
				};
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
				if (url.includes("/releases?")) {
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							prerelease: true,
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
		await fs.mkdir(path.join(homeDir, "Applications", "Gajae Code App.app", "Contents"), { recursive: true });
		const repaired = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			homeDir,
			env: {},
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			command,
			cleanupCommand: command,
			log: message => calls.push(["log", message]),
			fetchImpl: async url => {
				if (url.includes("/releases?"))
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							assets: [
								{ name: dmgName, browser_download_url: dmgUrl },
								{ name: `${dmgName}.sha256`, browser_download_url: checksumUrl },
							],
						}),
					);
				if (url === dmgUrl) return new Response(dmg);
				return new Response(`${createHash("sha256").update(dmg).digest("hex")}  ${dmgName}\n`);
			},
		});
		expect(repaired.status).toBe("installed");
		expect(
			await fs.stat(path.join(homeDir, "Applications", "Gajae Code App.app", "Contents", "MacOS", "GajaeCode")),
		).toBeTruthy();
		await fs.rm(path.join(homeDir, "Applications", "Gajae Code App.app"), { recursive: true, force: true });
		signingTeam = "WRONGTEAM1";
		const wrongSigner = await offerMacosCommunityApp({
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
				if (url.includes("/releases?"))
					return new Response(
						JSON.stringify({
							tag_name: "v1.0.0",
							assets: [
								{ name: dmgName, browser_download_url: dmgUrl },
								{ name: `${dmgName}.sha256`, browser_download_url: checksumUrl },
							],
						}),
					);
				if (url === dmgUrl) return new Response(dmg);
				return new Response(`${createHash("sha256").update(dmg).digest("hex")}  ${dmgName}\n`);
			},
		});
		expect(wrongSigner.status).toBe("failed");
		expect(wrongSigner.reason).toContain("unexpected publisher");
		signingTeam = COMMUNITY_APP_TEAM_ID;
		failCopy = true;
		const callsBeforeFailedCopy = calls.length;
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
				if (url.includes("/releases?")) {
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
		expect(failedCopy.reason).toContain("copying the verified app bundle failed");
		expect(calls.slice(callsBeforeFailedCopy).filter(call => call[0] === "/usr/bin/ditto")).toHaveLength(1);
		expect(await fs.readdir(path.join(homeDir, "Applications"))).toEqual([]);
		await expect(fs.stat(path.join(homeDir, "Applications", "Gajae Code App.app"))).rejects.toThrow();
	}, 20_000);
});

describe("macOS community app attach cleanup", () => {
	test("aborts an in-flight DMG stream and removes its temporary root", async () => {
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const dmg = new Uint8Array([11, 12, 13]);
		const stagingRoot = await tempDir();
		const abortController = new AbortController();
		const calls: string[][] = [];
		const offer = offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			tempDir: stagingRoot,
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			signal: abortController.signal,
			command: async argv => {
				calls.push(argv);
				return { exitCode: argv[0] === "/usr/bin/mdfind" ? 1 : 0, stdout: "", stderr: "" };
			},
			fetchImpl: async (url, init) => {
				if (url.includes("/releases?"))
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
			if ((await fs.readdir(stagingRoot)).length > 0) break;
			await Bun.sleep(25);
		}
		abortController.abort();
		expect((await offer).status).toBe("failed");
		expect(calls.some(call => call[0] === "/usr/bin/hdiutil" && call[1] === "detach")).toBe(false);
		expect(await fs.readdir(stagingRoot)).toEqual([]);
	});

	test("removes temporary state when attach returns failure or throws before mounting", async () => {
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const dmg = new Uint8Array([5, 6, 7]);
		const stagingRoot = await tempDir();
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
				tempDir: stagingRoot,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				prompt: async () => true,
				command,
				cleanupCommand: command,
				fetchImpl: async url => {
					if (url.includes("/releases?"))
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
		expect(await fs.readdir(stagingRoot)).toEqual([]);
	});

	test("refuses pathname detach when an attached mount identity changes", async () => {
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const dmg = new Uint8Array([8, 9, 10]);
		const calls: string[][] = [];
		const logs: string[] = [];
		let mountPoint: string | undefined;
		let mountIdentityChanged = false;
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
				// Discovery may inspect a real installed app before attach. Only mutate our mounted fixture.
				if (!mountPoint || argv.at(-1) !== path.join(mountPoint, "Gajae Code App.app", "Contents", "Info.plist"))
					return { exitCode: 1, stdout: "", stderr: "not the mounted fixture" };
				const replacement = `${mountPoint}-changed`;
				await fs.mkdir(replacement);
				await fs.rm(mountPoint, { recursive: true, force: true });
				await fs.rename(replacement, mountPoint);
				mountIdentityChanged = true;
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
				if (url.includes("/releases?"))
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
		expect(mountIdentityChanged).toBe(true);
		expect(calls.some(call => call[0] === "/usr/bin/hdiutil" && call[1] === "detach")).toBe(false);
		expect(logs).toContain("Optional community app cleanup warning: mountpoint identity changed; refusing detach");
		if (!mountPoint) throw new Error("mountpoint was not captured");
		const tempRoot = path.dirname(mountPoint);
		expect(await fs.stat(tempRoot)).toBeTruthy();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("captures an attached mount before honoring an interruption", async () => {
		const dmgName = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const dmgUrl = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${dmgName}`;
		const dmg = new Uint8Array([14, 15, 16]);
		const abortController = new AbortController();
		const stagingRoot = await tempDir();
		const calls: string[][] = [];
		let detachTimeout = 0;
		const command = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "/usr/bin/mdfind") return { exitCode: 1, stdout: "", stderr: "" };
			if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "attach") {
				const mount = argv[argv.indexOf("-mountpoint") + 1];
				const replacement = `${mount}-attached`;
				await fs.mkdir(replacement);
				await fs.rm(mount, { recursive: true, force: true });
				await fs.rename(replacement, mount);
				abortController.abort();
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "detach") return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		const result = await offerMacosCommunityApp({
			platform: "darwin",
			arch: "arm64",
			env: {},
			tempDir: stagingRoot,
			stdinIsTTY: true,
			stdoutIsTTY: true,
			prompt: async () => true,
			signal: abortController.signal,
			command,
			cleanupCommand: async (argv, timeoutMs) => {
				detachTimeout = timeoutMs;
				return command(argv);
			},
			fetchImpl: async url => {
				if (url.includes("/releases?"))
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
		expect(calls.some(call => call[0] === "/usr/bin/hdiutil" && call[1] === "detach")).toBe(true);
		expect(detachTimeout).toBe(1_000);
		expect(await fs.readdir(stagingRoot)).toEqual([]);
	});
});
async function createBundleFixture(bundle: string): Promise<void> {
	await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
	await fs.writeFile(path.join(bundle, "Contents", "Info.plist"), "fixture");
	await fs.writeFile(path.join(bundle, "Contents", "MacOS", "GajaeCode"), "new app");
}

function verifiedFixtureResult(argv: string[]) {
	return {
		exitCode: 0,
		stdout:
			argv[0] === "/usr/bin/plutil"
				? argv.includes("CFBundleExecutable")
					? "GajaeCode"
					: COMMUNITY_APP_BUNDLE_ID
				: argv[0] === "/usr/bin/lipo"
					? "arm64"
					: "",
		stderr: argv.includes("--display")
			? `Authority=${COMMUNITY_APP_SIGNING_AUTHORITY} (${COMMUNITY_APP_TEAM_ID})\nTeamIdentifier=${COMMUNITY_APP_TEAM_ID}\n`
			: "",
		reaped: true,
	};
}

for (const discovery of ["direct", "spotlight"] as const) {
	for (const verifier of [
		"CFBundleIdentifier",
		"CFBundleExecutable",
		"--verify",
		"--display",
		"/usr/sbin/spctl",
		"/usr/bin/lipo",
	]) {
		test(`aborts ${discovery} discovery at unreaped ${verifier}`, async () => {
			const homeDir = await tempDir();
			const bundle = path.join(homeDir, discovery === "direct" ? "Applications" : "Elsewhere", "Gajae Code App.app");
			await createBundleFixture(bundle);
			let reached = false;
			let prompted = false;
			let fetched = false;
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				homeDir,
				env: {},
				stdinIsTTY: true,
				stdoutIsTTY: true,
				prompt: async () => {
					prompted = true;
					return true;
				},
				fetchImpl: async () => {
					fetched = true;
					throw new Error("unexpected network");
				},
				command: async argv => {
					if (argv[0] === "/usr/bin/mdfind") return { exitCode: 0, stdout: bundle, stderr: "", reaped: true };
					if (!argv.some(arg => arg.startsWith(bundle)))
						return { exitCode: 1, stdout: "", stderr: "", reaped: true };
					if (reached) throw new Error("discovery continued after unsafe helper");
					const result = verifiedFixtureResult(argv);
					if (argv.includes(verifier)) {
						reached = true;
						result.reaped = false;
					}
					return result;
				},
			});
			expect(reached).toBe(true);
			expect(result.reason).toContain("discovery helper did not terminate safely");
			expect(result.status).toBe("failed");
			expect(prompted).toBe(false);
			expect(fetched).toBe(false);
		});
	}
}

for (const fault of [
	"backup-validation",
	"backup-delete",
	"quarantine-delete",
	"launch",
	"launch-abort",
	"none",
] as const) {
	test(`replacement ownership survives ${fault}`, async () => {
		const homeDir = await tempDir();
		const destination = path.join(homeDir, "Applications", "Gajae Code App.app");
		await fs.mkdir(destination, { recursive: true });
		await fs.writeFile(path.join(destination, "old-marker"), "old app");
		const originalLstat = fs.lstat;
		const originalRm = fs.rm;
		const originalRmdir = fs.rmdir;
		let injected = false;
		let retainedPath = "";
		let launched = false;
		let attached = false;
		const abortController = new AbortController();
		const lstatSpy = spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
			if (fault === "backup-validation" && !injected && String(args[0]).endsWith(".previous")) {
				injected = true;
				throw new Error("postrename identity unavailable");
			}
			return originalLstat(...args);
		}) as typeof fs.lstat);
		const rmSpy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
			if (
				fault === "backup-delete" &&
				String(target).endsWith(".previous") &&
				String(target).includes(".gjc-community-app-cleanup-")
			) {
				injected = true;
				retainedPath = String(target);
				throw new Error("backup tombstone removal denied");
			}
			return originalRm(target, options);
		});
		const rmdirSpy = spyOn(fs, "rmdir").mockImplementation(async target => {
			if (fault === "quarantine-delete" && String(target).includes(".gjc-community-app-cleanup-")) {
				injected = true;
				retainedPath = String(target);
				throw new Error("quarantine removal denied");
			}
			return originalRmdir(target);
		});
		const dmg = fault === "none" ? new Uint8Array(2 * 1024 * 1024).fill(7) : new Uint8Array([1, 3, 5]);
		const chunkCount = fault === "none" ? 32 : 1;
		const hash = createHash("sha256");
		for (let index = 0; index < chunkCount; index++) hash.update(dmg);
		const checksum = hash.digest("hex");
		let streamedChunks = 0;
		let detachTimeout = 0;
		const name = "gajae-app-desktop-1.0.0-macos-arm64.dmg";
		const url = `https://github.com/devswha/gajae-code-app/releases/download/v1.0.0/${name}`;
		try {
			const command = async (argv: string[]) => {
				if (argv[0] === "/usr/bin/mdfind") return { exitCode: 1, stdout: "", stderr: "" };
				if (argv[0] === "/usr/bin/plutil" && !attached)
					return { exitCode: 1, stdout: "", stderr: "not the fixture" };
				if (argv[0] === "/usr/bin/hdiutil" && argv[1] === "attach") {
					expect((await fs.stat(argv.at(-1)!)).size).toBe(dmg.byteLength * chunkCount);
					const mount = argv[argv.indexOf("-mountpoint") + 1];
					const replacement = `${mount}-attached`;
					await createBundleFixture(path.join(replacement, "Gajae Code App.app"));
					await fs.rmdir(mount);
					await fs.rename(replacement, mount);
					attached = true;
				}
				if (argv[0] === "/usr/bin/ditto") await fs.cp(argv[1], argv[2], { recursive: true });
				if (argv[0] === "/usr/bin/open") {
					launched = true;
					if (fault === "launch") return { exitCode: 1, stdout: "", stderr: "launch failed" };
					if (fault === "launch-abort") abortController.abort();
				}
				return verifiedFixtureResult(argv);
			};
			const result = await offerMacosCommunityApp({
				platform: "darwin",
				arch: "arm64",
				homeDir,
				env: {},
				stdinIsTTY: true,
				stdoutIsTTY: true,
				prompt: async () => true,
				command,
				signal: abortController.signal,
				cleanupCommand: async (argv, timeoutMs) => {
					detachTimeout = timeoutMs;
					return command(argv);
				},
				fetchImpl: async target =>
					target.includes("/releases?")
						? Response.json({
								tag_name: "v1.0.0",
								assets: [
									{ name, browser_download_url: url },
									{ name: `${name}.sha256`, browser_download_url: `${url}.sha256` },
								],
							})
						: target === url
							? new Response(
									new ReadableStream<Uint8Array>({
										pull(controller) {
											if (streamedChunks++ < chunkCount) controller.enqueue(dmg);
											else controller.close();
										},
									}),
								)
							: new Response(`${checksum}  ${name}\n`),
			});
			expect(attached).toBe(true);
			expect(streamedChunks).toBe(chunkCount + 1);
			expect(detachTimeout).toBe(fault === "launch-abort" ? 1_000 : 15_000);
			if (fault === "backup-validation" || fault === "launch") {
				expect(result.status).toBe("failed");
				expect(launched).toBe(fault === "launch");
				expect(await fs.readFile(path.join(destination, "old-marker"), "utf8")).toBe("old app");
				expect(await fs.readdir(path.dirname(destination))).toEqual(["Gajae Code App.app"]);
			} else {
				expect(result.status).toBe("installed");
				expect(launched).toBe(true);
				expect(await fs.readFile(path.join(destination, "Contents", "MacOS", "GajaeCode"), "utf8")).toBe("new app");
				if (fault === "backup-delete" || fault === "quarantine-delete") {
					expect(result.reason).toContain(retainedPath);
					expect(await fs.stat(retainedPath)).toBeTruthy();
					if (fault === "backup-delete")
						expect(await fs.readFile(path.join(retainedPath, "old-marker"), "utf8")).toBe("old app");
				}
			}
			if (fault === "backup-validation" || fault === "backup-delete" || fault === "quarantine-delete")
				expect(injected).toBe(true);
		} finally {
			lstatSpy.mockRestore();
			rmSpy.mockRestore();
			rmdirSpy.mockRestore();
		}
	});
}

// Host-only regression: mocks cannot model hdiutil's persistent disk-image helper.
// Run explicitly with GJC_TEST_REAL_HDIUTIL=1 bun test packages/coding-agent/test/macos-community-app.test.ts.
(process.platform === "darwin" && process.env.GJC_TEST_REAL_HDIUTIL === "1" ? test : test.skip)(
	"keeps a real DMG mounted until owned detach, including canonical mount aliases",
	async () => {
		// Deliberately not registered with tempDirs: unknown mount state must never be recursively removed.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-community-app-real-mount-"));
		const payload = path.join(root, "payload");
		const mount = path.join(root, "mount");
		const image = path.join(root, "fixture.dmg");
		await fs.mkdir(payload);
		await fs.mkdir(mount);
		await fs.writeFile(path.join(payload, "probe.txt"), "owned persistent mount");
		const before = await fs.stat(mount, { bigint: true });
		const canonicalMount = await fs.realpath(mount);
		let attempted = false;
		let detached = false;
		const helpers: NativeProcess[] = [];
		try {
			const created = await runCommunityAppCommandForTest([
				"/usr/bin/hdiutil",
				"create",
				"-srcfolder",
				payload,
				"-volname",
				"GJC-Owned-Fixture",
				"-format",
				"UDZO",
				image,
			]);
			expect(created.exitCode).toBe(0);
			expect(created.reaped).toBe(true);
			attempted = true;
			const attached = await runCommunityAppCommandForTest(
				["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, image],
				pid => {
					const helper = nativeProcessBindings().Process.fromPid(pid);
					if (helper) helpers.push(helper);
				},
			);
			expect(attached.exitCode).toBe(0);
			expect(attached.reaped).toBe(true);
			expect(attached.helpersRetained).toBe(true);
			const after = await fs.stat(mount, { bigint: true });
			expect(after.dev !== before.dev || after.ino !== before.ino).toBe(true);
			// Exercise another strict command and cancellation between attach and detach.
			// Neither is allowed to release this mount's support helpers.
			const probe = await runCommunityAppCommandForTest([process.execPath, "-e", "await Bun.sleep(50)"]);
			expect(probe.reaped).toBe(true);
			abortActiveCommunityAppCommandsForTest();
			await Bun.sleep(300);
			expect(await fs.readFile(path.join(canonicalMount, "probe.txt"), "utf8")).toBe("owned persistent mount");
			const duplicate = await runCommunityAppCommandForTest([
				"/usr/bin/hdiutil",
				"attach",
				"-readonly",
				"-nobrowse",
				"-mountpoint",
				canonicalMount,
				image,
			]);
			expect(duplicate.exitCode).toBe(125);
			expect(await fs.readFile(path.join(mount, "probe.txt"), "utf8")).toBe("owned persistent mount");
		} finally {
			if (attempted) {
				const result = await runCommunityAppCommandForTest([
					"/usr/bin/hdiutil",
					"detach",
					canonicalMount,
					"-force",
				]);
				detached = result.exitCode === 0 && result.reaped === true;
			}
			if (!attempted || detached) await fs.rm(root, { recursive: true, force: true });
			else process.stderr.write(`Real mount fixture retained for safety: ${root}\n`);
		}
		expect(detached).toBe(true);
		for (const helper of helpers) expect(await helper.waitForExit({ timeoutMs: 750 })).toBe(true);
	},
	120_000,
);
