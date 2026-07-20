import { afterAll, expect, test } from "bun:test";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { brokerDiscoveryPath } from "../src/sdk/broker/discovery";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { startFixtureBrokerCommandWithLeaseForTest } from "./helpers/fixture-broker-cleanup";

const fixture = path.resolve(import.meta.dir, "fixtures/sdk-broker-self-reap-entry.ts");
const fixtureExecutableSuffix = process.platform === "win32" ? ".exe" : "";
const compiledFixtureRoot = path.join(process.env.TMPDIR ?? "/tmp", `gjc-broker-compiled-fixtures-${process.pid}`);
const compiledBrokerFixture = path.join(compiledFixtureRoot, `sdk-broker-self-reap-fixture${fixtureExecutableSuffix}`);
const compiledSessionFixture = path.join(
	compiledFixtureRoot,
	`sdk-session-host-self-exit-fixture${fixtureExecutableSuffix}`,
);
let compiledFixturesReady: Promise<void> | undefined;

afterAll(async () => {
	await fs.rm(compiledFixtureRoot, { recursive: true, force: true });
});

async function compileFixture(entrypoint: string, outfile: string): Promise<void> {
	const command = [process.execPath, "build", entrypoint, "--compile", "--outfile", outfile];
	const compile = Bun.spawn(process.platform === "win32" ? command : ["nice", "-n", "19", ...command], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if ((await compile.exited) !== 0) throw new Error(`Failed to compile self-reap fixture: ${entrypoint}`);
}

async function ensureCompiledFixtures(): Promise<void> {
	if (!compiledFixturesReady) {
		compiledFixturesReady = (async () => {
			await fs.mkdir(compiledFixtureRoot, { recursive: true });
			await compileFixture(fixture, compiledBrokerFixture);
			await fs.copyFile(compiledBrokerFixture, compiledSessionFixture);
		})();
	}
	await compiledFixturesReady;
}

async function phase<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`Timed out waiting for ${label}`);
		}),
	]);
}

type FixtureCommand = { file: string; args: string[] };
type FixtureCommandFactory = (root: string) => Promise<FixtureCommand>;

async function assertAuthenticatedFixtureTopology(
	commandForRoot: FixtureCommandFactory,
	options: { coalesceExitWithAccept?: boolean } = {},
): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-self-reap-"));
	const token = randomBytes(32);
	const requestId = randomUUID();
	const markerPath = path.join(root, "non-secret-marker");
	const server = await listen();
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected IPv4 listener address.");
	const expectBye = (candidate: net.Socket): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			candidate.once("data", data => {
				try {
					expect(data.toString("ascii")).toBe("BYE1");
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		});
	let socket: net.Socket | undefined;
	let childExited = false;
	let childExit: Promise<void> | undefined;
	let coalescedAcknowledged: Promise<void> | undefined;
	const connected = new Promise<void>((resolve, reject) => {
		server.once("connection", candidate => {
			socket = candidate;
			childExit = new Promise(resolveExit => {
				candidate.once("end", () => {
					childExited = true;
					resolveExit();
				});
			});
			candidate.once("error", reject);
			candidate.once("data", (hello: Buffer) => {
				const expected = proof(token, "SSH1-hello", requestId);
				try {
					expect(hello.subarray(0, 4).toString("ascii")).toBe("HEL1");
					expect(hello.length).toBe(36);
					expect(timingSafeEqual(hello.subarray(4), expected)).toBe(true);
					const accept = proof(token, "SSH1-accept", requestId);
					if (options.coalesceExitWithAccept) {
						const exit = proof(token, "SSH1-exit", requestId);
						coalescedAcknowledged = expectBye(candidate);
						candidate.write(Buffer.concat([Buffer.from("ACK1"), accept, Buffer.from("EXT1"), exit]));
						exit.fill(0);
					} else {
						candidate.write(Buffer.concat([Buffer.from("ACK1"), accept]));
					}
					accept.fill(0);
					resolve();
				} catch (error) {
					reject(error);
				} finally {
					expected.fill(0);
					hello.fill(0);
				}
			});
		});
	});
	const started = startFixtureBrokerCommandWithLeaseForTest(await commandForRoot(root));
	try {
		const bootstrap = frame("GSF1", {
			requestId,
			port: address.port,
			token: token.toString("base64"),
			markerPath,
		});
		await new Promise<void>((resolve, reject) =>
			started.control.write(bootstrap, error => (error ? reject(error) : resolve())),
		);
		bootstrap.fill(0);
		started.control.end();
		await phase(connected, "authenticated child connection", 10_000);

		// The broker naturally returns after dispatch; this observation is through
		// its exact retained lease, not a child PID recovered from the protocol.
		expect(await started.lease.waitForExit!(2_000)).toBe(true);
		if (options.coalesceExitWithAccept) {
			await phase(coalescedAcknowledged!, "coalesced authenticated child self-exit acknowledgement", 10_000);
		} else {
			expect(childExited).toBe(false);
			expect(socket?.destroyed).toBe(false);
			const exit = proof(token, "SSH1-exit", requestId);
			const acknowledged = expectBye(socket!);
			socket!.write(Buffer.concat([Buffer.from("EXT1"), exit]));
			exit.fill(0);
			await phase(acknowledged, "authenticated child self-exit acknowledgement", 10_000);
		}
		await phase(childExit!, "authenticated child socket close", 5_000);
		expect(childExited).toBe(true);
	} finally {
		token.fill(0);
		(started.control as unknown as { destroy(): void }).destroy();
		await started.lease.terminateExactChild();
		socket?.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function compiledFixtureCommand(root: string): Promise<FixtureCommand> {
	const broker = path.join(root, `sdk-broker-self-reap-fixture${fixtureExecutableSuffix}`);
	const session = path.join(root, `sdk-session-host-self-exit-fixture${fixtureExecutableSuffix}`);
	await ensureCompiledFixtures();
	await Promise.all([fs.copyFile(compiledBrokerFixture, broker), fs.copyFile(compiledSessionFixture, session)]);
	return { file: broker, args: [] };
}
async function expectCompiledBrokerToRejectSibling(broker: string, root: string): Promise<void> {
	const token = randomBytes(32);
	const started = startFixtureBrokerCommandWithLeaseForTest({ file: broker, args: [] });
	try {
		const bootstrap = frame("GSF1", {
			requestId: randomUUID(),
			port: 1,
			token: token.toString("base64"),
			markerPath: path.join(root, "non-secret-marker"),
		});
		await new Promise<void>((resolve, reject) =>
			started.control.write(bootstrap, error => (error ? reject(error) : resolve())),
		);
		bootstrap.fill(0);
		started.control.end();
		expect(await started.lease.waitForExit!(2_000)).toBe(true);
	} finally {
		token.fill(0);
		(started.control as unknown as { destroy(): void }).destroy();
		await started.lease.terminateExactChild();
	}
}

function proof(token: Buffer, domain: string, requestId: string): Buffer {
	return createHmac("sha256", token).update(`${domain}:${requestId}`).digest();
}

function frame(magic: string, value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value));
	const result = Buffer.alloc(8 + body.length);
	result.write(magic, 0, "ascii");
	result.writeUInt32BE(body.length, 4);
	body.copy(result, 8);
	body.fill(0);
	return result;
}

