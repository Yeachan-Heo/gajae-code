import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { Process as NativeProcess } from "@gajae-code/natives";
import {
	authenticateOwnershipRecord,
	createDarwinAncestryTracker,
	extendOwnedDarwinAncestry,
	findSparedSdkBrokerPids,
	findSparedSdkBrokerPidsBounded,
	parseOwnershipRecord,
	retainOwnedProcess,
	sdkBrokerAgentDirFromArgs,
	signalOwnedProcessAlone,
} from "../src/exec/bash-shell-guardian";

type ProcessDouble = { pid: number; incarnation: string; children: () => NativeProcess[] };

/** Typed double for the members of the native Process contract the guardian reads. */
function processDouble(pid: number, incarnation: string, children: () => NativeProcess[] = () => []): NativeProcess {
	const double: ProcessDouble = { pid, incarnation, children };
	return double as unknown as NativeProcess;
}

/** Process lookup over a fixed set of live doubles, standing in for the native table. */
function lookupOf(...live: NativeProcess[]): (pid: number) => NativeProcess | undefined {
	return pid => live.find(processRef => processRef.pid === pid);
}

type Observation = { status: "present" | "absent" | "unknown"; incarnation?: string };

/** Native observation over the same doubles: present with its incarnation, else absent. */
function observeOf(...live: NativeProcess[]): (pid: number) => Observation {
	return pid => {
		const found = live.find(processRef => processRef.pid === pid);
		return found ? { status: "present", incarnation: found.incarnation } : { status: "absent" };
	};
}

/**
 * Tests for bash-shell-guardian ownership tracking and Darwin ancestry tracking.
 */
