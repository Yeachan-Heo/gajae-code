import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ManagedTmuxLaunchProof } from "../src/gjc-runtime/tmux-sessions";
import type { SpawnSubstrateLaunchSpec, SpawnSubstrateProof } from "../src/sdk/broker/spawn-authority";
import {
	createSpawnSubstrateProvider,
	type SpawnSubstrateProviderDependencies,
} from "../src/sdk/broker/spawn-substrate";

const temporaryDirectories: string[] = [];

const launchSpec = (cwd = "/repo"): SpawnSubstrateLaunchSpec => ({
	childSessionId: "child-session",
	cwd,
	argv: ["child-command", "--safe"],
	env: { CHILD_SETTING: "enabled" },
});

const managedProof = (overrides: Partial<ManagedTmuxLaunchProof> = {}): ManagedTmuxLaunchProof => ({
	name: "managed-child",
	nativeSessionId: "$42",
	serverPid: 700,
	serverStartTime: "darwin:100",
	ownerGeneration: "owner-generation",
	sessionId: "child-session",
	sessionStateFile: "/repo/.gjc/_session-child-session/runtime/tmux-sessions/managed-child.json",
	pid: 701,
	providerIdentity: '["native-tmux","tmux",null,null]',
	...overrides,
});

const substrateProof = (managed = managedProof()): SpawnSubstrateProof => ({
	substrateKind: "tmux",
	providerIdentity: managed.providerIdentity,
	nativeSessionId: managed.nativeSessionId,
	pid: managed.pid,
	processIncarnation: "darwin:701",
	stateFileProof: {
		sessionName: managed.name,
		sessionId: managed.sessionId,
		sessionStateFile: managed.sessionStateFile,
		ownerGeneration: managed.ownerGeneration,
		serverPid: managed.serverPid,
		serverStartTime: managed.serverStartTime,
	},
});