async function listen(): Promise<net.Server> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return server;
}

test.serial(
	"production broker stays warm while owned and self-reaps after durable SDK-root loss",
	async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-owned-root-"));
		const agentDir = path.join(root, "agent");
		const started = await startFixtureBrokerWithLeaseForTest({ agentDir });
		try {
			expect(await started.lease.waitForExit(5_500)).toBe(false);
			await fs.rm(path.join(agentDir, "sdk"), { recursive: true, force: true });
			expect(await started.lease.waitForExit(24_000)).toBe(true);
			await expect(fs.stat(brokerDiscoveryPath(agentDir))).rejects.toMatchObject({ code: "ENOENT" });
			await Bun.sleep(250);
			await expect(fs.stat(path.join(agentDir, "sdk"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await started.lease.terminateExactChild();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	35_000,
);

test.serial(
	"source fixture broker exits naturally while its authenticated child remains alive until self-exit",
	async () => {
		await assertAuthenticatedFixtureTopology(async () => ({ file: process.execPath, args: [fixture] }));
	},
	10_000,
);

test.serial(
	"source fixture preserves an authenticated exit frame coalesced with handshake acceptance",
	async () => {
		await assertAuthenticatedFixtureTopology(async () => ({ file: process.execPath, args: [fixture] }), {
			coalesceExitWithAccept: true,
		});
	},
	10_000,
);

test.serial(
	"builds the compiled broker/session fixture pair outside the lifecycle assertion budget",
	async () => {
		// Keep the CPU-heavy compile out of the shard's short lifecycle/gate test window.
		await Bun.sleep(20_000);
		await ensureCompiledFixtures();
		expect((await fs.stat(compiledBrokerFixture)).isFile()).toBe(true);
		expect((await fs.stat(compiledSessionFixture)).isFile()).toBe(true);
	},
	120_000,
);
test.serial(
	"compiled fixture broker resolves its compiled sibling and preserves authenticated child self-exit",
	async () => {
		await assertAuthenticatedFixtureTopology(compiledFixtureCommand);
	},
	30_000,
);

test.serial(
	"compiled fixture broker fails closed for missing, non-file, and symlink session siblings",
	async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-self-reap-"));
		const { file: broker } = await compiledFixtureCommand(root);
		const session = path.join(root, `sdk-session-host-self-exit-fixture${fixtureExecutableSuffix}`);
		const retainedSession = path.join(root, `retained-session${fixtureExecutableSuffix}`);
		try {
			await fs.rename(session, retainedSession);
			await expectCompiledBrokerToRejectSibling(broker, root);
			await fs.rename(retainedSession, session);

			await fs.rename(session, retainedSession);
			await fs.mkdir(session);
			await expectCompiledBrokerToRejectSibling(broker, root);
			await fs.rmdir(session);
			await fs.rename(retainedSession, session);

			if (process.platform !== "win32") {
				await fs.rename(session, retainedSession);
				await fs.symlink(retainedSession, session);
				await expectCompiledBrokerToRejectSibling(broker, root);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
