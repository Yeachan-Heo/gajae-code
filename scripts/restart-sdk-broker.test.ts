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
		listSessionHosts: async () => [],
		closeSession: async () => {},
		signal: () => {},
		ensure: async () => discovery(2, "darwin:2:0"),
		sleep: async () => {},
		...overrides,
	};
}

class UnknownOperationError extends Error {
	readonly code = "unknown_operation";
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

test("falls back to an identity-fenced signal when the broker lacks broker.shutdown", async () => {
	const previous = discovery(1, "darwin:1:0");
	const replacement = discovery(2, "darwin:2:0");
	const discoveries = [previous, null, null];
	const signalled: BrokerDiscoveryLike[] = [];
	const result = await restartSdkBroker(
		{ agentDir: "/agent" },
		deps({
			readDiscovery: async () => discoveries.shift() ?? null,
			shutdown: async () => {
				throw new UnknownOperationError("unknown broker operation");
			},
			signal: value => {
				signalled.push(value);
			},
			ensure: async () => replacement,
		}),
	);

	expect(signalled).toEqual([previous]);
	expect(result).toEqual({ previousPid: 1, pid: 2 });
});

test("closes session hosts through the live broker before shutting it down", async () => {
	const previous = discovery(1, "darwin:1:0");
	const discoveries = [previous, null, null];
	const calls: unknown[] = [];
	const result = await restartSdkBroker(
		{ agentDir: "/agent", closeSessionHosts: true },
		deps({
			readDiscovery: async () => discoveries.shift() ?? null,
			listSessionHosts: async value => {
				calls.push({ kind: "list", pid: value.pid });
				return ["session-a", "session-b"];
			},
			closeSession: async (value, sessionId) => {
				calls.push({ kind: "close", pid: value.pid, sessionId });
			},
			shutdown: async value => {
				calls.push({ kind: "shutdown", pid: value.pid });
			},
		}),
	);

	expect(calls).toEqual([
		{ kind: "list", pid: 1 },
		{ kind: "close", pid: 1, sessionId: "session-a" },
		{ kind: "close", pid: 1, sessionId: "session-b" },
		{ kind: "shutdown", pid: 1 },
	]);
	expect(result).toEqual({ previousPid: 1, pid: 2, closedSessionIds: ["session-a", "session-b"] });
});

test("leaves session hosts running unless closing them was requested", async () => {
	const previous = discovery(1, "darwin:1:0");
	const discoveries = [previous, null, null];
	let listed = false;
	const result = await restartSdkBroker(
		{ agentDir: "/agent" },
		deps({
			readDiscovery: async () => discoveries.shift() ?? null,
			listSessionHosts: async () => {
				listed = true;
				return ["session-a"];
			},
		}),
	);

	expect(listed).toBe(false);
	expect(result).toEqual({ previousPid: 1, pid: 2 });
});

test("does not signal when authenticated shutdown fails for another reason", async () => {
	const previous = discovery(1, "darwin:1:0");
	let signalled = false;
	await expect(
		restartSdkBroker(
			{ agentDir: "/agent" },
			deps({
				readDiscovery: async () => previous,
				shutdown: async () => {
					throw new Error("connection refused");
				},
				signal: () => {
					signalled = true;
				},
			}),
		),
	).rejects.toThrow("connection refused");
	expect(signalled).toBe(false);
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
