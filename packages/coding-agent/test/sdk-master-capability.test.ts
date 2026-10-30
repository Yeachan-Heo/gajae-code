import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { readEndpointFile } from "../src/sdk/broker/endpoint-authority";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { type SessionIndexEvent, sessionIndexChecksum } from "../src/sdk/broker/session-index";
import { SESSION_INDEX_EVENT_VERSION } from "../src/sdk/broker/state-version";
import { verifyMasterCapabilityFrame } from "../src/sdk/host/session-runtime";

const capability = "master-capability-fixed-e2e";
const capabilityDigest = createHash("sha256").update(capability).digest("hex");
const sessionId = "master-e2e";
const attestationEpoch = "master-attestation-epoch-e2e";
const hostIncarnation = processIncarnation(process.pid);
type TestHost = { url: string; token: string; endpointPath: string; endpointFileId: string; stop: () => void };

function event(
	input: Omit<SessionIndexEvent, "version" | "indexSeq" | "checksum" | "ts">,
	indexSeq: number,
): SessionIndexEvent {
	const unsigned: Omit<SessionIndexEvent, "checksum"> = {
		...input,
		version: SESSION_INDEX_EVENT_VERSION,
		indexSeq,
		ts: Date.now(),
	};
	return { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
}

async function writeIndex(agentDir: string, events: readonly SessionIndexEvent[]): Promise<void> {
	const directory = path.join(agentDir, "sdk", "sessions");
	await fs.mkdir(directory, { recursive: true });
	await Bun.write(path.join(directory, "index.jsonl"), `${events.map(row => JSON.stringify(row)).join("\n")}\n`);
}

async function startHost(stateRoot: string, answer: "correct" | "wrong" | "replay"): Promise<TestHost> {
	const token = "host-token-e2e";
	const server = Bun.serve<{ connectionId: string }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, instance) {
			const url = new URL(request.url);
			if (url.searchParams.get("token") !== token) return new Response("Unauthorized", { status: 401 });
			if (instance.upgrade(request, { data: { connectionId: crypto.randomUUID() } })) return undefined;
			return new Response("WebSocket upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: socket.data.connectionId }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Record<string, unknown>;
				if (frame.type !== "master_capability_verify") return;
				const nonce = answer === "replay" ? "stale-nonce" : frame.nonce;
				socket.send(
					JSON.stringify({
						type: "master_capability_verify_result",
						id: nonce,
						ok: answer === "correct" && frame.capability === capability,
						nonce,
						attestationEpoch: frame.attestationEpoch,
					}),
				);
			},
		},
	});
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	await fs.mkdir(path.dirname(endpoint), { recursive: true });
	const url = new URL(server.url);
	url.protocol = "ws:";
	await Bun.write(endpoint, JSON.stringify({ version: 1, sessionId, pid: process.pid, url: url.toString(), token }));
	const stat = await fs.stat(endpoint, { bigint: true });
	return {
		url: url.toString(),
		token,
		endpointPath: endpoint,
		endpointFileId: `${stat.dev}:${stat.ino}`,
		stop: () => server.stop(true),
	};
}

async function spawn(broker: Broker, suppliedCapability = capability): Promise<unknown> {
	return await broker.handleRequest(
		"session.spawn",
		{
			task: "master spawn e2e",
			masterCapability: suppliedCapability,
			ownerSessionId: sessionId,
			attestationEpoch,
			cwd: process.cwd(),
		},
		crypto.randomUUID(),
	);
}

const spawnSubstrateFake = {
	launch: async () => ({
		ok: true as const,
		proof: {
			substrateKind: "headless" as const,
			providerIdentity: "test-provider",
			pid: 4242,
			processIncarnation: "inc-4242",
		},
	}),
	verify: async () => "verified" as const,
	close: async () => ({ ok: true }),
};
const spawnPromptLayerFake = {
	awaitRegistration: async (input: { childId: string; cwd: string; stateRoot: string }) => ({
		ok: true as const,
		registration: {
			sessionId: input.childId,
			endpointGeneration: 1,
			pid: 4242,
			processIncarnation: "inc-4242",
			cwd: input.cwd,
			stateRoot: input.stateRoot,
		},
	}),
	dispatch: async () => ({ kind: "accepted" as const, commandId: "cmd-1", turnId: "turn-1", acceptedAt: Date.now() }),
	reconcile: async () => ({ status: "terminal_ok" as const, commandId: "cmd-1", turnId: "turn-1" }),
};

