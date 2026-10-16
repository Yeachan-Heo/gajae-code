import type { BrokerDiscovery } from "../src/sdk/broker/discovery";

// In-memory host fixtures must not start a detached daemon they cannot own.
export const testBrokerDiscovery: BrokerDiscovery = {
	version: 1,
	protocolVersion: 3,
	packageGeneration: "test",
	ownerId: "test-broker",
	pid: process.pid,
	incarnation: "test-incarnation",
	host: "127.0.0.1",
	port: 1,
	url: "ws://127.0.0.1:1",
	token: "test-token",
	startedAt: 0,
	heartbeatAt: 0,
};
