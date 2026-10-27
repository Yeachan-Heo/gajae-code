import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import { type BrokerBaselineDeps, measureBrokerBaseline } from "../bench/multisession/broker-baseline";
import type { BrokerDiscovery } from "../src/sdk/broker/discovery";
import { ensureBroker } from "../src/sdk/broker/ensure";
import { observeProcessIncarnation } from "../src/sdk/broker/process-incarnation";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version";

describe("multi-session Broker baseline", () => {
	it("uses a sanitized environment, fresh agent directory, per-rep means, and an exact stop handle", async () => {
		let repIndex = 0;
		let sampleIndex = 0;
		let stopCount = 0;
		const directories: string[] = [];
		const environments: NodeJS.ProcessEnv[] = [];
		const stopped = new Set<number>();
		const deps: BrokerBaselineDeps = {
			env: {
				PATH: "/usr/bin",
				HOME: "/tmp",
				OPENAI_API_KEY: "secret",
				GJC_MASTER_CAPABILITY: "capability",
				GJC_BENCH_COHORT: "cohort-token",
				GJC_SESSION_ID: "session",
			},
			ensureBroker: async settings => {
				const currentRep = repIndex++;
				directories.push(settings.agentDir);
				environments.push(settings.env ?? {});
				const pid = 700 + currentRep;
				const discovery: BrokerDiscovery = {
					version: SDK_STATE_VERSION,
					protocolVersion: 3,
					packageGeneration: "test-generation",
					ownerId: `owner-${currentRep}`,
					pid,
					incarnation: `darwin:${pid}:1`,
					host: "127.0.0.1",
					port: 9000 + currentRep,
					url: `http://127.0.0.1:${9000 + currentRep}`,
					token: "test-token",
					startedAt: 1,
					heartbeatAt: 1,
				};
				owners.set(settings.agentDir, { pid, stopped: false });
				sampleIndex = 0;
				return discovery;
			},
			brokerOwnerForTest: agentDir => {
				const owner = owners.get(agentDir);
				if (!owner) return undefined;
				return {
					async stop() {
						if (!owner.stopped) {
							owner.stopped = true;
							stopped.add(owner.pid);
							stopCount++;
						}
					},
				};
			},
			sampleProcess: pid => {
				const tick = sampleIndex++;
				const base = (pid - 699) * 100;
				const physFootprint = base + tick * 40;
				return { status: "ok", pid, incarnation: `darwin:${pid}:1`, physFootprint, rss: physFootprint / 2 };
			},
			observeProcessIncarnation: pid =>
				stopped.has(pid) ? { status: "absent" } : { status: "present", incarnation: `darwin:${pid}:1` },
			sleep: async () => {},
		};
		const owners = new Map<string, { pid: number; stopped: boolean }>();

		const record = await measureBrokerBaseline({ reps: 5, seconds: 2, deps });
		expect(record.reps).toHaveLength(5);
		expect(record.reps.every(rep => rep.complete && rep.samples.length === 2)).toBe(true);
		expect(record.b).toBe(320);
		expect(new Set(directories).size).toBe(5);
		expect(stopCount).toBe(5);
		for (const env of environments) {
			expect(env.PATH).toBe("/usr/bin");
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.GJC_MASTER_CAPABILITY).toBeUndefined();
			expect(env.GJC_BENCH_COHORT).toBeUndefined();
			expect(env.GJC_SESSION_ID).toBeUndefined();
		}
	});

	it("returns null B when any scheduled footprint read is incomplete", async () => {
		let stopped = false;
		let sampleCount = 0;
		const discovery: BrokerDiscovery = {
			version: SDK_STATE_VERSION,
			protocolVersion: 3,
			packageGeneration: "test-generation",
			ownerId: "owner",
			pid: 800,
			incarnation: "darwin:800:1",
			host: "127.0.0.1",
			port: 9000,
			url: "http://127.0.0.1:9000",
			token: "test-token",
			startedAt: 1,
			heartbeatAt: 1,
		};
		const deps: BrokerBaselineDeps = {
			ensureBroker: async () => discovery,
			brokerOwnerForTest: () => ({
				stop: async () => {
					stopped = true;
				},
			}),
			sampleProcess: pid => {
				sampleCount++;
				return sampleCount === 1
					? { status: "unresolved", pid, reason: "denied" }
					: { status: "ok", pid, incarnation: discovery.incarnation, physFootprint: 4, rss: 2 };
			},
			observeProcessIncarnation: () =>
				stopped ? { status: "absent" } : { status: "present", incarnation: discovery.incarnation },
			sleep: async () => {},
		};

		const record = await measureBrokerBaseline({ reps: 1, seconds: 2, deps });
		expect(record.reps).toEqual([{ samples: [null, 4], complete: false }]);
		expect(record.b).toBeNull();
		expect(stopped).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")(
		"starts and stops a real isolated Broker identity",
		async () => {
			let discovery: BrokerDiscovery | undefined;
			let parentPid: number | undefined;
			const record = await measureBrokerBaseline({
				reps: 1,
				seconds: 2,
				deps: {
					ensureBroker: async settings => {
						discovery = await ensureBroker(settings);
						parentPid = Number((await $`ps -o ppid= -p ${discovery.pid}`.quiet().text()).trim());
						return discovery;
					},
				},
			});
			// The measured identity is the detached Broker that survived its spawn
			// trampoline: reparented to launchd, not a child of this driver.
			expect(parentPid).toBe(1);
			expect(discovery).toBeDefined();
			expect(record.reps).toHaveLength(1);
			expect(record.reps[0]?.complete).toBe(true);
			expect(record.b).not.toBeNull();
			if (!discovery) throw new Error("real ensureBroker did not return a discovery identity");
			const after = observeProcessIncarnation(discovery.pid);
			expect(
				after.status === "absent" || (after.status === "present" && after.incarnation !== discovery.incarnation),
			).toBe(true);
		},
		60_000,
	);
});
