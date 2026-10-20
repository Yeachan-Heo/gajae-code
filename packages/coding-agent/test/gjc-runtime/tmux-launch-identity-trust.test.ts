import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Args } from "@gajae-code/coding-agent/cli/args";
import {
	buildDefaultTmuxLaunchPlan,
	launchDefaultTmuxIfNeeded,
	type TmuxLaunchContext,
} from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import {
	__setBinaryResolverForTests,
	__setExecutableIdentityResolverForTests,
	clearPsmuxDetectionCache,
} from "@gajae-code/coding-agent/gjc-runtime/psmux-detect";
import { lifecyclePaths } from "@gajae-code/coding-agent/gjc-runtime/tmux-owner-isolation";
import {
	__setTmuxProviderAuthorityPlatformForTests,
	bindGjcTmuxProviderAuthority,
	persistGjcTmuxProviderAuthoritySync,
	resolveGjcTmuxProviderContext,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-provider-context";
import {
	__setCreateOwnerIsolationForTests,
	createGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";
import { prepareManagedDirectoryRoot } from "../../src/session/internal/managed-session-storage";

const PLANTED_SESSION = "victim-tmux-493";
const PLANTED_COORDINATOR = "victim-coordinator-493";
const PLANTED_GJC_SESSION = "victim-session-493";
const OPERATOR_SESSION = "operator-tmux-493";
const OPERATOR_COORDINATOR = "operator-coordinator-493";
const OPERATOR_GJC_SESSION = "operator-session-493";

function args(): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		tmux: true,
	};
}

function ownerProbe(): NonNullable<TmuxLaunchContext["ownerIsolationProbe"]> {
	let serverCreated = false;
	return {
		readCallerCgroup: () => null,
		probeServer: () => {
			if (!serverCreated) {
				serverCreated = true;
				return { state: "absent" };
			}
			return {
				state: "safe",
				pid: 123,
				startTime: "42",
				cgroup: { classification: "not_applicable" },
			};
		},
		recordAttempt: () => {},
	};
}

function newSessionArgs(calls: string[][]): string[] {
	const found = calls.find(call => call[0] === "new-session");
	if (!found) throw new Error("expected new-session");
	return found;
}

function childSessionAssignment(inner: string): string | undefined {
	return inner.match(/GJC_SESSION_ID='([^']*)'/)?.[1];
}

function launchPins(cwd: string, env: NodeJS.ProcessEnv): { sessionName: string; inner: string } {
	const calls: string[][] = [];
	const handled = launchDefaultTmuxIfNeeded({
		parsed: args(),
		rawArgs: ["--tmux"],
		cwd,
		env: {
			GJC_PSMUX_DETECTION: "off",
			GJC_TMUX_COMMAND: "tmux",
			...env,
		},
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: process.execPath,
		platform: "darwin",
		tty: { stdin: true, stdout: true, columns: 80, rows: 24 },
		tmuxAvailable: true,
		existingBranchSessionName: null,
		currentBranch: "main",
		ownerIsolationProbe: ownerProbe(),
		spawnSync: (_command, spawnArgs) => {
			calls.push([...spawnArgs]);
			return { exitCode: 0, stdout: "$0" };
		},
	});
	expect(handled).toBe(true);
	const sessionArgs = newSessionArgs(calls);
	const nameIndex = sessionArgs.indexOf("-s");
	return { sessionName: sessionArgs[nameIndex + 1] ?? "", inner: sessionArgs.at(-1) ?? "" };
}