function managedDependencies(
	overrides: Partial<SpawnSubstrateProviderDependencies> = {},
): SpawnSubstrateProviderDependencies {
	return {
		platform: "darwin",
		selectMultiplexer: () => "tmux",
		launchManaged: () => managedProof(),
		verifyManaged: () => "verified",
		closeManaged: async () => {},
		processIncarnation: () => "darwin:701",
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("Broker spawn substrate provider", () => {
	it("captures the managed provider, native session, server, pid, and owner proof inputs", async () => {
		const provider = createSpawnSubstrateProvider(managedDependencies());
		const result = await provider.launch(launchSpec());
		expect(result).toEqual({
			ok: true,
			proof: substrateProof(),
		});
	});

	it("validates child-specific environment entries while permitting empty values", async () => {
		const provider = createSpawnSubstrateProvider(managedDependencies());
		const accepted = await provider.launch({
			...launchSpec(),
			env: { CHILD_SETTING: "enabled", AWS_PAGER: "", EMPTY_TOO: "" },
		});
		expect(accepted).toEqual({ ok: true, proof: substrateProof() });
		const badName = await provider.launch({ ...launchSpec(), env: { "BAD-NAME": "x" } });
		expect(badName).toMatchObject({ ok: false, code: "substrate_proof_failed" });
		const nulValue = await provider.launch({ ...launchSpec(), env: { OK_NAME: "a\u0000b" } });
		expect(nulValue).toMatchObject({ ok: false, code: "substrate_proof_failed" });
		const atBound = await provider.launch({ ...launchSpec(), env: { OK_NAME: "x".repeat(4096) } });
		expect(atBound).toMatchObject({ ok: true });
		const oversized = await provider.launch({ ...launchSpec(), env: { OK_NAME: "x".repeat(4097) } });
		expect(oversized).toMatchObject({ ok: false, code: "substrate_proof_failed" });
	});

	it("drops unsupported inherited environment entries without weakening child-specific validation", async () => {
		let receivedEnvironment: NodeJS.ProcessEnv | undefined;
		const drops: string[][] = [];
		const provider = createSpawnSubstrateProvider(
			managedDependencies({
				launchManaged: (_spec, environment) => {
					receivedEnvironment = environment;
					return managedProof();
				},
				onInheritedEnvironmentDrop: names => drops.push([...names]),
			}),
		);
		const result = await provider.launch({
			...launchSpec(),
			inheritedEnv: {
				FOO_BAR: "retained",
				"FOO-BAR": "dropped",
				TOO_LARGE: "x".repeat(4097),
			},
			env: { CHILD_SETTING: "enabled" },
		});
		expect(result).toEqual({ ok: true, proof: substrateProof() });
		expect(receivedEnvironment).toMatchObject({ FOO_BAR: "retained", CHILD_SETTING: "enabled" });
		expect(receivedEnvironment?.["FOO-BAR"]).toBeUndefined();
		expect(receivedEnvironment?.TOO_LARGE).toBeUndefined();
		expect(drops).toEqual([["FOO-BAR", "TOO_LARGE"]]);
	});

	it("uses the psmux substrate kind only for the Windows multiplexer selection", async () => {
		const psmux = managedProof({
			providerIdentity: '["windows-psmux","C:\\\\psmux.exe","namespace","volume:42"]',
			psmuxIncarnation: "psmux-incarnation",
		});
		const provider = createSpawnSubstrateProvider({
			platform: "win32",
			selectMultiplexer: () => "psmux",
			launchManaged: () => psmux,
			verifyManaged: () => "verified",
			closeManaged: async () => {},
			processIncarnation: () => "windows:701",
		});
		const result = await provider.launch(launchSpec("C:\\repo"));
		expect(result).toEqual({
			ok: true,
			proof: {
				...substrateProof(psmux),
				substrateKind: "psmux",
				processIncarnation: "windows:701",
				stateFileProof: {
					...substrateProof(psmux).stateFileProof,
					psmuxIncarnation: "psmux-incarnation",
				},
			},
		});
	});

	it("falls back to an exact headless proof after managed substrate launch failure", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-substrate-"));
		temporaryDirectories.push(cwd);
		let headlessStarted = false;
		const provider = createSpawnSubstrateProvider(
			managedDependencies({
				launchManaged: () => {
					throw new Error("tag round-trip failed");
				},
				startHeadless: () => {
					headlessStarted = true;
					return { pid: 999, terminate() {} };
				},
			}),
		);
		await expect(provider.launch(launchSpec(cwd))).resolves.toMatchObject({
			ok: true,
			proof: { substrateKind: "headless", pid: 999 },
		});
		expect(headlessStarted).toBeTrue();
	});

	it("preserves both substrate diagnostics when every substrate fails", async () => {
		const provider = createSpawnSubstrateProvider(
			managedDependencies({
				launchManaged: () => {
					throw new Error("planned_spawn_failed: fork failed");
				},
				startHeadless: () => {
					throw new Error("headless unavailable");
				},
			}),
		);
		await expect(provider.launch(launchSpec())).resolves.toEqual({
			ok: false,
			code: "substrate_unavailable",
			message:
				"tmux substrate launch failed: planned_spawn_failed: fork failed; headless substrate failed: No safe spawn substrate is available.",
		});
	});

	it("reports a reused pane PID with a different OS incarnation as a mismatch", async () => {
		const provider = createSpawnSubstrateProvider(
			managedDependencies({ processIncarnation: () => "darwin:replacement" }),
		);
		expect(await provider.verify(substrateProof())).toBe("mismatch");
	});

	it("refuses a close when the exact managed proof no longer matches", async () => {
		let closeCalls = 0;
		const provider = createSpawnSubstrateProvider(
			managedDependencies({
				verifyManaged: () => "mismatch",
				closeManaged: async () => {
					closeCalls++;
				},
			}),
		);
		expect(await provider.close(substrateProof())).toEqual({ ok: false, code: "substrate_mismatch" });
		expect(closeCalls).toBe(0);
	});

	it("uses identity-fenced headless only when no safe multiplexer provider exists", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-substrate-"));
		temporaryDirectories.push(cwd);
		let terminated = false;
		const provider = createSpawnSubstrateProvider({
			platform: "darwin",
			selectMultiplexer: () => "none",
			startHeadless: () => ({ pid: 991, terminate: () => (terminated = true) }),
			processIncarnation: () => "darwin:991",
		});
		const result = await provider.launch({
			...launchSpec(cwd),
			argv: ["known-low-entropy-task"],
			env: { SPAWN_CAPABILITY: "transient-capability" },
		});
		expect(result.ok).toBeTrue();
		if (!result.ok) throw new Error("headless provider was not selected");
		expect(result.proof).toMatchObject({
			substrateKind: "headless",
			pid: 991,
			processIncarnation: "darwin:991",
		});
		const stateFile = result.proof.stateFileProof?.stateFile;
		expect(typeof stateFile).toBe("string");
		const stateText = await Bun.file(stateFile as string).text();
		expect(stateText).not.toContain("known-low-entropy-task");
		expect(stateText).not.toContain("transient-capability");
		expect(terminated).toBeFalse();
	});

	it("returns gone only after the durable headless proof matches an absent process", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-substrate-"));
		temporaryDirectories.push(cwd);
		let live = true;
		const provider = createSpawnSubstrateProvider({
			platform: "darwin",
			selectMultiplexer: () => "none",
			startHeadless: () => ({ pid: 992, terminate() {} }),
			processIncarnation: () => (live ? "darwin:992" : undefined),
			isProcessGone: () => true,
		});
		const launched = await provider.launch(launchSpec(cwd));
		expect(launched.ok).toBeTrue();
		if (!launched.ok) throw new Error("headless substrate did not launch");
		live = false;
		expect(await provider.verify(launched.proof)).toBe("gone");
		expect(await provider.close(launched.proof)).toEqual({ ok: false, code: "substrate_gone" });
	});

	it("leaves a SIGTERM-trapping headless incarnation pending until its exit is observed", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-substrate-"));
		temporaryDirectories.push(cwd);
		let live = true;
		let killTerminates = false;
		const signals: Array<"SIGTERM" | "SIGKILL"> = [];
		const provider = createSpawnSubstrateProvider({
			platform: "darwin",
			selectMultiplexer: () => "none",
			startHeadless: () => ({ pid: 993, terminate() {} }),
			processIncarnation: () => (live ? "darwin:993" : undefined),
			isProcessGone: () => !live,
			signalHeadless: (_pid, _incarnation, _platform, signal) => {
				signals.push(signal);
				if (signal === "SIGKILL" && killTerminates) live = false;
				return true;
			},
			sleep: async () => {},
		});
		const launched = await provider.launch(launchSpec(cwd));
		expect(launched.ok).toBeTrue();
		if (!launched.ok) throw new Error("headless substrate did not launch");
		expect(await provider.close(launched.proof)).toEqual({ ok: false, code: "substrate_close_pending" });
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(await provider.verify(launched.proof)).toBe("verified");

		killTerminates = true;
		expect(await provider.close(launched.proof)).toEqual({ ok: true });
		expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
		expect(await provider.verify(launched.proof)).toBe("gone");
	});

	it("accepts a gone headless process when teardown unlinks its proof first", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-substrate-"));
		temporaryDirectories.push(cwd);
		let live = true;
		let stateFile: string | undefined;
		const provider = createSpawnSubstrateProvider({
			platform: "darwin",
			selectMultiplexer: () => "none",
			startHeadless: () => ({ pid: 994, terminate() {} }),
			processIncarnation: () => (live ? "darwin:994" : undefined),
			isProcessGone: () => !live,
			signalHeadless: () => {
				live = false;
				if (stateFile) void fs.rm(stateFile, { force: true });
				return true;
			},
			sleep: async () => {
				await Bun.sleep(0);
			},
		});
		const launched = await provider.launch(launchSpec(cwd));
		expect(launched.ok).toBeTrue();
		if (!launched.ok) throw new Error("headless substrate did not launch");
		const candidateStateFile = launched.proof.stateFileProof?.stateFile;
		stateFile = typeof candidateStateFile === "string" ? candidateStateFile : undefined;
		expect(await provider.close(launched.proof)).toEqual({ ok: true });
	});

	it("closes only the requested exact sibling proof", async () => {
		const first = managedProof();
		const sibling = managedProof({
			name: "managed-sibling",
			nativeSessionId: "$43",
			pid: 702,
			sessionId: "sibling-session",
			ownerGeneration: "sibling-generation",
		});
		const closed: string[] = [];
		const provider = createSpawnSubstrateProvider(
			managedDependencies({
				launchManaged: () => first,
				verifyManaged: proof =>
					proof.name === first.name || proof.name === sibling.name ? "verified" : "mismatch",
				closeManaged: async proof => {
					closed.push(proof.name);
				},
			}),
		);
		expect(await provider.close(substrateProof(first))).toEqual({ ok: true });
		expect(closed).toEqual([first.name]);
		expect(closed).not.toContain(sibling.name);
	});
});