describe("bash-shell-guardian", () => {
	describe("parseOwnershipRecord", () => {
		it("parses valid ownership records", () => {
			const record = parseOwnershipRecord(
				JSON.stringify({
					pid: 1234,
					incarnation: "uuid-abc",
					darwinUniqueId: "9876543210",
					signature: "abcd1234",
				}),
			);
			expect(record).toEqual({
				pid: 1234,
				incarnation: "uuid-abc",
				darwinUniqueId: "9876543210",
				signature: "abcd1234",
			});
		});

		it("parses records without darwinUniqueId (incarnation-only)", () => {
			const record = parseOwnershipRecord(
				JSON.stringify({
					pid: 1234,
					incarnation: "uuid-abc",
					signature: "abcd1234",
				}),
			);
			expect(record).toEqual({
				pid: 1234,
				incarnation: "uuid-abc",
				signature: "abcd1234",
			});
		});

		it("rejects invalid JSON", () => {
			expect(parseOwnershipRecord("not json")).toBeUndefined();
		});

		it("rejects records with missing required fields", () => {
			expect(
				parseOwnershipRecord(
					JSON.stringify({
						pid: 1234,
						// missing incarnation
						signature: "abcd1234",
					}),
				),
			).toBeUndefined();
		});

		it("rejects records with invalid darwinUniqueId (non-numeric)", () => {
			expect(
				parseOwnershipRecord(
					JSON.stringify({
						pid: 1234,
						incarnation: "uuid-abc",
						darwinUniqueId: "not-a-number",
						signature: "abcd1234",
					}),
				),
			).toBeUndefined();
		});
	});

	describe("authenticateOwnershipRecord", () => {
		const token = "ledger-token";
		const sign = (pid: number, incarnation: string, uniqueId: string) =>
			createHmac("sha256", token).update(`${pid}:${incarnation}:${uniqueId}`).digest("hex");

		it("authenticates an incarnation-only record on every platform", () => {
			const line = JSON.stringify({ pid: 1234, incarnation: "uuid-abc", signature: sign(1234, "uuid-abc", "") });
			const authenticated = authenticateOwnershipRecord(line, token);
			expect(authenticated).toBeDefined();
			expect(authenticated?.darwinUniqueId).toBeUndefined();
		});

		it("settles a record whose process is confirmed gone instead of keeping it pending", () => {
			// Spawn and reap a real child so its pid is confirmed absent, not unknown.
			const child = Bun.spawnSync(["true"]);
			const pid = child.pid;
			const line = JSON.stringify({ pid, incarnation: "gone", signature: sign(pid, "gone", "") });
			const authenticated = authenticateOwnershipRecord(line, token);
			expect(authenticated).toBeDefined();
			expect(authenticated?.pending).toBeUndefined();
			expect(authenticated?.processRef).toBeUndefined();
		});

		it("keeps a record pending while its live process cannot be referenced", () => {
			// A live process can deny the authority Process.fromPid needs (so it returns null) while
			// Process.observe still reads it: that proves liveness, not ownership, so it must not settle.
			const line = JSON.stringify({ pid: 4321, incarnation: "live-inc", signature: sign(4321, "live-inc", "") });
			const bindings = (observation: { status: string; incarnation?: string }) =>
				({ fromPid: () => null, observe: () => observation }) as never;
			const samePresent = authenticateOwnershipRecord(
				line,
				token,
				bindings({ status: "present", incarnation: "live-inc" }),
			);
			expect(samePresent?.pending).toBe(true);
			expect(samePresent?.processRef).toBeUndefined();
			// A different incarnation or a confirmed absence proves the recorded process is gone.
			expect(
				authenticateOwnershipRecord(line, token, bindings({ status: "present", incarnation: "replacement" }))
					?.pending,
			).toBeUndefined();
			expect(authenticateOwnershipRecord(line, token, bindings({ status: "absent" }))?.pending).toBeUndefined();
		});

		it("rejects malformed and forged records without loading the native addon", () => {
			// Cleanup must still reject untrusted ledger lines and kill the supervised tree when the
			// addon cannot load, so the binding is resolved only for an authenticated record.
			const nativesId = require.resolve("@gajae-code/natives");
			const previous = require.cache[nativesId];
			const unavailable = new Proxy(
				{},
				{
					get() {
						throw new Error("native addon unavailable");
					},
				},
			);
			require.cache[nativesId] = { id: nativesId, filename: nativesId, loaded: true, exports: unavailable } as never;
			try {
				expect(authenticateOwnershipRecord("not json", token)).toBeUndefined();
				const forged = JSON.stringify({ pid: 1234, incarnation: "uuid-abc", signature: sign(1234, "other", "") });
				expect(authenticateOwnershipRecord(forged, token)).toBeUndefined();
				const line = JSON.stringify({ pid: 1234, incarnation: "uuid-abc", signature: sign(1234, "uuid-abc", "") });
				expect(() => authenticateOwnershipRecord(line, token)).toThrow("native addon unavailable");
			} finally {
				if (previous) require.cache[nativesId] = previous;
				else delete require.cache[nativesId];
			}
		});

		it("binds the Darwin unique id into the signature", () => {
			const signature = sign(1234, "uuid-abc", "");
			const forged = JSON.stringify({ pid: 1234, incarnation: "uuid-abc", darwinUniqueId: "42", signature });
			expect(authenticateOwnershipRecord(forged, token)).toBeUndefined();

			const line = JSON.stringify({
				pid: 1234,
				incarnation: "uuid-abc",
				darwinUniqueId: "42",
				signature: sign(1234, "uuid-abc", "42"),
			});
			expect(authenticateOwnershipRecord(line, token)?.darwinUniqueId).toBe(42n);
		});
	});

	describe("retainOwnedProcess", () => {
		it("retains a process by pid:incarnation key", () => {
			const owned = new Map<string, NativeProcess>();
			const processRef = processDouble(1234, "uuid-abc");
			const result = retainOwnedProcess(owned, processRef);
			expect(result).toBe(true);
			expect(owned.get("1234:uuid-abc")).toBe(processRef);
		});

		it("returns false if process pid matches guardian pid", () => {
			const owned = new Map<string, NativeProcess>();
			const processRef = processDouble(process.pid, "uuid-abc");
			const result = retainOwnedProcess(owned, processRef);
			expect(result).toBe(false);
			expect(owned.size).toBe(0);
		});

		it("allows overwriting process with same key", () => {
			const owned = new Map<string, NativeProcess>();
			const processRef1 = processDouble(1234, "uuid-abc");
			const processRef2 = processDouble(1234, "uuid-abc");
			retainOwnedProcess(owned, processRef1);
			retainOwnedProcess(owned, processRef2);
			expect(owned.size).toBe(1);
			expect(owned.get("1234:uuid-abc")).toBe(processRef2);
		});
	});

	describe("extendOwnedDarwinAncestry", () => {
		it("extends ancestry chain using parent-child relationships", () => {
			const knownUniqueIds = new Set<bigint>([BigInt(100)]);
			const candidates = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>([
				[1001, { uniqueId: BigInt(101), parentUniqueId: BigInt(100) }],
				[1002, { uniqueId: BigInt(102), parentUniqueId: BigInt(101) }],
				[1003, { uniqueId: BigInt(103), parentUniqueId: BigInt(200) }], // unrelated
			]);
			const added = extendOwnedDarwinAncestry(knownUniqueIds, candidates);
			expect(added).toEqual([1001, 1002]);
			expect(knownUniqueIds).toEqual(new Set([BigInt(100), BigInt(101), BigInt(102)]));
		});

		it("handles empty candidates", () => {
			const knownUniqueIds = new Set<bigint>([BigInt(100)]);
			const candidates = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>();
			const added = extendOwnedDarwinAncestry(knownUniqueIds, candidates);
			expect(added).toEqual([]);
		});

		it("returns empty array if no candidates match known IDs", () => {
			const knownUniqueIds = new Set<bigint>([BigInt(100)]);
			const candidates = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>([
				[1001, { uniqueId: BigInt(200), parentUniqueId: BigInt(201) }],
			]);
			const added = extendOwnedDarwinAncestry(knownUniqueIds, candidates);
			expect(added).toEqual([]);
		});
	});

	describe("Darwin ancestry tracker (injected identity and process lookup)", () => {
		const noUniqueIdentity = (): undefined => undefined;

		it("retains incarnation-only records when the unique-id query is denied", () => {
			const processRef = processDouble(12345, "test-incarnation");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: noUniqueIdentity,
				fromPid: lookupOf(processRef),
				observe: observeOf(processRef),
			});
			if (!tracker) return; // Darwin-only tracker.
			expect(tracker.track(processRef)).toBe(true);
			expect(owned.get("12345:test-incarnation")).toBe(processRef);
			tracker.close();
		});

		it("does not retain a record whose pid was reused after authentication", () => {
			const recorded = processDouble(12345, "recorded");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: noUniqueIdentity,
				fromPid: lookupOf(processDouble(12345, "replacement")),
				observe: observeOf(processDouble(12345, "replacement")),
			});
			if (!tracker) return;
			expect(tracker.track(recorded)).toBe(true);
			expect(owned.size).toBe(0);
			tracker.close();
		});

		it("keeps a record as an anchor when the post-query lookup is inconclusive", () => {
			const processRef = processDouble(12345, "recorded");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				// A unique id is returned but cannot be vouched for without a conclusive
				// incarnation check, so it must not be seeded.
				uniqueIdentity: () => ({ uniqueId: 77n, parentUniqueId: 0n }),
				fromPid: () => null,
				observe: () => ({ status: "unknown" }),
			});
			if (!tracker) return;
			expect(tracker.track(processRef)).toBe(true);
			expect(owned.get("12345:recorded")).toBe(processRef);
			tracker.close();
		});

		it("ignores an anchor's child snapshot once the anchor pid was reused", () => {
			const stranger = processDouble(200, "stranger");
			let reused = false;
			// The anchor is live and valid when tracked; its pid is reused while
			// children() takes the snapshot, which therefore lists a stranger's child.
			const anchor = processDouble(100, "anchor", () => {
				reused = true;
				return [stranger];
			});
			const current = (pid: number): NativeProcess =>
				pid === 100 ? (reused ? processDouble(100, "replacement") : anchor) : stranger;
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: () => undefined,
				fromPid: current,
				observe: pid => ({ status: "present", incarnation: current(pid).incarnation }),
			});
			if (!tracker) return;
			expect(tracker.track(anchor)).toBe(true);
			expect(owned.get("100:anchor")).toBe(anchor);
			expect(owned.has("200:stranger")).toBe(false);
			tracker.close();
		});

		it("anchors descendants of an incarnation-only record by their unique ids (#6086)", () => {
			const ids = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>([
				[101, { uniqueId: 9001n, parentUniqueId: 0n }],
			]);
			const grandchild = processDouble(101, "g");
			let spawned = false;
			const child = processDouble(100, "c", () => (spawned ? [grandchild] : []));
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: pid => ids.get(pid),
				fromPid: lookupOf(child, grandchild),
				observe: observeOf(child, grandchild),
			});
			if (!tracker) return;
			expect(tracker.track(child)).toBe(true);
			expect(owned.has("101:g")).toBe(false);
			// A descendant forked after the ledger record was read is picked up by the
			// next poll, which re-walks the incarnation-only anchor.
			spawned = true;
			tracker.poll();
			expect(owned.get("101:g")).toBe(grandchild);
			tracker.close();
		});

		it("trackGuardian() requires a unique id", () => {
			const processRef = processDouble(12345, "test-incarnation");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: noUniqueIdentity,
				fromPid: lookupOf(processRef),
			});
			if (!tracker) return;
			expect(tracker.trackGuardian(processRef)).toBe(false);
			expect(owned.size).toBe(0);
			expect(tracker.trackGuardian(processRef, 999n)).toBe(true);
			expect(owned.get("12345:test-incarnation")).toBe(processRef);
			tracker.close();
		});
	});

	describe("sdkBrokerAgentDirFromArgs", () => {
		it("reads the agent dir from compiled and source broker launches", () => {
			expect(sdkBrokerAgentDirFromArgs(["/bin/gjc", "sdk", "broker-internal", "--agent-dir", "/a"])).toBe("/a");
			expect(
				sdkBrokerAgentDirFromArgs([
					"bun",
					"--no-env-file",
					"--config=/x/bunfig.toml",
					"/x/cli.ts",
					"sdk",
					"broker-internal",
					"--agent-dir",
					"/b",
				]),
			).toBe("/b");
		});

		it("rejects other sdk commands and malformed broker argv", () => {
			expect(sdkBrokerAgentDirFromArgs(["gjc", "sdk", "broker", "run", "--agent-dir", "/a"])).toBeUndefined();
			expect(
				sdkBrokerAgentDirFromArgs(["gjc", "sdk", "session-host-internal", "--agent-dir", "/a"]),
			).toBeUndefined();
			expect(sdkBrokerAgentDirFromArgs(["gjc", "broker-internal", "--agent-dir", "/a"])).toBeUndefined();
			expect(sdkBrokerAgentDirFromArgs(["gjc", "sdk", "broker-internal", "--agent-dir"])).toBeUndefined();
			expect(sdkBrokerAgentDirFromArgs(["gjc", "sdk", "broker-internal", "--agent-dir", ""])).toBeUndefined();
			expect(
				sdkBrokerAgentDirFromArgs(["gjc", "sdk", "broker-internal", "--agent-dir", "/a", "--extra"]),
			).toBeUndefined();
		});
	});

	describe("findSparedSdkBrokerPids", () => {
		const brokerArgv = (agentDir: string) => ["/bin/gjc", "sdk", "broker-internal", "--agent-dir", agentDir];
		const owned = (pid: number, incarnation: string, args: string[] | (() => string[])) => ({
			pid,
			incarnation,
			args: typeof args === "function" ? args : () => args,
		});

		it("spares the published broker and its lineage, and nothing else", async () => {
			const spared = await findSparedSdkBrokerPids(
				[owned(10, "b", brokerArgv("/agent")), owned(20, "x", ["python3", "-c", "sleep"])],
				{
					readDiscovery: async dir => (dir === "/agent" ? { pid: 10, incarnation: "b" } : null),
					lineage: pid => (pid === 10 ? new Set([10, 11, 12]) : undefined),
					incarnationOf: pid => (pid === 10 ? "b" : undefined),
				},
			);
			expect([...spared].sort()).toEqual([10, 11, 12]);
		});

		it("kills a broker-shaped process whose identity does not match the discovery record", async () => {
			const deps = {
				lineage: (pid: number) => new Set([pid]),
				incarnationOf: () => "b",
			};
			// A reused pid: same pid, different incarnation.
			expect(
				(
					await findSparedSdkBrokerPids([owned(10, "stale", brokerArgv("/agent"))], {
						...deps,
						readDiscovery: async () => ({ pid: 10, incarnation: "b" }),
					})
				).size,
			).toBe(0);
			// A second broker for the same agent dir that lost the publication race.
			expect(
				(
					await findSparedSdkBrokerPids([owned(30, "b", brokerArgv("/agent"))], {
						...deps,
						readDiscovery: async () => ({ pid: 10, incarnation: "b" }),
					})
				).size,
			).toBe(0);
			// Nothing published, or the discovery read fails.
			for (const readDiscovery of [async () => null, async () => Promise.reject(new Error("unsupported state"))]) {
				expect(
					(await findSparedSdkBrokerPids([owned(10, "b", brokerArgv("/agent"))], { ...deps, readDiscovery })).size,
				).toBe(0);
			}
		});

		it("does not spare a broker that changed incarnation during the lineage walk", async () => {
			const spared = await findSparedSdkBrokerPids([owned(10, "b", brokerArgv("/agent"))], {
				readDiscovery: async () => ({ pid: 10, incarnation: "b" }),
				lineage: () => new Set([10, 11]),
				incarnationOf: () => "replacement",
			});
			expect(spared.size).toBe(0);
		});

		it("still spares the broker itself when its lineage cannot be read", async () => {
			const spared = await findSparedSdkBrokerPids([owned(10, "b", brokerArgv("/agent"))], {
				readDiscovery: async () => ({ pid: 10, incarnation: "b" }),
				lineage: () => undefined,
				incarnationOf: () => "b",
			});
			expect([...spared]).toEqual([10]);
		});

		it("skips processes whose argv cannot be read", async () => {
			const spared = await findSparedSdkBrokerPids(
				[
					owned(10, "b", () => {
						throw new Error("EPERM");
					}),
				],
				{
					readDiscovery: async () => ({ pid: 10, incarnation: "b" }),
					lineage: () => new Set([10]),
					incarnationOf: () => "b",
				},
			);
			expect(spared.size).toBe(0);
		});
	});

	describe("findSparedSdkBrokerPidsBounded", () => {
		const broker = {
			pid: 10,
			incarnation: "b",
			args: () => ["/bin/gjc", "sdk", "broker-internal", "--agent-dir", "/agent"],
		};
		const published = async () => ({ pid: 10, incarnation: "b" });

		it("spares the published broker when the lookup completes in time", async () => {
			const spared = await findSparedSdkBrokerPidsBounded([broker], {
				readDiscovery: published,
				lineage: () => new Set([10, 11]),
				incarnationOf: () => "b",
			});
			expect([...spared].sort()).toEqual([10, 11]);
		});

		it("spares nothing when the lineage walk throws", async () => {
			const spared = await findSparedSdkBrokerPidsBounded([broker], {
				readDiscovery: published,
				lineage: () => {
					throw new Error("proc_listallpids failed");
				},
				incarnationOf: () => "b",
			});
			expect(spared.size).toBe(0);
		});

		it("spares nothing when the discovery read throws synchronously", async () => {
			const spared = await findSparedSdkBrokerPidsBounded([broker], {
				readDiscovery: () => {
					throw new Error("sync failure");
				},
				lineage: () => new Set([10]),
				incarnationOf: () => "b",
			});
			expect(spared.size).toBe(0);
		});

		it("spares nothing when the discovery read stalls past the timeout", async () => {
			const started = Date.now();
			const spared = await findSparedSdkBrokerPidsBounded(
				[broker],
				{
					readDiscovery: () => new Promise(() => {}),
					lineage: () => new Set([10]),
					incarnationOf: () => "b",
				},
				50,
			);
			expect(spared.size).toBe(0);
			expect(Date.now() - started).toBeLessThan(1_000);
		});
	});

	describe("signalOwnedProcessAlone", () => {
		const ownedRef = (signalRoot: () => boolean) => ({ pid: 10, incarnation: "b", signalRoot });

		it("uses the identity-bound native signal when the platform delivers it", () => {
			const kills: number[] = [];
			const delivered = signalOwnedProcessAlone(
				ownedRef(() => true),
				{
					incarnationOf: () => {
						throw new Error("must not re-read identity");
					},
					killPid: pid => kills.push(pid),
				},
			);
			expect(delivered).toBe(true);
			expect(kills).toEqual([]);
		});

		it("falls back to a raw kill only while the recorded incarnation still holds", () => {
			const kills: Array<[number, string]> = [];
			const deps = { killPid: (pid: number, signal: string) => kills.push([pid, signal]) };
			expect(
				signalOwnedProcessAlone(
					ownedRef(() => false),
					{ ...deps, incarnationOf: () => "b" },
				),
			).toBe(true);
			expect(kills).toEqual([[10, "SIGKILL"]]);

			expect(
				signalOwnedProcessAlone(
					ownedRef(() => false),
					{ ...deps, incarnationOf: () => "reused" },
				),
			).toBe(false);
			expect(
				signalOwnedProcessAlone(
					ownedRef(() => false),
					{ ...deps, incarnationOf: () => undefined },
				),
			).toBe(false);
			expect(kills).toHaveLength(1);
		});

		it("treats a throwing native signal as unsupported and a failed raw kill as undelivered", () => {
			const throwing = ownedRef(() => {
				throw new Error("unsupported");
			});
			let attempts = 0;
			const delivered = signalOwnedProcessAlone(throwing, {
				incarnationOf: () => "b",
				killPid: () => {
					attempts += 1;
					throw new Error("ESRCH");
				},
			});
			expect(delivered).toBe(false);
			expect(attempts).toBe(1);
		});

		it.skipIf(process.platform !== "darwin")(
			"kills a real owned process and spares one whose recorded incarnation no longer matches",
			async () => {
				const { Process } = await import("@gajae-code/natives");
				const deps = {
					incarnationOf: (pid: number) => Process.fromPid(pid)?.incarnation,
					killPid: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
				};
				const survivor = Bun.spawn(["sleep", "30"]);
				const victim = Bun.spawn(["sleep", "30"]);
				try {
					const survivorRef = Process.fromPid(survivor.pid);
					const victimRef = Process.fromPid(victim.pid);
					if (!survivorRef || !victimRef) throw new Error("process refs unavailable");
					const stale = {
						pid: survivorRef.pid,
						incarnation: "darwin:0:0",
						signalRoot: (signal: number) => survivorRef.signalRoot(signal),
					};
					expect(signalOwnedProcessAlone(stale, deps)).toBe(false);
					expect(signalOwnedProcessAlone(victimRef, deps)).toBe(true);
					expect(await victim.exited).not.toBe(0);
					expect(victim.signalCode).toBe("SIGKILL");
					expect(survivor.exitCode).toBeNull();
					expect(survivor.killed).toBe(false);
				} finally {
					survivor.kill("SIGKILL");
					victim.kill("SIGKILL");
				}
			},
		);
	});
});