async function withRepo(
	body: string | undefined,
	run: (cwd: string, victimState: string) => Promise<void> | void,
): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), "tmux-identity-"));
	const cwd = path.join(root, "repo");
	const victimState = path.join(root, "victim", "coordinator-state.json");
	await mkdir(cwd, { recursive: true });
	if (body !== undefined) await writeFile(path.join(cwd, ".env"), body);
	try {
		await run(cwd, victimState);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("tmux launch identity provenance", () => {
	afterEach(() => {
		__setCreateOwnerIsolationForTests(null);
		__setTmuxProviderAuthorityPlatformForTests(null);
		__setBinaryResolverForTests(null);
		__setExecutableIdentityResolverForTests(null);
		clearPsmuxDetectionCache();
	});

	it("does not adopt project dotenv session, root, or state-file pins", async () => {
		await withRepo(undefined, async (cwd, victimState) => {
			await writeFile(
				path.join(cwd, ".env"),
				[
					`GJC_TMUX_SESSION=${PLANTED_SESSION}`,
					`GJC_COORDINATOR_SESSION_ID=${PLANTED_COORDINATOR}`,
					`GJC_SESSION_ID=${PLANTED_GJC_SESSION}`,
					`GJC_COORDINATOR_SESSION_STATE_FILE=${victimState}`,
					"",
				].join("\n"),
			);
			const launched = launchPins(cwd, {
				GJC_TMUX_SESSION: PLANTED_SESSION,
				GJC_COORDINATOR_SESSION_ID: PLANTED_COORDINATOR,
				GJC_SESSION_ID: PLANTED_GJC_SESSION,
				GJC_COORDINATOR_SESSION_STATE_FILE: victimState,
			});
			expect(launched.sessionName).not.toBe(PLANTED_SESSION);
			expect(launched.inner).not.toContain(victimState);
			expect(launched.inner).not.toContain(PLANTED_GJC_SESSION);
			expect(launched.inner).not.toContain(PLANTED_COORDINATOR);
			expect(launched.inner).not.toContain(path.join(path.dirname(victimState), "tmux-exit.json"));
			expect(childSessionAssignment(launched.inner)).toBe(launched.sessionName);
		});
	});

	it("masks a project dotenv session id the parent environment does not carry", async () => {
		await withRepo(`GJC_SESSION_ID=${PLANTED_GJC_SESSION}\n`, async cwd => {
			const launched = launchPins(cwd, {});
			expect(launched.inner).not.toContain(PLANTED_GJC_SESSION);
			expect(childSessionAssignment(launched.inner)).toBe(launched.sessionName);
		});
	});

	it("leaves the child session id unset when the operator and the project omit it", async () => {
		await withRepo(undefined, async cwd => {
			const launched = launchPins(cwd, {});
			expect(launched.inner).not.toContain("GJC_SESSION_ID=");
		});
	});

	it("still uses operator tmux identity pins the project does not declare", async () => {
		await withRepo(undefined, async cwd => {
			const stateFile = path.join(cwd, "operator-state.json");
			const launched = launchPins(cwd, {
				GJC_TMUX_SESSION: OPERATOR_SESSION,
				GJC_COORDINATOR_SESSION_ID: OPERATOR_COORDINATOR,
				GJC_SESSION_ID: OPERATOR_GJC_SESSION,
				GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
			});
			expect(launched.sessionName).toBe(OPERATOR_SESSION);
			expect(launched.inner).toContain(OPERATOR_COORDINATOR);
			expect(launched.inner).toContain(stateFile);
			expect(launched.inner).toContain(path.join(cwd, "tmux-exit.json"));
		});
	});

	it("still uses an operator GJC session id the project does not declare for the session root", async () => {
		await withRepo(undefined, async cwd => {
			const launched = launchPins(cwd, { GJC_SESSION_ID: OPERATOR_GJC_SESSION });
			expect(launched.inner).toContain(`_session-${OPERATOR_GJC_SESSION}`);
			expect(launched.inner).not.toContain(PLANTED_GJC_SESSION);
		});
	});

	it("passes a trusted operator session id into the launched child", async () => {
		await withRepo(undefined, async cwd => {
			const launched = launchPins(cwd, { GJC_SESSION_ID: OPERATOR_GJC_SESSION });
			expect(childSessionAssignment(launched.inner)).toBe(OPERATOR_GJC_SESSION);
			expect(launched.inner).not.toContain(PLANTED_GJC_SESSION);
		});
	});

	it("still uses an operator pin that differs from the project dotenv value", async () => {
		await withRepo(
			[
				`GJC_TMUX_SESSION=${PLANTED_SESSION}`,
				`GJC_COORDINATOR_SESSION_ID=${PLANTED_COORDINATOR}`,
				`GJC_SESSION_ID=${PLANTED_GJC_SESSION}`,
				"GJC_COORDINATOR_SESSION_STATE_FILE=/planted/state.json",
			].join("\n"),
			async cwd => {
				const stateFile = path.join(cwd, "operator-state.json");
				const launched = launchPins(cwd, {
					GJC_TMUX_SESSION: OPERATOR_SESSION,
					GJC_COORDINATOR_SESSION_ID: OPERATOR_COORDINATOR,
					GJC_SESSION_ID: OPERATOR_GJC_SESSION,
					GJC_COORDINATOR_SESSION_STATE_FILE: stateFile,
				});
				expect(launched.sessionName).toBe(OPERATOR_SESSION);
				expect(launched.inner).toContain(stateFile);
				expect(launched.inner).not.toContain(PLANTED_SESSION);
				expect(launched.inner).not.toContain("/planted/state.json");
			},
		);
	});

	it("still uses an operator pin that differs from the static declaration only by surrounding spaces", async () => {
		await withRepo(
			[
				`GJC_TMUX_SESSION=${OPERATOR_SESSION}`,
				`GJC_COORDINATOR_SESSION_ID=${OPERATOR_COORDINATOR}`,
				`GJC_SESSION_ID=${OPERATOR_GJC_SESSION}`,
				"GJC_COORDINATOR_SESSION_STATE_FILE=/declared/state.json",
			].join("\n"),
			async cwd => {
				const stateFile = path.join(cwd, "operator-state.json");
				const launched = launchPins(cwd, {
					GJC_TMUX_SESSION: ` ${OPERATOR_SESSION} `,
					GJC_COORDINATOR_SESSION_ID: ` ${OPERATOR_COORDINATOR} `,
					GJC_SESSION_ID: ` ${OPERATOR_GJC_SESSION} `,
					GJC_COORDINATOR_SESSION_STATE_FILE: ` ${stateFile} `,
				});
				expect(launched.sessionName).toBe(OPERATOR_SESSION);
				expect(launched.inner).toContain(OPERATOR_COORDINATOR);
				expect(launched.inner).toContain(stateFile);
				expect(launched.inner).not.toContain("/declared/state.json");
			},
		);
	});

	it("still uses a padded operator coordinator id to attach the existing provider session", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "tmux-identity-attach-"));
		const cwd = path.join(root, "repo");
		const stateDir = path.join(root, "state");
		await mkdir(cwd, { recursive: true });
		await writeFile(
			path.join(cwd, ".env"),
			[`GJC_TMUX_SESSION=${OPERATOR_SESSION}`, `GJC_COORDINATOR_SESSION_ID=${OPERATOR_COORDINATOR}`, ""].join("\n"),
		);
		const generation = "generation-a";
		clearPsmuxDetectionCache();
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/usr/bin/psmux" : null));
		__setExecutableIdentityResolverForTests(() => "volume:42");
		__setTmuxProviderAuthorityPlatformForTests("win32");
		const authority = bindGjcTmuxProviderAuthority(
			resolveGjcTmuxProviderContext({
				platform: "win32",
				env: { GJC_TMUX_COMMAND: "psmux" },
				runner: () => ({ exitCode: 0, stdout: "psmux 3.3.0\n", stderr: "" }),
			}),
			{ stateDir, sessionId: OPERATOR_COORDINATOR, generation },
		);
		persistGjcTmuxProviderAuthoritySync(authority);
		const paths = lifecyclePaths(stateDir, authority.sessionId, authority.generation);
		prepareManagedDirectoryRoot(paths.root);
		await writeFile(
			paths.generationFile,
			`${JSON.stringify({
				schema_version: 1,
				session_id: authority.sessionId,
				generation: authority.generation,
				published_at: "2026-07-28T00:00:00.000Z",
			})}\n`,
		);
		const listed: string[][] = [];
		const spy = spyOn(Bun, "spawnSync").mockImplementation(((command: unknown) => {
			const argv = Array.isArray(command)
				? command.map(String)
				: Array.isArray((command as { cmd?: unknown } | null)?.cmd)
					? (command as { cmd: unknown[] }).cmd.map(String)
					: [];
			listed.push(argv);
			if (argv.includes("list-sessions")) {
				return {
					exitCode: 0,
					stdout: Buffer.from(`${OPERATOR_SESSION}\t1\t0\t1770000000\t1\troot\t1\t1\t\t\t\t\t\t\t\t\t$9`),
					stderr: Buffer.from(""),
				};
			}
			return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
		}) as never);
		const previous = process.cwd();
		const launchCalls: string[][] = [];
		try {
			process.chdir(cwd);
			const env = {
				GJC_PSMUX_DETECTION: "off",
				GJC_TMUX_COMMAND: "ambient-tmux",
				GJC_TMUX_SESSION: ` ${OPERATOR_SESSION} `,
				GJC_COORDINATOR_SESSION_ID: ` ${OPERATOR_COORDINATOR} `,
				GJC_TMUX_OWNER_STATE_DIR: stateDir,
				GJC_TMUX_OWNER_GENERATION: generation,
			};
			const plan = buildDefaultTmuxLaunchPlan({
				parsed: args(),
				rawArgs: ["--tmux"],
				cwd,
				env,
				argv: ["bun", "packages/coding-agent/src/cli.ts"],
				execPath: process.execPath,
				platform: "darwin",
				tty: { stdin: true, stdout: true, columns: 80, rows: 24 },
				tmuxAvailable: true,
				currentBranch: "main",
				ownerIsolationProbe: ownerProbe(),
			});
			expect(plan?.attachSessionName).toBe(OPERATOR_SESSION);
			expect(listed.some(call => call[0] === authority.command && call.includes("list-sessions"))).toBe(true);
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args(),
				rawArgs: ["--tmux"],
				cwd,
				env,
				argv: ["bun", "packages/coding-agent/src/cli.ts"],
				execPath: process.execPath,
				platform: "darwin",
				tty: { stdin: true, stdout: true, columns: 80, rows: 24 },
				tmuxAvailable: true,
				currentBranch: "main",
				ownerIsolationProbe: ownerProbe(),
				spawnSync: (_command, spawnArgs) => {
					launchCalls.push([...spawnArgs]);
					return { exitCode: 0, stdout: "" };
				},
			});
			expect(handled).toBe(true);
			const attach = launchCalls.find(call => call[0] === "attach-session");
			expect(attach?.some(arg => arg.includes(OPERATOR_SESSION))).toBe(true);
		} finally {
			spy.mockRestore();
			process.chdir(previous);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("session create ignores a project dotenv session and state-file pin", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "tmux-create-identity-"));
		const cwd = path.join(root, "repo");
		const victimState = path.join(root, "victim", "coordinator-state.json");
		await mkdir(cwd, { recursive: true });
		await writeFile(
			path.join(cwd, ".env"),
			[
				`GJC_TMUX_SESSION=${PLANTED_SESSION}`,
				`GJC_COORDINATOR_SESSION_ID=${PLANTED_COORDINATOR}`,
				`GJC_SESSION_ID=${PLANTED_GJC_SESSION}`,
				`GJC_COORDINATOR_SESSION_STATE_FILE=${victimState}`,
				"",
			].join("\n"),
		);
		const previous = process.cwd();
		let planned: string[] | undefined;
		__setCreateOwnerIsolationForTests({
			execute: plan => {
				if (!plan.ok) throw new Error(`plan failed: ${plan.diagnostic}`);
				planned = plan.execution.argv;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "test-stop" };
			},
		});
		try {
			process.chdir(cwd);
			expect(() =>
				createGjcTmuxSession(
					{
						GJC_PSMUX_DETECTION: "off",
						GJC_TMUX_COMMAND: "tmux",
						GJC_TMUX_SESSION: PLANTED_SESSION,
						GJC_COORDINATOR_SESSION_ID: PLANTED_COORDINATOR,
						GJC_SESSION_ID: PLANTED_GJC_SESSION,
						GJC_COORDINATOR_SESSION_STATE_FILE: victimState,
					},
					{ platform: "darwin" },
				),
			).toThrow("test-stop");
		} finally {
			process.chdir(previous);
			__setCreateOwnerIsolationForTests(null);
			await rm(root, { recursive: true, force: true });
		}
		expect(planned).toBeDefined();
		const nameIndex = planned?.indexOf("-s") ?? -1;
		const sessionName = planned?.[nameIndex + 1];
		expect(sessionName).not.toBe(PLANTED_SESSION);
		expect(planned?.at(-1) ?? "").not.toContain(victimState);
		expect(planned?.at(-1) ?? "").not.toContain(PLANTED_GJC_SESSION);
		expect(childSessionAssignment(planned?.at(-1) ?? "")).toBe(sessionName);
	});

	it("session create still passes an operator session id the project does not declare", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "tmux-create-operator-"));
		const cwd = path.join(root, "repo");
		await mkdir(cwd, { recursive: true });
		const previous = process.cwd();
		let planned: string[] | undefined;
		__setCreateOwnerIsolationForTests({
			execute: plan => {
				if (!plan.ok) throw new Error(`plan failed: ${plan.diagnostic}`);
				planned = plan.execution.argv;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "test-stop" };
			},
		});
		try {
			process.chdir(cwd);
			expect(() =>
				createGjcTmuxSession(
					{
						GJC_PSMUX_DETECTION: "off",
						GJC_TMUX_COMMAND: "tmux",
						GJC_SESSION_ID: OPERATOR_GJC_SESSION,
					},
					{ platform: "darwin" },
				),
			).toThrow("test-stop");
		} finally {
			process.chdir(previous);
			__setCreateOwnerIsolationForTests(null);
			await rm(root, { recursive: true, force: true });
		}
		expect(planned?.at(-1) ?? "").toContain(`_session-${OPERATOR_GJC_SESSION}`);
	});
});

