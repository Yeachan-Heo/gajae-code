import { expect, test } from "bun:test";
import {
	type BrokerDiscoveryLike,
	restartSdkBroker,
	type RestartSdkBrokerDeps,
} from "./restart-sdk-broker-core";

function discovery(pid: number, incarnation: string): BrokerDiscoveryLike {
	return {
		pid,
		incarnation,
		url: `ws://127.0.0.1:${40_000 + pid}`,
		token: `token-${pid}`,
	};
}

function deps(overrides: Partial<RestartSdkBrokerDeps> = {}): RestartSdkBrokerDeps {
	return {
		readDiscovery: async () => null,
		shutdown: async () => {},
		ensure: async () => discovery(2, "darwin:2:0"),
		sleep: async () => {},
		...overrides,
	};
}

test("starts an SDK broker when no owner is published", async () => {
	const ttlValues: number[] = [];
	await expect(
		restartSdkBroker(
			{ agentDir: "/agent" },
			deps({ readDiscovery: async (_agentDir, heartbeatTtlMs) => (ttlValues.push(heartbeatTtlMs), null) }),
		),
	).resolves.toEqual({ pid: 2 });
	expect(ttlValues).toEqual([Number.POSITIVE_INFINITY]);
});

test("requests authenticated shutdown before starting a replacement", async () => {
	const previous = discovery(1, "darwin:1:0");
	const replacement = discovery(2, "darwin:2:0");
	const calls: unknown[] = [];
	const discoveries = [previous, previous, null, null];
	const result = await restartSdkBroker(
		{ agentDir: "/agent", gracefulTimeoutMs: 123 },
		deps({
			readDiscovery: async (agentDir, heartbeatTtlMs) => {
				calls.push({ kind: "read", agentDir, heartbeatTtlMs });
				return discoveries.shift() ?? null;
			},
			shutdown: async value => {
				calls.push({ kind: "shutdown", value });
			},
			ensure: async agentDir => {
				calls.push({ kind: "ensure", agentDir });
				return replacement;
			},
		}),
	);

	expect(calls).toEqual([
		{ kind: "read", agentDir: "/agent", heartbeatTtlMs: Number.POSITIVE_INFINITY },
		{ kind: "shutdown", value: previous },
		{ kind: "read", agentDir: "/agent", heartbeatTtlMs: Number.POSITIVE_INFINITY },
		{ kind: "read", agentDir: "/agent", heartbeatTtlMs: Number.POSITIVE_INFINITY },
		{ kind: "read", agentDir: "/agent", heartbeatTtlMs: Number.POSITIVE_INFINITY },
		{ kind: "ensure", agentDir: "/agent" },
	]);
	expect(result).toEqual({ previousPid: 1, pid: 2 });
});

test("does not start a replacement when authenticated shutdown fails", async () => {
	const previous = discovery(1, "darwin:1:0");
	let ensured = false;
	await expect(
		restartSdkBroker(
			{ agentDir: "/agent" },
			deps({
				readDiscovery: async () => previous,
				shutdown: async () => {
					throw new Error("connection refused");
				},
				ensure: async () => {
					ensured = true;
					return discovery(2, "darwin:2:0");
				},
			}),
		),
	).rejects.toThrow("connection refused");
	expect(ensured).toBe(false);
});

test("does not start a replacement until the old discovery identity disappears", async () => {
	const previous = discovery(1, "darwin:1:0");
	let ensured = false;
	await expect(
		restartSdkBroker(
			{ agentDir: "/agent", gracefulTimeoutMs: 1 },
			deps({
				readDiscovery: async () => previous,
				ensure: async () => {
					ensured = true;
					return discovery(2, "darwin:2:0");
				},
				sleep: async () => await Bun.sleep(2),
			}),
		),
	).rejects.toThrow("did not complete its authenticated shutdown");
	expect(ensured).toBe(false);
});

test("rejects a replacement that retains the previous process identity", async () => {
	const previous = discovery(1, "darwin:1:0");
	const discoveries = [previous, null, null];
	await expect(
		restartSdkBroker(
			{ agentDir: "/agent" },
			deps({
				readDiscovery: async () => discoveries.shift() ?? null,
				ensure: async () => previous,
			}),
		),
	).rejects.toThrow("returned the previous process identity");
});