describe("master capability effective-host verification", () => {
	it("authenticates before storing nonces and bounds replay memory under flood", () => {
		const replay = new Map<string, number>();
		for (let index = 0; index < 4_096; index++) {
			const result = verifyMasterCapabilityFrame({
				frame: { nonce: `invalid-${index}!`, attestationEpoch, capability: "wrong" },
				expectedCapability: capability,
				expectedEpoch: attestationEpoch,
				replay,
				now: 1_000,
			});
			expect(result.ok).toBe(false);
		}
		expect(replay.size).toBe(0);

		for (let index = 0; index < 2_048; index++) {
			const result = verifyMasterCapabilityFrame({
				frame: { nonce: `nonce-${index}`, attestationEpoch, capability },
				expectedCapability: capability,
				expectedEpoch: attestationEpoch,
				replay,
				now: 1_000,
			});
			expect(result.ok).toBe(true);
		}
		expect(replay.size).toBeLessThanOrEqual(1_024);
		expect(
			verifyMasterCapabilityFrame({
				frame: { nonce: "nonce-2047", attestationEpoch, capability },
				expectedCapability: capability,
				expectedEpoch: attestationEpoch,
				replay,
				now: 1_000,
			}).ok,
		).toBe(false);
	});

	it("requires an adopted live attachment, rejects stale replies and leaves no capability material on disk", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-capability-"));
		const stateRoot = path.join(agentDir, "host-state");
		const locator = { cwd: process.cwd(), worktreeRoot: null, stateRoot };
		const attestation = {
			version: 2 as const,
			ownerSessionId: sessionId,
			launchPid: process.pid,
			launchProcessIncarnation: hostIncarnation ?? "missing-incarnation",
			role: "master" as const,
			attestationEpoch,
		};
		const direct = event(
			{
				type: "host_registered",
				sessionId,
				locator,
				endpointGeneration: 0,
				pid: process.pid,
				hostIncarnation,
				masterRole: attestation,
			},
			1,
		);
		const broker = new Broker({
			agentDir,
			spawnSubstrateProvider: spawnSubstrateFake,
			spawnPromptLayer: spawnPromptLayerFake,
		});
		await broker.start();
		let host: TestHost | undefined;
		try {
			await writeIndex(agentDir, [direct]);
			expect(await spawn(broker)).toMatchObject({ ok: false, error: { code: "spawn_failed" } });

			host = await startHost(stateRoot, "correct");
			const endpointMtimeMs = (await fs.stat(path.join(stateRoot, "sdk", `${sessionId}.json`))).mtimeMs;
			const effective = event(
				{
					type: "host_registered",
					sessionId,
					locator,
					endpointGeneration: 1,
					pid: process.pid,
					hostIncarnation,
					endpointMtimeMs,
					endpointFileId: host.endpointFileId,
					masterRole: attestation,
				},
				2,
			);
			await writeIndex(agentDir, [direct, effective]);
			const displacedEndpoint = `${host.endpointPath}.displaced-during-read`;
			let swappedAfterOpen = false;
			try {
				const endpointFile = await readEndpointFile(host.endpointPath, {
					open: async (target, flags) => {
						const handle = await fs.open(target, flags);
						if (!swappedAfterOpen && path.resolve(String(target)) === path.resolve(host!.endpointPath)) {
							swappedAfterOpen = true;
							await fs.rename(host!.endpointPath, displacedEndpoint);
							await fs.writeFile(
								host!.endpointPath,
								JSON.stringify({
									version: 1,
									sessionId,
									pid: process.pid,
									url: "ws://127.0.0.1:1",
									token: "substituted-endpoint-token",
								}),
								{ encoding: "utf8", mode: 0o600 },
							);
						}
						return handle;
					},
				});
				const endpointSource = endpointFile?.source;
				expect(endpointFile).toMatchObject({
					dev: expect.any(BigInt),
					ino: expect.any(BigInt),
					source: expect.stringContaining(host.url),
				});
				expect(JSON.parse(endpointSource ?? "{}")).toMatchObject({ url: host.url, token: host.token });
				expect(swappedAfterOpen).toBe(true);
			} finally {
				await fs.rm(host.endpointPath, { force: true });
				await fs.rename(displacedEndpoint, host.endpointPath);
			}
			expect(await spawn(broker)).toMatchObject({
				ok: true,
				result: { code: "spawn_accepted", seed: { phase: "accepted" } },
			});
			expect(await spawn(broker, "wrong-capability")).toMatchObject({ ok: false, error: { code: "spawn_failed" } });

			host.stop();
			host = await startHost(stateRoot, "replay");
			await fs.utimes(host.endpointPath, effective.endpointMtimeMs! / 1_000, effective.endpointMtimeMs! / 1_000);
			await writeIndex(agentDir, [direct, effective]);
			expect(await spawn(broker)).toMatchObject({ ok: false, error: { code: "spawn_failed" } });

			await writeIndex(agentDir, [direct]);
			expect(await spawn(broker)).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
		} finally {
			host?.stop();
			await broker.stop();
		}
		const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: agentDir, onlyFiles: true }));
		const contents = await Promise.all(files.map(file => Bun.file(path.join(agentDir, file)).text()));
		expect(contents.join("\n")).not.toContain(capability);
		expect(contents.join("\n")).not.toContain(capabilityDigest);
	});
});