describe("resolved child session id", () => {
	it("property: filtered child id agrees with the launch fallback, seed 493, 64 inputs", async () => {
		const mod = await import("@gajae-code/coding-agent/gjc-runtime/tmux-sessions");
		const resolved = mod.resolvedChildGjcSessionId;
		if (typeof resolved !== "function") throw new Error("resolvedChildGjcSessionId is required");
		let seed = 493;
		const next = (): number => {
			seed = (seed + 0x6d2b79f5) | 0;
			let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
			return (value ^ (value >>> 14)) >>> 0;
		};
		const alphabet = ["", " ", "operator-session-493", " victim-session-493 ", "generated-493"];
		for (let index = 0; index < 64; index += 1) {
			const trusted = alphabet[next() % alphabet.length];
			const inherited = alphabet[next() % alphabet.length];
			const fallback = alphabet[next() % alphabet.length] ?? "";
			const projectDeclared = next() % 2 === 0;
			const result = resolved({ trusted, inherited, projectDeclared, fallback });
			const trustedTrim = trusted?.trim() ?? "";
			if (trustedTrim) {
				expect(result).toBe(trustedTrim);
				continue;
			}
			if (!inherited?.trim() && !projectDeclared) {
				expect(result).toBeUndefined();
				continue;
			}
			expect(result).toBe(fallback.trim() || undefined);
		}
	});
});
