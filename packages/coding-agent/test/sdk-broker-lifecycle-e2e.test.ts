import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NotificationServer } from "@gajae-code/natives";
import { openLifecycleSessionManager, runSessionHost } from "../src/commands/sdk";
import { planLaunchWorktree } from "../src/gjc-runtime/launch-worktree";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { Broker, type BrokerCleanupEvidence, type BrokerResponse } from "../src/sdk/broker/broker";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { deriveIdempotencyIdentity } from "../src/sdk/broker/identity";
import {
	deriveLifecycleDeadlines,
	executeLifecycle,
	hasValidLifecycleDeadlines,
	parseDarwinProcessIncarnation,
	processIncarnation,
	setLifecycleCleanupHookForTest,
	setLifecycleCommandResolverForTest,
	setProcessIncarnationForTest,
	writeSessionLifecycleFailure,
} from "../src/sdk/broker/lifecycle";
import { parseLifecycleJson } from "../src/sdk/broker/lifecycle-codec";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { runSdkSessionCli } from "../src/sdk/cli";
import { SdkClient } from "../src/sdk/client";
import { readSdkBrokerDiscovery } from "../src/sdk/client/discovery";
import { createSdkMcpServer } from "../src/sdk/mcp";
import { listManagedSessionCandidates, resolveManagedSessionScope } from "../src/sdk/session-directory";
import { sanitizeSdkStartupMessage } from "../src/sdk/startup-capability";
import { SessionManager } from "../src/session/session-manager";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
const brokerDirs: string[] = [];

afterEach(async () => {
	for (const process of spawned.splice(0)) {
		if (process.exitCode === null) process.kill("SIGTERM");
		await process.exited;
	}
	for (const agentDir of brokerDirs.splice(0)) await brokerOwnerForTest(agentDir)?.stop();
});

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const result = await read();
		if (result !== undefined) return result;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function incarnation(pid: number): Promise<string> {
	const value = processIncarnation(pid);
	if (!value) throw new Error(`Process ${pid} has no readable incarnation.`);
	return value;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

async function snapshotDeleteSurface(
	sessionPath: string,
): Promise<{ transcript: Buffer; artifacts: string | undefined }> {
	const artifactsPath = sessionPath.slice(0, -6);
	const digestTree = async (directory: string): Promise<string> => {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const parts = await Promise.all(
			entries
				.sort((left, right) => left.name.localeCompare(right.name))
				.map(async entry => {
					const entryPath = path.join(directory, entry.name);
					if (entry.isDirectory()) return `d:${entry.name}:${await digestTree(entryPath)}`;
					if (entry.isFile())
						return `f:${entry.name}:${createHash("sha256")
							.update(await fs.readFile(entryPath))
							.digest("hex")}`;

					return `other:${entry.name}`;
				}),
		);
		return createHash("sha256").update(parts.join("\n")).digest("hex");
	};
	return {
		transcript: await fs.readFile(sessionPath),
		artifacts: await digestTree(artifactsPath).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}),
	};
}

test("startup diagnostics redact identifier-prefixed assignment secrets before bounded truncation", () => {
	const secret = "credential-value";
	const message = sanitizeSdkStartupMessage(
		`OPENAI_API_KEY=${secret} GJC_NOTIFICATIONS_TOKEN=${secret} SERVICE-password=${secret} ${"x".repeat(600)}０`,
	);
	expect(message).not.toContain(secret);
	expect(message.match(/\[redacted-secret\]/g)?.length).toBe(3);
	expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(512);
});

test("ledger restart quarantines terminal response and durable-effect digest corruption", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-digest-"));
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		const responseIdentity = "response-digest-corruption";
		await ledger.begin(responseIdentity, "response-request");
		const response = { ok: true, result: { sessionId: responseIdentity } };
		await ledger.transition(responseIdentity, "terminal_ok", { response, responseDigest: "corrupt" });
		const effectsIdentity = "effects-digest-corruption";
		await ledger.begin(effectsIdentity, "effects-request");
		await ledger.transition(effectsIdentity, "terminal_ok", {
			response,
			responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
			durableEffects: {
				worktree: { cwdDigest: "a", created: true, reused: false },
				digest: "corrupt",
			},
		});
		const reopened = await new LifecycleLedger(agentDir).open();
		expect(await reopened.begin(responseIdentity, "response-request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(await reopened.begin(effectsIdentity, "effects-request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl.corrupt"), "utf8")).toContain(
			"digest-corruption",
		);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("fatal lifecycle JSON decoding rejects malformed UTF-8 without mutating valid non-ASCII data", () => {
	const valid = Buffer.from('{"message":"résumé"}', "utf8");
	expect(parseLifecycleJson(valid)).toEqual({ message: "résumé" });
	const malformed = Buffer.concat([Buffer.from('{"message":"ok'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
	expect(() => parseLifecycleJson(malformed)).toThrow();
	expect(valid.equals(Buffer.from('{"message":"résumé"}', "utf8"))).toBe(true);
});

test("ledger reopen bounds malformed persisted rows before they gain cleanup authority", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-bounds-"));
	const ledgerPath = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
	const corruptPath = `${ledgerPath}.corrupt`;
	const cleanupSentinel = path.join(agentDir, "cleanup-sentinel");
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin("safe", "request");
		await fs.writeFile(cleanupSentinel, "preserve");
		const validRow = JSON.parse((await fs.readFile(ledgerPath, "utf8")).trim()) as Record<string, unknown>;
		const malformedUtf8 = Buffer.concat([
			Buffer.from(`${JSON.stringify({ ...validRow, identity: "malformed" }).slice(0, -2)}"`),
			Buffer.from([0xc3, 0x28]),
			Buffer.from("}\n"),
		]);
		await fs.appendFile(ledgerPath, malformedUtf8);
		const malformedBroker = new Broker({ agentDir });
		await malformedBroker.start();
		expect((await malformedBroker.ledger.begin("safe", "request")).kind).toBe("terminal_uncertain");
		await malformedBroker.stop();
		expect(await fs.readFile(cleanupSentinel, "utf8")).toBe("preserve");
		expect((await fs.readFile(corruptPath)).includes(Buffer.from([0xc3, 0x28]))).toBe(true);

		for (const [identity, response] of [
			[
				"deep",
				{
					nested: Array.from({ length: 66 }, () => ({ value: "x" })).reduce(
						(value, _next) => ({ next: value }),
						{},
					),
				},
			],
			[
				"wide",
				{ fields: Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`field-${index}`, index])) },
			],
		] as const) {
			await fs.appendFile(ledgerPath, `${JSON.stringify({ ...validRow, identity, response })}\n`);
		}
		const boundedBroker = new Broker({ agentDir });
		await boundedBroker.start();
		expect((await boundedBroker.ledger.begin("safe", "request")).kind).toBe("terminal_uncertain");
		await boundedBroker.stop();
		expect(await fs.readFile(cleanupSentinel, "utf8")).toBe("preserve");
		const quarantined = await fs.readFile(corruptPath, "utf8");
		expect(quarantined).toContain('"identity":"deep"');
		expect(quarantined).toContain('"identity":"wide"');

		const expectOpenFailure = async (name: string, content: string, message: string) => {
			const boundedAgentDir = path.join(agentDir, name);
			const boundedLedgerPath = path.join(boundedAgentDir, "sdk", "lifecycle-ledger.jsonl");
			await fs.mkdir(path.dirname(boundedLedgerPath), { recursive: true });
			await fs.writeFile(boundedLedgerPath, content);
			await expect(
				new LifecycleLedger(boundedAgentDir, {
					maxLineBytes: 64 * 1024,
					maxBytes: 512 * 1024,
					maxRows: 100,
				}).open(),
			).rejects.toThrow(message);
		};
		await expectOpenFailure("line-bound", "x".repeat(64 * 1024 + 1), "maximum byte length");
		await expectOpenFailure("row-bound", "{}\n".repeat(101), "maximum row count");
		await expectOpenFailure("file-bound", "x".repeat(512 * 1024 + 1), "maximum file byte length");
		expect(await fs.readFile(cleanupSentinel, "utf8")).toBe("preserve");
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 30_000);

test("legacy metadata cleanup rejects mixed lifecycle and arbitrary receipt keys before mutation", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-legacy-metadata-allowlist-"));
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "legacy-allowlist";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const marker = canonicalJson({ pid: process.pid, effectMarker: "legacy", incarnation: "legacy" });
	try {
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(markerPath, marker);
		await fs.writeFile(readyPath, marker);
		const [stat, bytes] = await Promise.all([fs.stat(markerPath, { bigint: true }), fs.readFile(markerPath)]);
		const cleanup: BrokerCleanupEvidence = {
			phase: "metadata",
			sessionId,
			metadataRoot: stateRoot,
			metadataPath: markerPath,
			metadataIdentity: {
				dev: stat.dev.toString(),
				ino: stat.ino.toString(),
				size: Number(stat.size),
				mtimeNs: stat.mtimeNs.toString(),
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			plannedMetadataPath: path.join(stateRoot, "sdk", `.gjc-delete-${sessionId}.lifecycle.json`),
		};
		for (const extra of [{ lifecycleFiles: [] }, { lifecycleDeleteMetadata: true }, { arbitrary: true }]) {
			const outcome = await executeLifecycle(
				new Broker({ agentDir: path.join(root, "agent") }),
				"session.delete",
				{},
				"legacy-allowlist",
				{ ...cleanup, ...extra } as BrokerCleanupEvidence,
			);
			expect(outcome.response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(await fs.readFile(markerPath, "utf8")).toBe(marker);
			expect(await fs.readFile(readyPath, "utf8")).toBe(marker);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function stopDiscoveredBroker(agentDir: string): Promise<void> {
	const discovery = await readSdkBrokerDiscovery(agentDir);
	if (!discovery) return;
	const stillOwned = (): boolean => processIncarnation(discovery.pid) === discovery.incarnation;
	const waitForExit = async (timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (stillOwned() && Date.now() < deadline) await Bun.sleep(10);
		return !stillOwned();
	};
	if (!stillOwned()) return;
	process.kill(discovery.pid, "SIGTERM");
	if (await waitForExit(2_000)) return;
	if (!stillOwned()) return;
	process.kill(discovery.pid, "SIGKILL");
	if (!(await waitForExit(2_000))) throw new Error(`Test broker ${discovery.pid} did not exit after SIGKILL.`);
}

async function liveLifecycleSession(root: string, agentDir: string, sessionId: string, staleMarkerFirst = false) {
	const stateRoot = path.join(root, ".gjc", "state");
	const request = {
		operation: "session.create",
		sessionId,
		cwd: root,
		stateRoot,
		effectMarker: "subprocess-proof",
		...deriveLifecycleDeadlines(Date.now(), 10_000),
	} as const;
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "sdk", "session-host-internal"], {
		cwd: root,
		env: {
			...process.env,
			HOME: root,
			GJC_AGENT_DIR: agentDir,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_SESSION_ID: sessionId,
			GJC_LIFECYCLE_REQUEST_ID: "subprocess-proof",
			GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify(request),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	spawned.push(child);
	if (!child.pid) throw new Error("session host has no pid");
	const childIncarnation = await incarnation(child.pid);
	await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
	if (staleMarkerFirst) {
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
			JSON.stringify({ pid: child.pid, effectMarker: "stale-effect", incarnation: childIncarnation }),
		);
		await Bun.sleep(25);
	}
	await fs.writeFile(
		path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
		JSON.stringify({ pid: child.pid, effectMarker: "subprocess-proof", incarnation: childIncarnation }),
	);
	try {
		const endpoint = await waitFor(async () => {
			try {
				return JSON.parse(await fs.readFile(path.join(stateRoot, "sdk", `${sessionId}.json`), "utf8")) as {
					url: string;
					token: string;
				};
			} catch {
				return undefined;
			}
		}, "session endpoint");
		return { child, endpoint };
	} catch (error) {
		if (child.exitCode === null) child.kill("SIGTERM");
		await child.exited;
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; child exit=${child.exitCode}; stdout=${await new Response(child.stdout).text()}; stderr=${await new Response(child.stderr).text()}`,
		);
	}
}

test("lifecycle child ignores a stale marker until its current effect marker replaces it", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-marker-"));
	const agentDir = path.join(root, "agent");
	try {
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, "stale-marker", true);
		expect(endpoint.url).toStartWith("ws://");
		child.kill("SIGTERM");
		await child.exited;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("lifecycle host rejects a transcript replaced after strict authorization before it can be consumed", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-transcript-race-"));
	const agentDir = path.join(root, "agent");
	const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
	try {
		await session.ensureOnDisk();
		const sessionPath = session.getSessionFile();
		if (!sessionPath) throw new Error("Expected saved session path.");
		const inventory = SessionManager.inventorySessionsStrict(root, {
			sessionDir: SessionManager.getDefaultSessionDir(root, agentDir),
		});
		if (inventory.kind !== "complete") throw new Error("Expected strict session inventory.");
		const candidate = inventory.candidates.find(item => item.path === sessionPath);
		if (!candidate) throw new Error("Expected strict session candidate.");
		const replacementPath = `${sessionPath}.replacement`;
		await fs.writeFile(replacementPath, `${await fs.readFile(sessionPath, "utf8")}\n`);
		const originalCapture = SessionManager.captureTranscriptStrict;
		let replaced = false;
		const replaceAfterAuthorization: typeof SessionManager.captureTranscriptStrict = (filePath, storage) => {
			const result = originalCapture(filePath, storage);
			if (!replaced) {
				replaced = true;
				renameSync(replacementPath, sessionPath);
			}
			return result;
		};
		SessionManager.captureTranscriptStrict = replaceAfterAuthorization;
		const authorizedDigest = createHash("sha256")
			.update(await fs.readFile(sessionPath))
			.digest("hex");
		try {
			await expect(
				openLifecycleSessionManager(
					{
						operation: "session.resume",
						sessionId: candidate.id,
						cwd: root,
						stateRoot: path.join(root, ".gjc", "state"),
						sessionPath,
						...deriveLifecycleDeadlines(Date.now(), 4_000),
						sessionIdentity: {
							dev: candidate.identity.dev.toString(),
							ino: candidate.identity.ino.toString(),
							size: candidate.identity.size,
							mtimeMs: candidate.identity.mtimeMs,
							mtimeNs: candidate.identity.mtimeNs.toString(),
							sha256: authorizedDigest,
						},
					},
					root,
					agentDir,
				),
			).rejects.toThrow("Lifecycle saved session authority changed while the session host opened it.");
			expect(replaced).toBe(true);
		} finally {
			SessionManager.captureTranscriptStrict = originalCapture;
		}
	} finally {
		await session.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("lifecycle fork rejects a source replaced after capture without destination residue", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-fork-race-"));
	const agentDir = path.join(root, "agent");
	const sourceCwd = path.join(root, "source");
	const targetCwd = path.join(root, "target");
	await fs.mkdir(sourceCwd, { recursive: true });
	await fs.mkdir(targetCwd, { recursive: true });
	const source = SessionManager.create(sourceCwd, SessionManager.getDefaultSessionDir(sourceCwd, agentDir));
	try {
		await source.ensureOnDisk();
		const sourcePath = source.getSessionFile();
		if (!sourcePath) throw new Error("Expected saved source session path.");
		const inventory = SessionManager.inventorySessionsStrict(sourceCwd, {
			sessionDir: SessionManager.getDefaultSessionDir(sourceCwd, agentDir),
		});
		if (inventory.kind !== "complete") throw new Error("Expected strict source session inventory.");
		const candidate = inventory.candidates.find(item => item.path === sourcePath);
		if (!candidate) throw new Error("Expected strict source session candidate.");
		const replacementPath = `${sourcePath}.replacement`;
		await fs.writeFile(replacementPath, await fs.readFile(sourcePath));
		const destinationSessionDir = SessionManager.getDefaultSessionDirReadOnly(targetCwd, agentDir);
		const originalCapture = SessionManager.captureTranscriptStrict;
		let replaced = false;
		const replaceAfterCapture: typeof SessionManager.captureTranscriptStrict = (filePath, storage) => {
			const captured = originalCapture(filePath, storage);
			if (!replaced && filePath === sourcePath && captured.kind === "captured") {
				replaced = true;
				renameSync(replacementPath, sourcePath);
			}
			return captured;
		};
		SessionManager.captureTranscriptStrict = replaceAfterCapture;
		const sourceDigest = createHash("sha256")
			.update(await fs.readFile(sourcePath))
			.digest("hex");
		try {
			await expect(
				openLifecycleSessionManager(
					{
						operation: "session.fork",
						sessionId: "fork-destination",
						cwd: targetCwd,
						stateRoot: path.join(targetCwd, ".gjc", "state"),
						...deriveLifecycleDeadlines(Date.now(), 4_000),
						sourceCwd,
						sourceSessionId: candidate.id,
						sourceSessionPath: sourcePath,
						sourceSessionIdentity: {
							dev: candidate.identity.dev.toString(),
							ino: candidate.identity.ino.toString(),
							size: candidate.identity.size,
							mtimeMs: candidate.identity.mtimeMs,
							mtimeNs: candidate.identity.mtimeNs.toString(),
							sha256: sourceDigest,
						},
					},
					targetCwd,
					agentDir,
				),
			).rejects.toThrow("Lifecycle saved session authority changed while the session host forked it.");
			expect(replaced).toBe(true);
			const initializedEntries = await fs.readdir(destinationSessionDir);
			expect(initializedEntries).toContain(".gjc-managed-session-scope.v2.json");
			expect(initializedEntries.filter(entry => entry.endsWith(".jsonl"))).toEqual([]);
		} finally {
			SessionManager.captureTranscriptStrict = originalCapture;
		}
	} finally {
		await source.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker derives and validates the exact five-timestamp lifecycle windows", () => {
	const receivedAt = 1_000_000;
	const deadlines = deriveLifecycleDeadlines(receivedAt, 4_000);
	expect(deadlines).toEqual({
		receivedAt,
		requestedReadinessTimeoutMs: 4_000,
		semanticReadyDeadlineAt: receivedAt + 2_000,
		terminationStartDeadlineAt: receivedAt + 3_000,
		lifecycleCleanupDeadlineAt: receivedAt + 4_000,
	});
	expect(hasValidLifecycleDeadlines(deadlines, receivedAt)).toBe(true);
	expect(
		hasValidLifecycleDeadlines(
			{ ...deadlines, terminationStartDeadlineAt: deadlines.terminationStartDeadlineAt - 1 },
			receivedAt,
		),
	).toBe(false);
	expect(() => deriveLifecycleDeadlines(receivedAt, 3_999)).toThrow();
	expect(() => deriveLifecycleDeadlines(Number.MAX_SAFE_INTEGER, 4_000)).toThrow("overflow");
	expect(
		hasValidLifecycleDeadlines({ ...deadlines, lifecycleCleanupDeadlineAt: Number.MAX_SAFE_INTEGER }, receivedAt),
	).toBe(false);
});

test("session host exact cutoff writes proven pre-session absence", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-exact-cutoff-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "exact-cutoff";
	const effectMarker = "exact-cutoff-marker";
	const deadlines = deriveLifecycleDeadlines(1_000, 4_000);
	const names = ["GJC_AGENT_DIR", "GJC_STATE_ROOT", "GJC_LIFECYCLE_REQUEST_ID", "GJC_SDK_LIFECYCLE_REQUEST"] as const;
	const previous = names.map(name => process.env[name]);
	try {
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
			JSON.stringify({ pid: process.pid, effectMarker, incarnation: "test-incarnation" }),
		);
		process.env.GJC_AGENT_DIR = agentDir;
		process.env.GJC_STATE_ROOT = stateRoot;
		process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
		process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify({
			operation: "session.create",
			sessionId,
			cwd: root,
			stateRoot,
			effectMarker,
			...deadlines,
		});
		await expect(
			runSessionHost({
				now: () => deadlines.semanticReadyDeadlineAt,
				sleep: async () => {},
				cwd: root,
				processIncarnation: () => "test-incarnation",
			}),
		).rejects.toThrow("readiness cutoff");
		const artifact = JSON.parse(
			await fs.readFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.failure.${effectMarker}.json`), "utf8"),
		) as { rollback: Record<string, unknown>; reason: string };
		expect(artifact.reason).toBe("pending");
		expect(artifact.rollback).toEqual({
			endpointGeneration: null,
			fenced: true,
			runtimeRemoved: true,
			hostStopped: true,
			brokerRegistrationReleased: true,
		});
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("startup failure artifacts reject symlink and oversize collisions while accepting byte-identical owner evidence", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-artifact-"));
	const id = "artifact-session";
	const marker = "artifact-marker";
	const artifactPath = path.join(root, "sdk", `${id}.lifecycle.failure.${marker}.json`);
	const rollback = {
		endpointGeneration: 1,
		fenced: true,
		runtimeRemoved: true,
		hostStopped: true,
		brokerRegistrationReleased: true,
	};
	try {
		await writeSessionLifecycleFailure(
			root,
			id,
			marker,
			{ phase: "startup", reason: "failed", message: "owned startup failure" },
			rollback,
		);

		const original = await fs.readFile(artifactPath);
		await writeSessionLifecycleFailure(
			root,
			id,
			marker,
			{ phase: "startup", reason: "failed", message: "owned startup failure" },
			rollback,
		);

		expect(await fs.readFile(artifactPath)).toEqual(original);
		expect((await fs.stat(artifactPath)).mode & 0o777).toBe(0o600);

		await fs.rm(artifactPath);
		await fs.symlink(path.join(root, "missing"), artifactPath);
		await expect(
			writeSessionLifecycleFailure(
				root,
				id,
				marker,
				{ phase: "startup", reason: "failed", message: "owned startup failure" },
				rollback,
			),
		).rejects.toThrow();

		await fs.rm(artifactPath);
		await fs.writeFile(artifactPath, "x".repeat(4097));
		await expect(
			writeSessionLifecycleFailure(
				root,
				id,
				marker,
				{ phase: "startup", reason: "failed", message: "owned startup failure" },
				rollback,
			),
		).rejects.toThrow();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker parses Darwin kernel process start timestamps with microsecond precision", () => {
	const bsdInfo = new Uint8Array(136);
	const view = new DataView(bsdInfo.buffer);
	view.setBigUint64(120, 1_700_000_000n, true);
	view.setBigUint64(128, 123_456n, true);
	const sameSecondSuccessor = new Uint8Array(bsdInfo);
	new DataView(sameSecondSuccessor.buffer).setBigUint64(128, 123_457n, true);
	expect(parseDarwinProcessIncarnation(bsdInfo)).toBe("darwin:1700000000:123456");
	expect(parseDarwinProcessIncarnation(sameSecondSuccessor)).toBe("darwin:1700000000:123457");
});
test("broker reads Windows process incarnations as canonical FILETIME ticks with 100ns continuity", () => {
	let invoked = false;
	const result = processIncarnation(4_242, {
		platform: "win32",
		runCommand(command, args) {
			invoked = true;
			expect(command).toBe("powershell.exe");
			expect(args).toEqual([
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$ErrorActionPreference = 'Stop'; $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $process = Get-Process -Id 4242 -ErrorAction Stop; $filetime = [UInt64]($process.StartTime.ToUniversalTime().ToFileTimeUtc()); [Console]::Out.WriteLine((\"{0}`t{1}\" -f $process.Id, $filetime))",
			]);
			return { exitCode: 0, stdout: "4242\t133830291061234567\r\n" };
		},
	});
	expect(invoked).toBe(true);
	expect(result).toBe("windows:133830291061234567");
	expect(
		processIncarnation(4_242, {
			platform: "win32",
			runCommand: () => ({ exitCode: 0, stdout: "4242\t133830291061234568\n" }),
		}),
	).toBe("windows:133830291061234568");
});

test("broker fails closed for failed or malformed Windows FILETIME process-incarnation output", () => {
	const options = {
		platform: "win32" as const,
		runCommand: () => ({ exitCode: 1, stdout: "4242\t133830291061234567\n" }),
	};
	expect(processIncarnation(4_242, options)).toBeUndefined();
	expect(
		processIncarnation(4_242, {
			platform: "win32",
			runCommand() {
				throw new Error("PowerShell unavailable");
			},
		}),
	).toBeUndefined();
	for (const stdout of [
		"",
		"4242\t-1\n",
		"4242\t0133830291061234567\n",
		"4242\t18446744073709551616\n",
		"4243\t133830291061234567\n",
		"4242\t133830291061234567\r",
		"4242\t133830291061234567\n\n",
	]) {
		expect(
			processIncarnation(4_242, {
				platform: "win32",
				runCommand: () => ({ exitCode: 0, stdout }),
			}),
		).toBeUndefined();
	}
});

test("broker bounds a hanging WebSocket upgrade by the lifecycle deadline and cleans its child", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-hanging-upgrade-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const fixture = path.join(agentDir, "hanging-upgrade.js");
	const fixturePidPath = path.join(agentDir, "hanging-upgrade.pid");
	const fixtureRequestPath = path.join(agentDir, "hanging-upgrade.request.json");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const previousUrl = process.env.GJC_HANGING_UPGRADE_URL;
	const hangingUpgrade = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Promise.withResolvers<Response>().promise;
		},
	});
	const broker = new Broker({ agentDir });
	let fixturePid: number | undefined;
	try {
		await fs.writeFile(
			fixture,
			`
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=process.env.GJC_STATE_ROOT, id=process.env.GJC_SESSION_ID, agent=process.env.GJC_AGENT_DIR;
fs.mkdirSync(path.join(root,'sdk'),{recursive:true});
fs.writeFileSync(${JSON.stringify(fixturePidPath)},String(process.pid));
fs.writeFileSync(${JSON.stringify(fixtureRequestPath)},process.env.GJC_SDK_LIFECYCLE_REQUEST);
const endpoint=path.join(root,'sdk',id+'.json');
fs.writeFileSync(endpoint,JSON.stringify({sessionId:id,pid:process.pid,url:process.env.GJC_HANGING_UPGRADE_URL,token:'hang'}));
const m=fs.statSync(endpoint).mtimeMs;
const log=path.join(agent,'sdk','sessions','index.jsonl');fs.mkdirSync(path.dirname(log),{recursive:true});const indexSeq=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length+1:1;
const event={type:'host_registered',sessionId:id,locator:{repo:agent,stateRoot:root},endpointGeneration:1,pid:process.pid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
event.checksum=crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');fs.appendFileSync(log,JSON.stringify(event)+'\\n');
setInterval(()=>{},1000);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		process.env.GJC_HANGING_UPGRADE_URL = `ws://127.0.0.1:${hangingUpgrade.port}`;
		await broker.start();
		const started = Date.now();
		const lifecycle = broker.handleRequest(
			"session.create",
			{ cwd: agentDir, stateRoot, readinessTimeoutMs: 4_000 },
			"hanging-upgrade",
		);
		const request = await waitFor(async () => {
			try {
				return JSON.parse(await fs.readFile(fixtureRequestPath, "utf8")) as {
					effectMarker?: string;
					sessionId?: string;
				};
			} catch {
				return undefined;
			}
		}, "hanging-upgrade lifecycle request");
		fixturePid = Number(await fs.readFile(fixturePidPath, "utf8"));
		const incarnation = processIncarnation(fixturePid);
		if (!incarnation || !request.effectMarker || !request.sessionId)
			throw new Error("Expected a durable lifecycle child identity.");
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${request.sessionId}.lifecycle.ready.json`),
			JSON.stringify({ pid: fixturePid, effectMarker: request.effectMarker, incarnation }),
		);
		expect(await lifecycle).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(() => process.kill(fixturePid!, 0)).toThrow();
	} finally {
		if (fixturePid) {
			try {
				process.kill(fixturePid, "SIGKILL");
			} catch {}
		}
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		if (previousUrl === undefined) delete process.env.GJC_HANGING_UPGRADE_URL;
		else process.env.GJC_HANGING_UPGRADE_URL = previousUrl;
		hangingUpgrade.stop(true);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 10_000);

test("broker rejects an endpoint-only lifecycle child that never authenticates session_ready", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-life-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const fixture = path.join(agentDir, "fixture.js");
	await fs.writeFile(
		fixture,
		`
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=process.env.GJC_STATE_ROOT, id=process.env.GJC_SESSION_ID, agent=process.env.GJC_AGENT_DIR;
fs.mkdirSync(path.join(root,'sdk'),{recursive:true});
fs.writeFileSync(path.join(agent,'fixture.pid'),String(process.pid));
fs.writeFileSync(path.join(agent,'fixture.request.json'),process.env.GJC_SDK_LIFECYCLE_REQUEST);

fs.writeFileSync(path.join(root,'sdk',id+'.json'),JSON.stringify({sessionId:id,pid:process.pid,url:'ws://127.0.0.1:1',token:'fake'}));
const m=fs.statSync(path.join(root,'sdk',id+'.json')).mtimeMs;
const log=path.join(agent,'sdk','sessions','index.jsonl');fs.mkdirSync(path.dirname(log),{recursive:true});const indexSeq=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length+1:1;
const event={type:'host_registered',sessionId:id,locator:{repo:'fixture',stateRoot:root},endpointGeneration:1,pid:process.pid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
event.checksum=crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');fs.appendFileSync(log,JSON.stringify(event)+'\\n');
setInterval(()=>{},1000);
`,
	);
	const previous = process.env.GJC_SDK_SESSION_COMMAND;
	process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const started = Date.now();
		const [first, second] = await Promise.all([
			broker.handleRequest(
				"session.create",
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 4_000, body: "first", modelPreset: "codex-eco" },
				"create-1",
			),
			broker.handleRequest(
				"session.create",
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 4_000, body: "second", modelPreset: "codex-eco" },
				"create-2",
			),
		]);
		expect(first).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(second).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(Date.now() - started).toBeGreaterThanOrEqual(500);
		const fixturePid = Number(await fs.readFile(path.join(agentDir, "fixture.pid"), "utf8"));
		expect(() => process.kill(fixturePid, 0)).toThrow();
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "fixture.request.json"), "utf8"))).toMatchObject({
			cwd: agentDir,
			modelPreset: "codex-eco",
		});
		expect(
			(await fs.readdir(path.join(stateRoot, "sdk"))).filter(name => name.endsWith(".json")).length,
		).toBeGreaterThan(0);
		const listed = await broker.handleRequest("session.list", {});
		expect(listed.ok).toBe(true);
		if (!listed.ok) throw new Error(listed.error.message);
		expect(JSON.stringify(listed.result)).toContain('"terminalUncertain":true');
	} finally {
		await broker.stop();
		process.env.GJC_SDK_SESSION_COMMAND = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 15_000);

test("broker rejects a cross-workspace cold fork source before spawning", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-cross-workspace-"));
	const agentDir = path.join(root, "agent");
	const sourceCwd = path.join(root, "source");
	const targetCwd = path.join(root, "target");
	const fixture = path.join(root, "spawned.js");
	const spawnedPath = path.join(root, "spawned");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.mkdir(sourceCwd, { recursive: true });
		await fs.mkdir(targetCwd, { recursive: true });
		const source = SessionManager.create(sourceCwd, SessionManager.getDefaultSessionDir(sourceCwd, agentDir));
		await source.ensureOnDisk();
		const sourcePath = source.getSessionFile();
		if (!sourcePath) throw new Error("Expected source session path.");
		await fs.writeFile(
			fixture,
			`require("fs").writeFileSync(${JSON.stringify(spawnedPath)}, "spawned"); setInterval(() => {}, 1000);`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		expect(
			await broker.handleRequest(
				"session.fork",
				{
					cwd: targetCwd,
					stateRoot: path.join(targetCwd, ".gjc", "state"),
					sourceSessionId: source.getSessionId(),
					sourceSessionPath: sourcePath,
				},
				"cross-workspace-fork",
			),
		).toEqual({
			ok: false,
			error: {
				code: "invalid_input",
				message: "Source saved session does not match the requested workspace and session id.",
			},
		});
		await expect(fs.stat(spawnedPath)).rejects.toThrow();
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker rejects duplicate owned source candidates before spawning", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-duplicate-owned-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const spawnedPath = path.join(root, "spawned");
	const command = path.join(root, "spawned.js");
	const broker = new Broker({ agentDir });
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const previousRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	const previousSessionId = process.env.GJC_SESSION_ID;
	try {
		const scopeResult = await resolveManagedSessionScope({ cwd: root, agentDir });
		expect(scopeResult.kind).toBe("resolved");
		if (scopeResult.kind !== "resolved") throw new Error(scopeResult.message);
		const createDuplicate = async (suffix: string) => {
			process.env.GJC_LIFECYCLE_REQUEST_ID = `duplicate-prepare-${suffix}`;
			process.env.GJC_SESSION_ID = "duplicate-owned-source";
			const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
			await session.ensureOnDisk();
			const sourcePath = session.getSessionFile();
			if (!sourcePath) throw new Error("Expected duplicate owned source path.");
			const duplicatePath = path.join(scopeResult.scope.directoryPath, `duplicate-${suffix}.jsonl`);
			await fs.rename(sourcePath, duplicatePath);
			return { path: duplicatePath, bytes: await fs.readFile(duplicatePath) };
		};
		const first = await createDuplicate("a");
		const second = await createDuplicate("b");
		delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		delete process.env.GJC_SESSION_ID;
		const inventory = await listManagedSessionCandidates({ scope: scopeResult.scope });
		expect(inventory.kind).toBe("complete");
		if (inventory.kind !== "complete") throw new Error(inventory.message);
		expect(inventory.owned.filter(candidate => candidate.sessionId === "duplicate-owned-source")).toHaveLength(2);
		const candidatePathsBefore = inventory.owned.map(candidate => candidate.path).sort();
		const ledgerRowsBefore = (
			await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "")
		)
			.split("\n")
			.filter(Boolean);
		await fs.writeFile(
			command,
			`require("fs").writeFileSync(${JSON.stringify(spawnedPath)}, "spawned"); setInterval(() => {}, 1000);`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${command}`;
		await broker.start();
		expect(
			await broker.handleRequest(
				"session.fork",
				{ cwd: root, stateRoot, sourceSessionId: "duplicate-owned-source" },
				"duplicate-owned-source-request",
			),
		).toEqual({
			ok: false,
			error: {
				code: "invalid_input",
				message: "Source saved session does not match the requested workspace and session id.",
			},
		});
		await expect(fs.access(spawnedPath)).rejects.toThrow();
		expect(await fs.readFile(first.path)).toEqual(first.bytes);
		expect(await fs.readFile(second.path)).toEqual(second.bytes);
		await expect(fs.access(path.join(stateRoot, "sdk", "duplicate-owned-source.json"))).rejects.toThrow();
		await expect(fs.access(path.join(stateRoot, "sdk", "duplicate-owned-source.lifecycle.json"))).rejects.toThrow();
		const afterInventory = await listManagedSessionCandidates({ scope: scopeResult.scope });
		expect(afterInventory.kind).toBe("complete");
		if (afterInventory.kind !== "complete") throw new Error(afterInventory.message);
		expect(afterInventory.owned.map(candidate => candidate.path).sort()).toEqual(candidatePathsBefore);
		const ledgerRowsAfter = (
			await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8").catch(() => "")
		)
			.split("\n")
			.filter(Boolean)
			.slice(ledgerRowsBefore.length)
			.map(line => JSON.parse(line) as { state?: string });
		expect(ledgerRowsAfter.some(row => row.state === "effect_started")).toBe(false);
		const registrations = (await new SessionIndex(agentDir).open())
			.listSessions()
			.sessions.filter(session => session.sessionId === "duplicate-owned-source");
		expect(registrations).toHaveLength(0);
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		if (previousRequestId === undefined) delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		else process.env.GJC_LIFECYCLE_REQUEST_ID = previousRequestId;
		if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = previousSessionId;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker directly resumes and forks a canonical cold saved session with scoped cleanup", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-canonical-cold-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const broker = new Broker({ agentDir });
	try {
		const scopeResult = await resolveManagedSessionScope({ cwd: root, agentDir });
		expect(scopeResult.kind).toBe("resolved");
		if (scopeResult.kind !== "resolved") throw new Error(scopeResult.message);
		const sourceDir = SessionManager.getDefaultSessionDir(root, agentDir);
		expect(sourceDir).toBe(scopeResult.scope.directoryPath);
		const source = SessionManager.create(root, sourceDir);
		await source.ensureOnDisk();
		const sourceId = source.getSessionId();
		const sourcePath = source.getSessionFile();
		if (!sourcePath) throw new Error("Expected canonical saved source path.");
		const assertCanonicalSource = async () => {
			const inventory = await listManagedSessionCandidates({ scope: scopeResult.scope });
			expect(inventory.kind).toBe("complete");
			if (inventory.kind !== "complete") throw new Error(inventory.message);
			const candidates = inventory.owned.filter(
				candidate => candidate.sessionId === sourceId && candidate.path === sourcePath,
			);
			expect(candidates).toHaveLength(1);
			expect(path.dirname(candidates[0]!.path)).toBe(scopeResult.scope.directoryPath);
			return candidates[0]!;
		};
		const sourceCandidate = await assertCanonicalSource();
		await broker.start();
		const resumed = await broker.handleRequest(
			"session.resume",
			{ cwd: root, stateRoot, sessionId: sourceId, sessionPath: sourcePath },
			"canonical-cold-resume",
		);
		expect(resumed).toMatchObject({ ok: true, result: { sessionId: sourceId } });
		const resumedSourceCandidate = await assertCanonicalSource();
		expect(resumedSourceCandidate.identity).toMatchObject({ canonicalPath: sourcePath, sessionId: sourceId });
		expect(resumedSourceCandidate.identity).not.toEqual(sourceCandidate.identity);
		expect(
			await broker.handleRequest("session.close", { sessionId: sourceId }, "canonical-cold-resume-close"),
		).toMatchObject({
			ok: true,
			result: { sessionId: sourceId },
		});
		await waitFor(
			async () =>
				(await fs.access(path.join(stateRoot, "sdk", `${sourceId}.json`)).then(
					() => false,
					() => true,
				))
					? true
					: undefined,
			"canonical resume endpoint cleanup",
		);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${sourceId}.lifecycle.json`)).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${sourceId}.lifecycle.ready.json`)).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: sourceId })).toMatchObject({
			ok: false,
			error: { code: "resource_gone" },
		});
		const resumedSourceBytes = await fs.readFile(sourcePath);

		const forkSourceCandidate = await assertCanonicalSource();

		const forked = await broker.handleRequest(
			"session.fork",
			{ cwd: root, stateRoot, sourceSessionId: sourceId, sourceSessionPath: sourcePath },
			"canonical-cold-fork",
		);
		expect(forked).toMatchObject({ ok: true });
		if (!forked.ok) throw new Error(forked.error.message);
		const forkResult = forked.result as { sessionId?: unknown };
		const forkId = String(forkResult.sessionId);
		expect(forkId).not.toBe(sourceId);
		const inventory = await listManagedSessionCandidates({ scope: scopeResult.scope });
		expect(inventory.kind).toBe("complete");
		if (inventory.kind !== "complete") throw new Error(inventory.message);
		const forkCandidates = inventory.owned.filter(candidate => candidate.sessionId === forkId);
		expect(forkCandidates).toHaveLength(1);
		const forkCandidate = forkCandidates[0]!;
		expect(path.dirname(forkCandidate.path)).toBe(scopeResult.scope.directoryPath);
		expect(forkCandidate.identity.sessionId).toBe(forkId);
		expect(
			await broker.handleRequest("session.close", { sessionId: forkId }, "canonical-cold-fork-close"),
		).toMatchObject({
			ok: true,
			result: { sessionId: forkId },
		});
		await waitFor(
			async () =>
				(await fs.access(path.join(stateRoot, "sdk", `${forkId}.json`)).then(
					() => false,
					() => true,
				))
					? true
					: undefined,
			"canonical fork endpoint cleanup",
		);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${forkId}.lifecycle.json`)).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${forkId}.lifecycle.ready.json`)).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: forkId })).toMatchObject({
			ok: false,
			error: { code: "resource_gone" },
		});
		expect(
			await broker.handleRequest(
				"session.delete",
				{ cwd: root, stateRoot, sessionId: forkId, sessionPath: forkCandidate.path },
				"canonical-cold-fork-delete",
			),
		).toMatchObject({ ok: true, result: { sessionId: forkId } });
		expect(
			await fs.access(forkCandidate.path).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${forkId}.lifecycle.json`)).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${forkId}.lifecycle.ready.json`)).then(
				() => true,
				() => false,
			),
		).toBe(false);
		const afterDelete = await listManagedSessionCandidates({ scope: scopeResult.scope });
		expect(afterDelete.kind).toBe("complete");
		if (afterDelete.kind !== "complete") throw new Error(afterDelete.message);
		expect(afterDelete.owned.some(candidate => candidate.sessionId === forkId)).toBe(false);
		expect(await fs.readFile(sourcePath)).toEqual(resumedSourceBytes);
		expect((await assertCanonicalSource()).identity).toEqual(forkSourceCandidate.identity);
		expect(
			await broker.handleRequest(
				"session.delete",
				{ cwd: root, stateRoot, sessionId: sourceId, sessionPath: sourcePath },
				"canonical-cold-resume-delete",
			),
		).toMatchObject({ ok: true, result: { sessionId: sourceId } });
		expect(
			await fs.access(sourcePath).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${sourceId}.lifecycle.json`)).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(path.join(stateRoot, "sdk", `${sourceId}.lifecycle.ready.json`)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("broker replays one identity-bound lifecycle metadata cleanup plan after the first delete detach", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-delete-metadata-crash-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const saved = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
	let crashing: Broker | undefined;
	let reopened: Broker | undefined;
	try {
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted delete transcript.");
		await saved.close();

		crashing = new Broker({ agentDir });
		await crashing.start();
		await expect(
			crashing.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"delete-metadata-resume",
			),
		).resolves.toMatchObject({ ok: true, result: { sessionId } });
		await expect(
			crashing.handleRequest("session.close", { sessionId }, "delete-metadata-close"),
		).resolves.toMatchObject({
			ok: true,
			result: { sessionId },
		});
		await waitFor(
			async () =>
				(await fs.access(path.join(stateRoot, "sdk", `${sessionId}.json`)).then(
					() => false,
					() => true,
				))
					? true
					: undefined,
			"delete metadata endpoint cleanup",
		);
		const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
		const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
		await expect(fs.stat(markerPath)).resolves.toBeDefined();
		await expect(fs.stat(readyPath)).resolves.toBeDefined();
		setLifecycleCleanupHookForTest(crashing, () => {
			throw new Error("simulated crash after first delete metadata detach");
		});
		const deleteInput = { cwd: root, stateRoot, sessionId, sessionPath };
		await expect(crashing.handleRequest("session.delete", deleteInput, "delete-metadata-crash")).rejects.toThrow(
			"simulated crash after first delete metadata detach",
		);
		const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const persisted = rows.findLast(row => row.state === "effect_started");
		const cleanup = (
			persisted?.response as { error?: { cleanup?: { phase?: unknown; lifecycleFiles?: unknown[] } } } | undefined
		)?.error?.cleanup;
		expect(cleanup).toMatchObject({ phase: "lifecycle" });
		expect(cleanup?.lifecycleFiles).toHaveLength(2);
		expect(cleanup?.lifecycleFiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: markerPath, identity: expect.any(Object) }),
				expect.objectContaining({ path: readyPath, identity: expect.any(Object) }),
			]),
		);
		await expect(fs.stat(markerPath)).rejects.toThrow();
		await expect(fs.stat(readyPath)).resolves.toBeDefined();

		await crashing.stop();
		crashing = undefined;
		reopened = new Broker({ agentDir });
		await reopened.start();
		await expect(
			reopened.handleRequest("session.delete", deleteInput, "delete-metadata-crash"),
		).resolves.toMatchObject({
			ok: true,
			result: { sessionId },
		});
		await expect(fs.stat(markerPath)).rejects.toThrow();
		await expect(fs.stat(readyPath)).rejects.toThrow();
	} finally {
		await crashing?.stop();
		await reopened?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("broker uses incarnation-aware observations before fresh lifecycle metadata cleanup", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-delete-incarnation-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		for (const [name, observedIncarnation, expectedOk] of [
			["reused", "replacement-incarnation", true],
			["matching", "closed-incarnation", false],
			["unreadable", undefined, false],
		] as const) {
			const saved = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
			await saved.ensureOnDisk();
			const sessionId = saved.getSessionId();
			const sessionPath = saved.getSessionFile();
			if (!sessionPath) throw new Error("Expected persisted delete transcript.");
			await saved.close();
			const marker = {
				pid: process.pid,
				effectMarker: `closed-${name}`,
				incarnation: "closed-incarnation",
			};
			const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
			const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
			await fs.mkdir(path.dirname(markerPath), { recursive: true });
			await Promise.all([
				fs.writeFile(markerPath, canonicalJson(marker)),
				fs.writeFile(readyPath, canonicalJson(marker)),
			]);
			expect(() => process.kill(marker.pid, 0)).not.toThrow();
			const surfaceBeforeDelete = await snapshotDeleteSurface(sessionPath);
			setProcessIncarnationForTest(broker, () => observedIncarnation);
			const result = await broker.handleRequest(
				"session.delete",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				`delete-incarnation-${name}`,
			);
			if (expectedOk) {
				expect(result).toMatchObject({ ok: true, result: { sessionId } });
				await expect(fs.stat(sessionPath)).rejects.toThrow();
				await expect(fs.stat(markerPath)).rejects.toThrow();
				await expect(fs.stat(readyPath)).rejects.toThrow();
			} else {
				expect(result).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
				expect(await snapshotDeleteSurface(sessionPath)).toEqual(surfaceBeforeDelete);
				await expect(fs.readFile(markerPath, "utf8")).resolves.toBe(canonicalJson(marker));
				await expect(fs.readFile(readyPath, "utf8")).resolves.toBe(canonicalJson(marker));
			}
		}
	} finally {
		setProcessIncarnationForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
test("broker refuses fresh lifecycle cleanup when ready sibling has a different owner marker", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-mismatched-ready-cleanup-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const saved = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
	const broker = new Broker({ agentDir });
	try {
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted delete transcript.");
		await saved.close();
		const artifactsPath = sessionPath.slice(0, -6);
		await fs.mkdir(path.join(artifactsPath, "nested"), { recursive: true });
		await fs.writeFile(path.join(artifactsPath, "nested", "preserve.txt"), "preserve mismatch artifacts");

		await broker.start();
		await expect(
			broker.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"mismatched-ready-resume",
			),
		).resolves.toMatchObject({ ok: true, result: { sessionId } });
		await expect(
			broker.handleRequest("session.close", { sessionId }, "mismatched-ready-close"),
		).resolves.toMatchObject({
			ok: true,
			result: { sessionId },
		});
		await waitFor(
			async () =>
				(await fs.access(path.join(stateRoot, "sdk", `${sessionId}.json`)).then(
					() => false,
					() => true,
				))
					? true
					: undefined,
			"mismatched ready endpoint cleanup",
		);
		const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
		const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
		const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
			pid: number;
			effectMarker: string;
			incarnation: string;
		};
		await fs.writeFile(readyPath, JSON.stringify({ ...marker, effectMarker: "different-ready-owner" }));
		const surfaceBeforeDelete = await snapshotDeleteSurface(sessionPath);

		await expect(
			broker.handleRequest(
				"session.delete",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"mismatched-ready-delete",
			),
		).resolves.toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		await expect(fs.stat(markerPath)).resolves.toBeDefined();
		await expect(fs.stat(readyPath)).resolves.toBeDefined();
		expect(await snapshotDeleteSurface(sessionPath)).toEqual(surfaceBeforeDelete);

		const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(
			rows.some(
				row =>
					((row.response as { error?: { cleanup?: { phase?: unknown } } } | undefined)?.error?.cleanup?.phase ??
						null) === "lifecycle",
			),
		).toBe(false);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("broker preserves ready-only lifecycle metadata without canonical marker authority during fresh delete", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ready-only-cleanup-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const saved = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
	const broker = new Broker({ agentDir });
	try {
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted delete transcript.");
		await saved.close();
		const artifactsPath = sessionPath.slice(0, -6);
		await fs.mkdir(path.join(artifactsPath, "nested"), { recursive: true });
		await fs.writeFile(path.join(artifactsPath, "nested", "preserve.txt"), "preserve ready-only artifacts");

		const deadOwner = Bun.spawn([process.execPath, "-e", ""]);
		await deadOwner.exited;
		const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
		const readyMarker = {
			pid: deadOwner.pid,
			effectMarker: "ready-only-dead-owner",
			incarnation: "ready-only-dead-incarnation",
		};
		await fs.mkdir(path.dirname(readyPath), { recursive: true });
		await fs.writeFile(readyPath, canonicalJson(readyMarker));
		const surfaceBeforeDelete = await snapshotDeleteSurface(sessionPath);

		await broker.start();
		await expect(
			broker.handleRequest(
				"session.delete",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"ready-only-fresh-delete",
			),
		).resolves.toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		await expect(fs.readFile(readyPath, "utf8")).resolves.toBe(canonicalJson(readyMarker));
		expect(await snapshotDeleteSurface(sessionPath)).toEqual(surfaceBeforeDelete);
		const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(
			rows.some(
				row =>
					((row.response as { error?: { cleanup?: { phase?: unknown } } } | undefined)?.error?.cleanup?.phase ??
						null) === "lifecycle",
			),
		).toBe(false);
		expect(rows.some(row => (row.response as { ok?: unknown } | undefined)?.ok === true)).toBe(false);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("broker replays an unmarked base metadata cleanup receipt and rejects a replaced ready sibling after marker loss", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-legacy-metadata-replay-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "legacy-metadata-replay";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const plannedPath = path.join(stateRoot, "sdk", `.gjc-delete-base-${sessionId}.lifecycle.json`);
	const request = { cwd: root, stateRoot, sessionId };
	const key = "base-metadata-cleanup-replay";
	let broker: Broker | undefined;
	try {
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		const marker = { pid: process.pid, effectMarker: "base", incarnation: "base" };
		await fs.writeFile(markerPath, canonicalJson(marker));
		await fs.writeFile(readyPath, canonicalJson(marker));
		const [stat, bytes] = await Promise.all([fs.stat(markerPath, { bigint: true }), fs.readFile(markerPath)]);
		const target = createHash("sha256").update(canonicalJson({ sessionId })).digest("hex");
		const identity = await deriveIdempotencyIdentity(agentDir, "session.delete", key, target);
		const requestHash = createHash("sha256")
			.update(canonicalJson({ operation: "session.delete", input: request }))
			.digest("hex");
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(identity, requestHash);
		await ledger.transition(identity, "effect_started", {
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Base metadata cleanup is pending.",
					cleanup: {
						phase: "metadata",
						sessionId,
						metadataRoot: stateRoot,
						metadataPath: markerPath,
						metadataIdentity: {
							dev: stat.dev.toString(),
							ino: stat.ino.toString(),
							size: Number(stat.size),
							mtimeNs: stat.mtimeNs.toString(),
							sha256: createHash("sha256").update(bytes).digest("hex"),
						},
						metadataAttempt: 1,
						plannedMetadataPath: plannedPath,
					},
				},
			},
		});
		await fs.unlink(markerPath);

		broker = new Broker({ agentDir });
		await broker.start();
		setLifecycleCleanupHookForTest(broker, () => {
			throw new Error("simulated crash after legacy ready cleanup");
		});
		await expect(broker.handleRequest("session.delete", request, key)).rejects.toThrow(
			"simulated crash after legacy ready cleanup",
		);
		await expect(fs.stat(markerPath)).rejects.toThrow();
		await expect(fs.stat(readyPath)).rejects.toThrow();
		const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const preUnlinkPlan = rows.some(row => {
			const cleanup = (
				row.response as
					| {
							error?: {
								cleanup?: { phase?: unknown; lifecycleFiles?: Array<{ path?: unknown; completed?: unknown }> };
							};
					  }
					| undefined
			)?.error?.cleanup;
			return (
				cleanup?.phase === "lifecycle" &&
				cleanup.lifecycleFiles?.some(file => file.path === readyPath && file.completed === undefined) === true
			);
		});
		expect(preUnlinkPlan).toBe(true);
		const migrated = rows.findLast(row => row.state === "effect_started" && row.response);
		expect((migrated?.response as { error?: { cleanup?: unknown } } | undefined)?.error?.cleanup).toMatchObject({
			phase: "lifecycle",
			sessionId,
			lifecycleFiles: [
				expect.objectContaining({ path: markerPath, plannedPath, completed: true }),
				expect.objectContaining({ path: readyPath, identity: expect.any(Object), completed: true }),
			],
		});
		await broker.stop();
		broker = new Broker({ agentDir });
		await broker.start();
		await expect(broker.handleRequest("session.delete", request, key)).resolves.toEqual({
			ok: true,
			result: { sessionId },
		});
		await expect(fs.stat(readyPath)).rejects.toThrow();
		await broker.stop();
		broker = undefined;

		const mismatchedSessionId = "legacy-metadata-mismatched-ready";
		const mismatchedMarkerPath = path.join(stateRoot, "sdk", `${mismatchedSessionId}.lifecycle.json`);
		const mismatchedReadyPath = path.join(stateRoot, "sdk", `${mismatchedSessionId}.lifecycle.ready.json`);
		const mismatchedPlannedPath = path.join(
			stateRoot,
			"sdk",
			`.gjc-delete-base-${mismatchedSessionId}.lifecycle.json`,
		);
		const replacedReady = {
			pid: process.pid + 1,
			effectMarker: "replaced-ready-owner",
			incarnation: "replaced-ready-incarnation",
		};
		await fs.writeFile(mismatchedMarkerPath, canonicalJson(marker));
		await fs.writeFile(mismatchedReadyPath, canonicalJson(replacedReady));
		const [mismatchedStat, mismatchedBytes] = await Promise.all([
			fs.stat(mismatchedMarkerPath, { bigint: true }),
			fs.readFile(mismatchedMarkerPath),
		]);
		const mismatchedRequest = { sessionId: mismatchedSessionId };
		const mismatchedKey = "base-metadata-mismatched-ready";
		const mismatchedIdentity = await deriveIdempotencyIdentity(
			agentDir,
			"session.delete",
			mismatchedKey,
			createHash("sha256").update(canonicalJson(mismatchedRequest)).digest("hex"),
		);
		const mismatchedLedger = await new LifecycleLedger(agentDir).open();
		await mismatchedLedger.begin(
			mismatchedIdentity,
			createHash("sha256")
				.update(canonicalJson({ operation: "session.delete", input: mismatchedRequest }))
				.digest("hex"),
		);
		await mismatchedLedger.transition(mismatchedIdentity, "effect_started", {
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Base metadata cleanup is pending.",
					cleanup: {
						phase: "metadata",
						sessionId: mismatchedSessionId,
						metadataRoot: stateRoot,
						metadataPath: mismatchedMarkerPath,
						metadataIdentity: {
							dev: mismatchedStat.dev.toString(),
							ino: mismatchedStat.ino.toString(),
							size: Number(mismatchedStat.size),
							mtimeNs: mismatchedStat.mtimeNs.toString(),
							sha256: createHash("sha256").update(mismatchedBytes).digest("hex"),
						},
						plannedMetadataPath: mismatchedPlannedPath,
					},
				},
			},
		});
		await fs.unlink(mismatchedMarkerPath);
		broker = new Broker({ agentDir });
		await broker.start();
		await expect(broker.handleRequest("session.delete", mismatchedRequest, mismatchedKey)).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		await expect(fs.stat(mismatchedMarkerPath)).rejects.toThrow();
		await expect(fs.readFile(mismatchedReadyPath, "utf8")).resolves.toBe(canonicalJson(replacedReady));
	} finally {
		await broker?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("broker rejects a corrupt completed lifecycle cleanup receipt when its ready sibling remains", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-completed-lifecycle-replay-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "completed-lifecycle-replay";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const request = { cwd: root, stateRoot, sessionId };
	const key = "completed-lifecycle-replay";
	let broker: Broker | undefined;
	try {
		const marker = {
			pid: process.pid,
			effectMarker: "completed-replay",
			incarnation: "completed-replay",
		};

		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(markerPath, canonicalJson(marker));
		await fs.writeFile(readyPath, canonicalJson(marker));
		const [markerStat, markerBytes, readyBytes] = await Promise.all([
			fs.stat(markerPath, { bigint: true }),
			fs.readFile(markerPath),
			fs.readFile(readyPath),
		]);
		const target = createHash("sha256").update(canonicalJson({ sessionId })).digest("hex");
		const identity = await deriveIdempotencyIdentity(agentDir, "session.delete", key, target);
		const requestHash = createHash("sha256")
			.update(canonicalJson({ operation: "session.delete", input: request }))
			.digest("hex");
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(identity, requestHash);
		await ledger.transition(identity, "effect_started", {
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Lifecycle cleanup is pending.",
					cleanup: {
						phase: "lifecycle",
						sessionId,
						metadataRoot: stateRoot,
						lifecycleFiles: [
							{
								path: markerPath,
								identity: {
									dev: markerStat.dev.toString(),
									ino: markerStat.ino.toString(),
									size: Number(markerStat.size),
									mtimeNs: markerStat.mtimeNs.toString(),
									sha256: createHash("sha256").update(markerBytes).digest("hex"),
								},
								attempt: 1,
								plannedPath: path.join(
									path.dirname(markerPath),
									`.gjc-delete-marker-${sessionId}.lifecycle.json`,
								),

								completed: true,
							},
						],
					},
				},
			},
		});
		await fs.unlink(markerPath);
		broker = new Broker({ agentDir });
		await broker.start();
		await expect(broker.handleRequest("session.delete", request, key)).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		await expect(fs.stat(markerPath)).rejects.toThrow();
		await expect(fs.readFile(readyPath)).resolves.toEqual(readyBytes);
	} finally {
		await broker?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("broker rejects malformed lifecycle cleanup receipts without mutating metadata", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-malformed-lifecycle-replay-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "malformed-lifecycle-replay";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const request = { cwd: root, stateRoot, sessionId };
	const marker = canonicalJson({
		pid: process.pid,
		effectMarker: "malformed-replay",
		incarnation: "malformed-replay",
	});
	const broker = new Broker({ agentDir });
	try {
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(markerPath, marker);
		await fs.writeFile(readyPath, marker);
		await broker.start();
		const identity = {
			dev: "1",
			ino: "1",
			size: 1,
			mtimeNs: "1",
			sha256: "a".repeat(64),
		};
		const validFile = {
			path: markerPath,
			identity,
			attempt: 1,
			plannedPath: path.join(stateRoot, "sdk", ".gjc-delete-malformed-marker"),
		};
		const malformed = [
			{ lifecycleFiles: [null] },
			{ lifecycleFiles: [{}] },
			{ lifecycleFiles: [validFile], lifecycleDeleteMetadata: false },
			{ lifecycleFiles: [{ ...validFile, completed: "true" }] },
			{ lifecycleFiles: [{ ...validFile, metadataPath: markerPath }] },
		] as const;
		for (const [index, fragment] of malformed.entries()) {
			const response = await executeLifecycle(
				broker,
				"session.delete",
				request,
				`malformed-lifecycle-replay-${index}`,
				{
					phase: "lifecycle",
					sessionId,
					metadataRoot: stateRoot,
					...fragment,
				} as unknown as BrokerCleanupEvidence,
			);
			expect(response.response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		}
		expect(await fs.readFile(markerPath, "utf8")).toBe(marker);
		expect(await fs.readFile(readyPath, "utf8")).toBe(marker);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker rejects oversized lifecycle marker and readiness receipts before hashing or unlinking", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-oversized-lifecycle-replay-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "oversized-lifecycle-replay";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const request = { cwd: root, stateRoot, sessionId };
	const broker = new Broker({ agentDir });
	const capture = async (file: string) => {
		const [stat, bytes] = await Promise.all([fs.stat(file, { bigint: true }), fs.readFile(file)]);
		return {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs.toString(),
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	};
	const cleanup = async (): Promise<BrokerCleanupEvidence> => ({
		phase: "lifecycle",
		sessionId,
		metadataRoot: stateRoot,
		lifecycleDeleteMetadata: true,
		lifecycleFiles: [
			{
				path: markerPath,
				identity: await capture(markerPath),
				attempt: 1,
				plannedPath: path.join(stateRoot, "sdk", ".gjc-delete-oversized-marker"),
			},
			{
				path: readyPath,
				identity: await capture(readyPath),
				attempt: 1,
				plannedPath: path.join(stateRoot, "sdk", ".gjc-delete-oversized-ready"),
			},
		],
	});
	try {
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		const valid = canonicalJson({
			pid: process.pid,
			effectMarker: "oversized-replay",
			incarnation: "oversized-replay",
		});
		await fs.writeFile(markerPath, `${valid}${" ".repeat(4096)}`);
		await fs.writeFile(readyPath, valid);
		await broker.start();
		let response = await executeLifecycle(broker, "session.delete", request, "oversized-marker", await cleanup());
		expect(response.response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect((await fs.stat(markerPath)).size).toBeGreaterThan(4096);
		await fs.writeFile(markerPath, valid);
		await fs.writeFile(readyPath, `${valid}${" ".repeat(4096)}`);
		response = await executeLifecycle(broker, "session.delete", request, "oversized-ready", await cleanup());
		expect(response.response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect((await fs.stat(readyPath)).size).toBeGreaterThan(4096);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker rejects duplicate lifecycle marker replay authorities without unlinking siblings", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-duplicate-lifecycle-replay-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "duplicate-lifecycle-replay";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const request = { cwd: root, stateRoot, sessionId };
	const key = "duplicate-lifecycle-replay";
	let broker: Broker | undefined;
	try {
		const marker = { pid: process.pid, effectMarker: "duplicate-replay", incarnation: "duplicate-replay" };
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(markerPath, canonicalJson(marker));
		await fs.writeFile(readyPath, canonicalJson(marker));
		const [markerStat, markerBytes, readyBytes] = await Promise.all([
			fs.stat(markerPath, { bigint: true }),
			fs.readFile(markerPath),
			fs.readFile(readyPath),
		]);
		const identity = await deriveIdempotencyIdentity(
			agentDir,
			"session.delete",
			key,
			createHash("sha256").update(canonicalJson({ sessionId })).digest("hex"),
		);
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(
			identity,
			createHash("sha256")
				.update(canonicalJson({ operation: "session.delete", input: request }))
				.digest("hex"),
		);
		const cleanupFile = (plannedPath: string) => ({
			path: markerPath,
			identity: {
				dev: markerStat.dev.toString(),
				ino: markerStat.ino.toString(),
				size: Number(markerStat.size),
				mtimeNs: markerStat.mtimeNs.toString(),
				sha256: createHash("sha256").update(markerBytes).digest("hex"),
			},
			attempt: 1,
			plannedPath,
		});
		await ledger.transition(identity, "effect_started", {
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Lifecycle cleanup is pending.",
					cleanup: {
						phase: "lifecycle",
						lifecycleDeleteMetadata: true,
						sessionId,
						metadataRoot: stateRoot,
						lifecycleFiles: [
							cleanupFile(path.join(stateRoot, "sdk", ".gjc-delete-one")),
							cleanupFile(path.join(stateRoot, "sdk", ".gjc-delete-two")),
						],
					},
				},
			},
		});
		broker = new Broker({ agentDir });
		await broker.start();
		await expect(broker.handleRequest("session.delete", request, key)).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		await expect(fs.readFile(markerPath)).resolves.toEqual(markerBytes);
		await expect(fs.readFile(readyPath)).resolves.toEqual(readyBytes);
	} finally {
		await broker?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
test("broker rejects a ready-only lifecycle replay entry without marker authority", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ready-only-replay-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "ready-only-lifecycle-replay";
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const request = { cwd: root, stateRoot, sessionId };
	const key = "ready-only-lifecycle-replay";
	let broker: Broker | undefined;
	try {
		const marker = { pid: process.pid, effectMarker: "ready-only-replay", incarnation: "ready-only-replay" };
		await fs.mkdir(path.dirname(readyPath), { recursive: true });
		await fs.writeFile(readyPath, canonicalJson(marker));
		const [readyStat, readyBytes] = await Promise.all([fs.stat(readyPath, { bigint: true }), fs.readFile(readyPath)]);
		const identity = await deriveIdempotencyIdentity(
			agentDir,
			"session.delete",
			key,
			createHash("sha256").update(canonicalJson({ sessionId })).digest("hex"),
		);
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(
			identity,
			createHash("sha256")
				.update(canonicalJson({ operation: "session.delete", input: request }))
				.digest("hex"),
		);
		await ledger.transition(identity, "effect_started", {
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Lifecycle cleanup is pending.",
					cleanup: {
						phase: "lifecycle",
						lifecycleDeleteMetadata: true,
						sessionId,
						metadataRoot: stateRoot,
						lifecycleFiles: [
							{
								path: readyPath,
								identity: {
									dev: readyStat.dev.toString(),
									ino: readyStat.ino.toString(),
									size: Number(readyStat.size),
									mtimeNs: readyStat.mtimeNs.toString(),
									sha256: createHash("sha256").update(readyBytes).digest("hex"),
								},
								attempt: 1,
								plannedPath: path.join(stateRoot, "sdk", ".gjc-delete-ready-only"),
							},
						],
					},
				},
			},
		});
		broker = new Broker({ agentDir });
		await broker.start();
		await expect(broker.handleRequest("session.delete", request, key)).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		await expect(fs.readFile(readyPath)).resolves.toEqual(readyBytes);
	} finally {
		await broker?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
test("broker fails closed when a lifecycle ready sibling is swapped after marker reconciliation", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-lifecycle-swap-replay-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "lifecycle-swap-replay";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const preservePath = path.join(root, "preserve-ready-user-data");
	const request = { cwd: root, stateRoot, sessionId };
	const key = "lifecycle-swap-replay";
	let broker: Broker | undefined;
	try {
		const marker = { pid: process.pid, effectMarker: "swap-replay", incarnation: "swap-replay" };
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(markerPath, canonicalJson(marker));
		await fs.writeFile(readyPath, canonicalJson(marker));
		await fs.writeFile(preservePath, "preserve this user data");
		const captures = await Promise.all(
			[markerPath, readyPath].map(async file => ({
				path: file,
				stat: await fs.stat(file, { bigint: true }),
				bytes: await fs.readFile(file),
			})),
		);
		const identity = await deriveIdempotencyIdentity(
			agentDir,
			"session.delete",
			key,
			createHash("sha256").update(canonicalJson({ sessionId })).digest("hex"),
		);
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(
			identity,
			createHash("sha256")
				.update(canonicalJson({ operation: "session.delete", input: request }))
				.digest("hex"),
		);
		await ledger.transition(identity, "effect_started", {
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Lifecycle cleanup is pending.",
					cleanup: {
						phase: "lifecycle",
						lifecycleDeleteMetadata: true,
						sessionId,
						metadataRoot: stateRoot,
						lifecycleFiles: captures.map(({ path: file, stat, bytes }) => ({
							path: file,
							identity: {
								dev: stat.dev.toString(),
								ino: stat.ino.toString(),
								size: Number(stat.size),
								mtimeNs: stat.mtimeNs.toString(),
								sha256: createHash("sha256").update(bytes).digest("hex"),
							},
							attempt: 1,
							plannedPath: path.join(stateRoot, "sdk", `.gjc-delete-swap-${path.basename(file)}`),
						})),
					},
				},
			},
		});
		broker = new Broker({ agentDir });
		await broker.start();
		setLifecycleCleanupHookForTest(broker, () => {
			writeFileSync(readyPath, "replaced before unlink");
			renameSync(preservePath, `${preservePath}.moved`);
			writeFileSync(preservePath, "preserve this user data");
		});
		await expect(broker.handleRequest("session.delete", request, key)).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		await expect(fs.readFile(readyPath, "utf8")).resolves.toBe("replaced before unlink");
		await expect(fs.readFile(preservePath, "utf8")).resolves.toBe("preserve this user data");
	} finally {
		await broker?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
test("broker terminalizes default command resolver failures", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-resolver-failure-"));
	const agentDir = path.join(root, "agent");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		delete process.env.GJC_SDK_SESSION_COMMAND;
		setLifecycleCommandResolverForTest(broker, () => {
			throw new Error("SDK internal launch refused: compiled-runtime marker evidence is inconsistent.");
		});
		await broker.start();
		const requestId = "resolver-failure-terminal-receipt";
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, stateRoot: path.join(root, ".gjc", "state") },
			requestId,
		);
		expect(response).toEqual({
			ok: false,
			error: {
				code: "spawn_failed",
				message:
					"Unable to spawn session: SDK internal launch refused: compiled-runtime marker evidence is inconsistent.",
			},
		});
		expect(
			await broker.handleRequest(
				"session.create",
				{ cwd: root, stateRoot: path.join(root, ".gjc", "state") },
				requestId,
			),
		).toEqual(response);
		const terminal = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.findLast(row => row.state === "terminal_error");
		expect(terminal?.response).toEqual(response);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker rejects invalid and oversized readiness timeouts before spawning", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-timeout-"));
	const fixture = path.join(agentDir, "spawned.js");
	const spawnedPath = path.join(agentDir, "spawned");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`require("fs").writeFileSync(${JSON.stringify(spawnedPath)}, "spawned"); setInterval(() => {}, 1000);`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		for (const readinessTimeoutMs of [0, 60_001]) {
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd: agentDir, readinessTimeoutMs },
					`invalid-timeout-${readinessTimeoutMs}`,
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "readinessTimeoutMs must be an integer between 4000 and 60000.",
				},
			});
		}
		await expect(fs.stat(spawnedPath)).rejects.toThrow();
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker propagates an owned lifecycle startup failure without semantic readiness or endpoint survivors", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-child-exit-"));
	const fixture = path.join(agentDir, "exit.js");
	const sessionIdPath = path.join(agentDir, "session-id");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`require('fs').writeFileSync(${JSON.stringify(sessionIdPath)}, process.env.GJC_SESSION_ID); setTimeout(() => process.exit(0), 100);`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		const started = Date.now();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: agentDir, readinessTimeoutMs: 4_000 },
			"child-exits",
		);
		expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain", message: expect.any(String) } });
		expect(response).not.toMatchObject({ error: { code: "readiness_timeout" } });
		expect(Date.now() - started).toBeLessThan(1_000);
		const sessionId = await fs.readFile(sessionIdPath, "utf8");
		await expect(
			fs.stat(path.join(agentDir, ".gjc", "state", "sdk", `${sessionId}.lifecycle.ready.json`)),
		).rejects.toThrow();
		await expect(fs.stat(path.join(agentDir, ".gjc", "state", "sdk", `${sessionId}.json`))).rejects.toThrow();
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId, terminalUncertain: true }] },
		});
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker replays immutable lifecycle cleanup after a crash immediately after an exact detach", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ledger-crash-"));
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "owned-startup-failure.ts");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	let crashing: Broker | undefined;
	let reopened: Broker | undefined;
	let normal: Broker | undefined;
	try {
		await fs.writeFile(
			fixture,
			`import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionIndex } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/session-index.ts"))};
import { writeSessionLifecycleFailure } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"))};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
const endpoint = path.join(request.stateRoot, "sdk", request.sessionId + ".json");
await fs.mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
await fs.writeFile(endpoint, JSON.stringify({ sessionId: request.sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "owned-startup-failure" }), { mode: 0o600 });
const index = await new SessionIndex(process.env.GJC_AGENT_DIR!).open();
const endpointGeneration = 1;
await index.append({ type: "host_registered", sessionId: request.sessionId, locator: { repo: request.cwd, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs, lifecycleRequestId: request.effectMarker });
const source = await fs.readFile(request.sessionPath);
const stat = await fs.stat(request.sessionPath, { bigint: true });
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "owned synthetic startup failure" }, { endpointGeneration, fenced: true, runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true }, { digest: createHash("sha256").update(source).digest("hex"), identity: { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), mtimeNs: stat.mtimeNs.toString(), sha256: createHash("sha256").update(source).digest("hex") } });

await index.append({ type: "host_unregistered", sessionId: request.sessionId, locator: { repo: request.cwd, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, lifecycleRequestId: request.effectMarker });
await fs.rm(endpoint);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		const saved = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted resume transcript.");
		await saved.close();
		const request = { cwd: root, sessionId, sessionPath };

		crashing = new Broker({ agentDir });
		await crashing.start();
		setLifecycleCleanupHookForTest(crashing, () => {
			throw new Error("simulated crash after lifecycle exact detach");
		});
		await expect(crashing.handleRequest("session.resume", request, "post-fsync-crash")).rejects.toThrow(
			"simulated crash after lifecycle exact detach",
		);
		const crashRows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const persisted = crashRows.findLast(row => row.state === "effect_started");
		if (!persisted?.response || typeof persisted.effectMarker !== "string")
			throw new Error("Expected persisted lifecycle cleanup intent.");
		const persistedResponse = persisted.response as BrokerResponse;
		expect(persistedResponse).toMatchObject({
			ok: false,
			error: {
				code: "cleanup_pending",
				cleanup: {
					phase: "lifecycle",
					lifecycleFiles: expect.arrayContaining([
						expect.objectContaining({
							path: expect.stringContaining(`${sessionId}.lifecycle.failure.`),
							identity: expect.objectContaining({ sha256: expect.any(String) }),
							plannedPath: expect.stringContaining(".gjc-delete-"),
						}),
					]),
				},
			},
		});
		const stateRoot = path.join(root, ".gjc", "state", "sdk");
		const artifact = path.join(stateRoot, `${sessionId}.lifecycle.failure.${persisted.effectMarker}.json`);
		const marker = path.join(stateRoot, `${sessionId}.lifecycle.json`);
		await expect(fs.stat(artifact)).rejects.toThrow();
		await expect(fs.stat(marker)).resolves.toBeDefined();

		await crashing.stop();
		crashing = undefined;
		reopened = new Broker({ agentDir });
		await reopened.start();
		setLifecycleCleanupHookForTest(reopened, () => {
			throw new Error("simulated repeated lifecycle cleanup failure");
		});
		await expect(reopened.handleRequest("session.resume", request, "post-fsync-crash")).rejects.toThrow(
			"simulated repeated lifecycle cleanup failure",
		);
		await reopened.stop();
		reopened = new Broker({ agentDir });
		await reopened.start();
		const replayed = await reopened.handleRequest("session.resume", request, "post-fsync-crash");
		expect(replayed).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
		await expect(fs.stat(artifact)).rejects.toThrow();
		await expect(fs.stat(marker)).rejects.toThrow();
		await reopened.stop();
		reopened = undefined;

		const normalRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ledger-normal-"));
		const normalAgentDir = path.join(normalRoot, "agent");
		const normalSaved = SessionManager.create(
			normalRoot,
			SessionManager.getDefaultSessionDir(normalRoot, normalAgentDir),
		);
		try {
			await normalSaved.ensureOnDisk();
			const normalSessionPath = normalSaved.getSessionFile();
			if (!normalSessionPath) throw new Error("Expected persisted normal resume transcript.");
			const normalSessionId = normalSaved.getSessionId();
			await normalSaved.close();
			await fs.copyFile(fixture, path.join(normalRoot, "owned-startup-failure.ts"));
			process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${path.join(normalRoot, "owned-startup-failure.ts")}`;
			normal = new Broker({ agentDir: normalAgentDir });
			await normal.start();
			const normalResponse = await normal.handleRequest(
				"session.resume",
				{ cwd: normalRoot, sessionId: normalSessionId, sessionPath: normalSessionPath },
				"normal-after-verification",
			);
			expect(normalResponse).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			const normalTerminal = (await fs.readFile(path.join(normalAgentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Record<string, unknown>)
				.findLast(row => row.state === "terminal_error");
			if (!normalTerminal || typeof normalTerminal.effectMarker !== "string")
				throw new Error("Expected normal terminal lifecycle record.");
			expect(normalTerminal.response).toEqual(normalResponse);
			expect(normalTerminal.responseDigest).toBe(
				createHash("sha256").update(canonicalJson(normalResponse)).digest("hex"),
			);
			await expect(
				fs.stat(
					path.join(
						normalRoot,
						".gjc",
						"state",
						"sdk",
						`${normalSessionId}.lifecycle.failure.${normalTerminal.effectMarker}.json`,
					),
				),
			).rejects.toThrow();
			await expect(
				fs.stat(path.join(normalRoot, ".gjc", "state", "sdk", `${normalSessionId}.lifecycle.json`)),
			).rejects.toThrow();
			expect({
				crashAfterDetachRecovered: await Promise.all([
					fs.stat(artifact).then(
						() => false,
						() => true,
					),
					fs.stat(marker).then(
						() => false,
						() => true,
					),
				]).then(values => values.every(Boolean)),
				normalPathEvidenceCleaned: await Promise.all([
					fs.stat(
						path.join(
							normalRoot,
							".gjc",
							"state",
							"sdk",
							`${normalSessionId}.lifecycle.failure.${normalTerminal.effectMarker}.json`,
						),
					),
					fs.stat(path.join(normalRoot, ".gjc", "state", "sdk", `${normalSessionId}.lifecycle.json`)),
				]).then(
					() => false,
					() => true,
				),
			}).toEqual({ crashAfterDetachRecovered: true, normalPathEvidenceCleaned: true });
		} finally {
			await normal?.stop();
			await normalSaved.close();
			await fs.rm(normalRoot, { recursive: true, force: true });
		}
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await reopened?.stop();
		await crashing?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("session index rejects a stale unregister from an earlier matching PID-generation registration", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-session-index-unregister-"));
	const index = await new SessionIndex(agentDir).open();
	const shared = {
		sessionId: "reused-registration",
		locator: { repo: "fixture", stateRoot: path.join(agentDir, "state") },
		endpointGeneration: 5,
		pid: process.pid,
		lifecycleRequestId: "same-marker",
	};
	try {
		const first = await index.append({ type: "host_registered", ...shared });
		await index.append({ type: "host_unregistered", ...shared });
		const replacement = await index.append({ type: "host_registered", ...shared });
		expect(index.hostUnregisteredAfter(first)).toMatchObject({
			lifecycleRequestId: "same-marker",
		});
		expect(index.hostUnregisteredAfter(replacement)).toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("session index proves ordinary host unregistration using a newer matching registration sequence", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-session-index-ordinary-close-"));
	const index = await new SessionIndex(agentDir).open();
	const shared = {
		sessionId: "ordinary-host",
		locator: { repo: "fixture", stateRoot: path.join(agentDir, "state") },
		endpointGeneration: 6,
		pid: process.pid,
	};
	try {
		const registration = await index.append({ type: "host_registered", ...shared });
		await index.append({ type: "host_unregistered", ...shared });
		expect(index.hostUnregisteredAfter(registration)).toEqual({ indexSeq: registration.indexSeq + 1 });
		const replacement = await index.append({ type: "host_registered", ...shared });
		expect(index.hostUnregisteredAfter(replacement)).toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker records the resolved worktree state root and preserves pre-child preparation failures", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-worktree-prechild-"));
	const repo = path.join(root, "repo");
	const agentDir = path.join(root, "agent");
	const worktreeName = "conflict";
	let worktreeRoot = "";
	const broker = new Broker({ agentDir });
	try {
		await fs.mkdir(repo, { recursive: true });
		for (const args of [
			["init"],
			["config", "user.email", "lifecycle@example.test"],
			["config", "user.name", "Lifecycle Test"],
		]) {
			const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		}
		await fs.writeFile(path.join(repo, "README"), "fixture\n");
		const committed = Bun.spawnSync(["git", "add", "README"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (committed.exitCode !== 0) throw new Error(committed.stderr.toString());
		const commit = Bun.spawnSync(["git", "commit", "-m", "fixture"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
		const plannedWorktree = planLaunchWorktree(repo, { enabled: true, detached: false, name: worktreeName });
		if (!plannedWorktree.enabled) throw new Error("Expected enabled worktree plan");
		worktreeRoot = plannedWorktree.worktreePath;
		await fs.mkdir(worktreeRoot, { recursive: true });
		await fs.writeFile(path.join(worktreeRoot, "occupied"), "conflict\n");
		await broker.start();

		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				stateRoot: path.join(repo, ".gjc", "state"),
				target: { worktree: { enabled: true, name: worktreeName } },
			},
			"pre-child-worktree-conflict",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", message: expect.stringContaining("worktree_path_conflict") },
		});
		const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const terminal = rows.findLast(row => row.state === "terminal_error");
		expect(terminal).toMatchObject({
			response,
			effectIntent: {
				stateRoot: path.join(worktreeRoot, ".gjc", "state"),
				childOwnershipEstablished: false,
			},
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
test("broker fails closed when the reopened terminal ledger cannot reproduce its response", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ledger-mismatch-"));
	const broker = new Broker({ agentDir });
	const originalReadTerminal = LifecycleLedger.prototype.readTerminal;
	try {
		await broker.start();
		LifecycleLedger.prototype.readTerminal = async () => undefined;
		const response = await broker.handleRequest(
			"session.unknown",
			{ sessionId: "ledger-mismatch" },
			"ledger-mismatch",
		);
		expect(response).toEqual({
			ok: false,
			error: {
				code: "terminal_uncertain",
				message:
					"Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
			},
		});
	} finally {
		LifecycleLedger.prototype.readTerminal = originalReadTerminal;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker rejects a ready foreign host for the spawned session id", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-foreign-ready-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const fixture = path.join(agentDir, "foreign.js");
	const foreignIdPath = path.join(agentDir, "foreign-session-id");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const previousEndpoint = process.env.GJC_FOREIGN_ENDPOINT_URL;
	let replayRequests = 0;
	const foreign = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("WebSocket required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "foreign" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as { id?: string; type?: string };
				if (frame.type !== "event_replay" || !frame.id) return;
				replayRequests++;
				void fs.readFile(foreignIdPath, "utf8").then(sessionId =>
					socket.send(
						JSON.stringify({
							type: "event_replay_result",
							id: frame.id,
							ok: true,
							events: [{ type: "event", name: "session_ready", sessionId, generation: 1 }],
						}),
					),
				);
			},
		},
	});
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=process.env.GJC_STATE_ROOT, id=process.env.GJC_SESSION_ID, agent=process.env.GJC_AGENT_DIR;
fs.mkdirSync(path.join(root,'sdk'),{recursive:true});
fs.writeFileSync(path.join(agent,'foreign-session-id'),id);
const endpoint=path.join(root,'sdk',id+'.json');
fs.writeFileSync(endpoint,JSON.stringify({sessionId:id,pid:process.ppid,url:process.env.GJC_FOREIGN_ENDPOINT_URL,token:'foreign'}));
const m=fs.statSync(endpoint).mtimeMs;
const log=path.join(agent,'sdk','sessions','index.jsonl');fs.mkdirSync(path.dirname(log),{recursive:true});const indexSeq=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length+1:1;
const event={type:'host_registered',sessionId:id,locator:{repo:'foreign',stateRoot:root},endpointGeneration:1,pid:process.ppid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
event.checksum=crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');fs.appendFileSync(log,JSON.stringify(event)+'\\n');
setInterval(()=>{},1000);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		process.env.GJC_FOREIGN_ENDPOINT_URL = `ws://127.0.0.1:${foreign.port}`;
		await broker.start();
		expect(
			await broker.handleRequest(
				"session.create",
				{ cwd: agentDir, stateRoot, readinessTimeoutMs: 4_000 },
				"foreign-ready",
			),
		).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect((await fs.readFile(foreignIdPath, "utf8")).length).toBeGreaterThan(0);
		expect(replayRequests).toBe(0);
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		if (previousEndpoint === undefined) delete process.env.GJC_FOREIGN_ENDPOINT_URL;
		else process.env.GJC_FOREIGN_ENDPOINT_URL = previousEndpoint;
		foreign.stop(true);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker refuses a stale registered PID when no durable effect marker proves ownership", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-stale-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "stale",
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
		});
		expect(await broker.handleRequest("session.close", { sessionId: "stale" }, "stale-close")).toEqual({
			ok: false,
			error: {
				code: "close_refused",
				message: "Session endpoint is unavailable and its durable process identity could not be verified.",
			},
		});
		expect(process.pid).toBeGreaterThan(0);
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker refuses same-generation close authority from a prior endpoint incarnation", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-close-incarnation-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "successor";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "successor-token" }),
		);
		const endpointMtimeMs = (await fs.stat(endpoint)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs,
		});
		const staleEndpointIncarnation = createHash("sha256")
			.update(
				JSON.stringify({
					endpointGeneration: 1,
					endpointMtimeMs: endpointMtimeMs - 1,
					pid: process.pid,
					sessionId,
				}),
			)
			.digest("hex");
		expect(
			await broker.handleRequest(
				"session.close",
				{ sessionId, endpointGeneration: 1, endpointIncarnation: staleEndpointIncarnation },
				"stale-incarnation-close",
			),
		).toEqual({ ok: false, error: { code: "endpoint_stale", message: "session endpoint is stale" } });
		expect(await fs.readFile(endpoint, "utf8")).toContain("successor-token");
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker rebinds implicit close only for a matching non-empty lifecycle request id", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-close-rebind-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const originalHandleRequest = broker.handleRequest.bind(broker);
	try {
		await broker.start();
		for (const [label, initialRequestId, replacementRequestId, expectedCode] of [
			["same", "request-a", "request-a", "close_refused"],
			["absent", undefined, undefined, "endpoint_stale"],
			["different", "request-a", "request-b", "endpoint_stale"],
		] as const) {
			const sessionId = `close-rebind-${label}`;
			const locator = { repo: "fixture", stateRoot };
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: 1,
				...(initialRequestId ? { lifecycleRequestId: initialRequestId } : {}),
			});
			await broker.index.append({
				type: "host_heartbeat",
				sessionId,
				locator,
				endpointGeneration: 1,
				pid: process.pid,
			});
			let injected = false;
			broker.handleRequest = async (operation, input, idempotencyKey) => {
				if (operation === "session.get_endpoint" && input.sessionId === sessionId) {
					if (!injected) {
						injected = true;
						await broker.index.append({
							type: "host_registered",
							sessionId,
							locator,
							endpointGeneration: 2,
							pid: process.pid,
							endpointMtimeMs: 2,
							...(replacementRequestId ? { lifecycleRequestId: replacementRequestId } : {}),
						});
						return { ok: false, error: { code: "endpoint_stale", message: "session endpoint is stale" } };
					}
					return { ok: false, error: { code: "resource_gone", message: "session endpoint record is gone" } };
				}
				return originalHandleRequest(operation, input, idempotencyKey);
			};
			const result = await broker.handleRequest("session.close", { sessionId }, `close-rebind-${label}`);
			expect(injected).toBe(true);
			expect(result).toMatchObject({ ok: false, error: { code: expectedCode } });
		}
	} finally {
		broker.handleRequest = originalHandleRequest;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("broker atomically reuses the indexed live owner for distinct resume keys", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-resume-live-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const savedSession = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
	await savedSession.ensureOnDisk();
	const sessionId = savedSession.getSessionId();
	const sessionPath = savedSession.getSessionFile();
	if (!sessionPath) throw new Error("Expected saved session path.");
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "live-owner-token" }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: root, stateRoot },
			endpointGeneration: 17,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});

		const [first, second] = await Promise.all([
			broker.handleRequest("session.resume", { sessionId, sessionPath, cwd: root }, "resume-first"),
			broker.handleRequest("session.resume", { sessionId, sessionPath, cwd: root }, "resume-second"),
		]);

		for (const resumed of [first, second]) {
			expect(resumed).toMatchObject({
				ok: true,
				result: {
					sessionId,
					endpointGeneration: 17,
					reused: true,
					endpoint: { token: "live-owner-token" },
				},
			});
		}
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ sessionId, endpointGeneration: 17 })] },
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("broker never signals a PID reused after its lifecycle marker was written", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reused-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "reused";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const marker = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "stale" }),
		);
		await fs.writeFile(
			marker,
			JSON.stringify({ pid: process.pid, effectMarker: "old-effect", incarnation: "reused-process-incarnation" }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 7,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs,
		});
		expect(await broker.handleRequest("session.close", { sessionId }, "reused-close")).toEqual({
			ok: false,
			error: {
				code: "close_refused",
				message: "Session endpoint is unavailable and its durable process identity could not be verified.",
			},
		});
		expect(await fs.readFile(endpoint, "utf8")).toContain("stale");
		expect(await fs.readFile(marker, "utf8")).toContain("reused-process-incarnation");
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("broker records terminal uncertainty when SIGKILL re-verification fails after SIGTERM", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-uncertain-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "unkillable";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const marker = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const originalKill = process.kill;
	const broker = new Broker({ agentDir });
	try {
		if (!child.pid) throw new Error("fixture child has no pid");
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: child.pid, url: "ws://127.0.0.1:1", token: "unreachable" }),
		);
		await fs.writeFile(
			marker,
			JSON.stringify({ pid: child.pid, effectMarker: "fixture", incarnation: await incarnation(child.pid) }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 9,
			pid: child.pid,
			endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs,
		});
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			if (signal === "SIGTERM")
				writeFileSync(marker, JSON.stringify({ pid: child.pid, effectMarker: "fixture", incarnation: "replaced" }));
			return signal === 0 || signal === undefined ? originalKill(pid, signal) : undefined;
		}) as typeof process.kill;
		expect(await broker.handleRequest("session.close", { sessionId }, "unkillable-close")).toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		expect(await fs.readFile(endpoint, "utf8")).toContain("unreachable");
		expect(await fs.readFile(marker, "utf8")).toContain('"fixture"');
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ sessionId, terminalUncertain: true })] },
		});
	} finally {
		process.kill = originalKill;
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 10_000);

if (process.platform === "darwin") {
	test("broker records terminal uncertainty when a spawned child incarnation is unreadable", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-incarnation-"));
		const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
		let incarnationReads = 0;
		let childPid: number | undefined;
		const broker = new Broker({ agentDir });
		process.env.GJC_SDK_SESSION_COMMAND = "/bin/sleep 60";
		setProcessIncarnationForTest(broker, pid => {
			childPid ??= pid;
			return ++incarnationReads === 1 ? `test:${pid}` : undefined;
		});
		await broker.start();
		try {
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd: agentDir, readinessTimeoutMs: 4_000 },
					"unreadable-incarnation",
				),
			).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(childPid).toBeGreaterThan(0);
			expect(await broker.handleRequest("session.list", {})).toMatchObject({
				ok: true,
				result: { sessions: [expect.objectContaining({ terminalUncertain: true })] },
			});
		} finally {
			if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
			else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
			setProcessIncarnationForTest(broker, undefined);
			const pid = childPid;
			if (
				pid &&
				(() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				})()
			)
				process.kill(pid, "SIGKILL");
			await broker.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	}, 10_000);
}

test("broker starts from the production broker entrypoint with no sessions", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-zero-"));
	const broker = new Broker({ agentDir });
	try {
		const discovery = await broker.start();
		expect(discovery.url).toStartWith("ws://127.0.0.1:");
		expect(await broker.handleRequest("session.list", {})).toEqual({
			ok: true,
			result: { indexSeq: 0, sessions: [], warnings: [] },
			indexSeq: 0,
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("shipped sdk session-host-internal stays alive only after a semantic ready event and serves real requests", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-subprocess-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "shipped-subprocess";
	brokerDirs.push(agentDir);
	try {
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, sessionId);
		const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
		try {
			const replay = await client.request({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 });
			expect(replay.events).toContainEqual(
				expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
			);
			expect(child.exitCode).toBeNull();
			expect(await client.query("session.metadata")).toMatchObject({
				ok: true,
				page: { items: [{ sessionId }] },
			});
			await expect(client.control("mode.plan.set", { on: true })).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			await client.close();
		}
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		spawned.splice(spawned.indexOf(child), 1);
		const broker = await waitFor(
			async () => (await readSdkBrokerDiscovery(agentDir)) ?? undefined,
			"broker discovery",
		);
		expect(broker.url).toStartWith("ws://127.0.0.1:");
	} finally {
		await stopDiscoveredBroker(agentDir);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("session-host-internal exits with a sanitized startup failure before writing lifecycle readiness", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-startup-failure-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "startup-failure";
	const stateRoot = path.join(root, ".gjc", "state");
	try {
		await fs.mkdir(path.dirname(stateRoot), { recursive: true });
		await fs.writeFile(stateRoot, "not-a-directory");
		const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "sdk", "session-host-internal"], {
			cwd: root,
			env: {
				...process.env,
				HOME: root,
				GJC_AGENT_DIR: agentDir,
				GJC_CODING_AGENT_DIR: agentDir,
				GJC_SESSION_ID: sessionId,
				GJC_LIFECYCLE_REQUEST_ID: "startup-failure-proof",
				GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify({
					operation: "session.create",
					sessionId,
					cwd: root,
					stateRoot,
					effectMarker: "startup-failure-proof",
					...deriveLifecycleDeadlines(Date.now(), 10_000),
				}),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		spawned.push(child);
		await waitFor(async () => (child.exitCode === null ? undefined : child.exitCode), "startup failure exit");
		expect(child.exitCode).not.toBe(0);
		const stderr = await new Response(child.stderr).text();
		expect(stderr.trim()).not.toBe("");
		expect(stderr).not.toContain("readiness timeout");
		expect(await fs.readFile(stateRoot, "utf8")).toBe("not-a-directory");
		spawned.splice(spawned.indexOf(child), 1);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("production lifecycle factory failure preserves reason and redacts collected secrets", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-factory-failure-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const names = ["GJC_SDK_TEST_FACTORY_FAILURE", "GJC_SDK_TEST_FACTORY_SECRET"] as const;
	const previous = names.map(name => process.env[name]);
	const bare = "factory-bare-secret";
	const overlap = `${bare}-overlap`;
	const normalized = "factory-secret０".normalize("NFKC");
	process.env.GJC_SDK_TEST_FACTORY_FAILURE = root;
	process.env.GJC_SDK_TEST_FACTORY_SECRET = `${overlap} ${normalized} ${"x".repeat(600)}`;
	try {
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 4_000 },
			"factory-secret-failure",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", endpoint: "unavailable" },
			startupFailure: { phase: "registration", reason: "factory_absent" },
		});
		if (response.ok || !response.startupFailure) throw new Error("Expected startup failure evidence.");
		expect(response.startupFailure.message).toContain("[redacted-secret]");
		expect(response.startupFailure.message).not.toContain(bare);
		expect(response.startupFailure.message).not.toContain(overlap);
		expect(response.startupFailure.message).not.toContain(normalized);
		expect(new TextEncoder().encode(response.startupFailure.message).byteLength).toBeLessThanOrEqual(512);
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 10_000);
test("never-settling model profile startup cuts off with proven pre-registration cleanup", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-profile-cutoff-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const previous = process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE;
	process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE = root;
	try {
		await broker.start();
		const input = { cwd: root, readinessTimeoutMs: 4_000 };
		const response = await broker.handleRequest("session.create", input, "profile-cutoff");
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", endpoint: "unavailable" },
			startupFailure: {
				phase: "startup",
				reason: "pending",
				rollback: {
					endpointGeneration: null,
					fenced: true,
					runtimeRemoved: true,
					hostStopped: true,
					brokerRegistrationReleased: true,
				},
				cleanupProof: {
					processExited: true,
					endpointRemoved: true,
					hostUnregistered: { state: "not_registered" },
				},
			},
		});
		expect(await broker.handleRequest("session.create", input, "profile-cutoff")).toEqual(response);
	} finally {
		if (previous === undefined) delete process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE;
		else process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE = previous;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 10_000);
test("production post-registration startup failure proves cleanup and exact replay", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-production-failure-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const previousFailure = process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION;
	process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION = root;
	try {
		await broker.start();
		const input = { cwd: root, readinessTimeoutMs: 10_000 };
		const response = await broker.handleRequest("session.create", input, "production-startup-failure");
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: "spawn_failed",
				message: "No ready SDK endpoint remains available.",
				endpoint: "unavailable",
			},
			startupFailure: {
				phase: "startup",
				reason: "failed",
				rollback: {
					endpointGeneration: expect.any(Number),
					fenced: true,
					runtimeRemoved: true,
					hostStopped: true,
					brokerRegistrationReleased: true,
				},
				cleanupProof: {
					processExited: true,
					endpointRemoved: true,
					hostUnregistered: {
						indexSeq: expect.any(Number),
						lifecycleRequestId: expect.any(String),
					},
					rollback: {
						endpointGeneration: expect.any(Number),
						fenced: true,
						runtimeRemoved: true,
						hostStopped: true,
						brokerRegistrationReleased: true,
					},
				},
			},
			durableEffects: {
				transcript: { identityDigest: expect.any(String), contentDigest: expect.any(String) },
				digest: expect.any(String),
			},
		});
		expect(await broker.handleRequest("session.create", input, "production-startup-failure")).toEqual(response);
		const failure = response.ok ? undefined : response.startupFailure;
		if (!failure) throw new Error("Expected persisted startup failure evidence.");
		const sessions = await broker.handleRequest("session.list", {});
		expect(sessions).toMatchObject({ ok: true, result: { sessions: [] } });
		const sdkDir = path.join(root, ".gjc", "state", "sdk");
		const entries = await fs.readdir(sdkDir);
		expect(entries.some(entry => entry.includes(".lifecycle.failure."))).toBe(false);
		expect(entries.some(entry => entry.endsWith(".lifecycle.json"))).toBe(false);
	} finally {
		if (previousFailure === undefined) delete process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION;
		else process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION = previousFailure;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
test("production broker session.create authenticates a source-workspace v3 native endpoint", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-v3-broker-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	try {
		expect(typeof NotificationServer.prototype.onSdkFrame).toBe("function");
		await broker.start();
		const created = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 10_000 },
			"v3-native-create",
		);
		if (!created.ok) throw new Error(created.error.message);
		const { sessionId, endpoint } = created.result as {
			sessionId: string;
			endpoint: { url: string; token: string };
		};
		expect(typeof sessionId).toBe("string");
		expect(typeof endpoint.url).toBe("string");
		expect(typeof endpoint.token).toBe("string");
		const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
		try {
			const replay = await client.request({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 });
			expect(replay.events).toContainEqual(
				expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
			);
			expect(await client.query("session.metadata")).toMatchObject({
				ok: true,
				page: { items: [expect.objectContaining({ sessionId })] },
			});
		} finally {
			await client.close();
		}
		expect(await broker.handleRequest("session.close", { sessionId }, "v3-native-close")).toMatchObject({
			ok: true,
			result: { sessionId },
		});
		const sdkEntries = await fs.readdir(path.join(root, ".gjc", "state", "sdk"));
		expect(sdkEntries.some(entry => entry.includes(".lifecycle.failure."))).toBe(false);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("broker close acknowledges before terminating the lifecycle child and preserves its terminal host index", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-close-subprocess-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "close-subprocess";
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, sessionId);
		// The lifecycle child writes its endpoint file before the broker index records
		// its host_registered event; wait for the session to be indexed so session.close
		// does not race the registration (slow CI runners surfaced "session is not indexed").
		await waitFor(async () => {
			const listed = (await broker.handleRequest("session.list", {})) as {
				result?: { sessions?: Array<{ sessionId?: string }> };
			};
			return listed.result?.sessions?.some(session => session.sessionId === sessionId) ? true : undefined;
		}, "session indexed before close");
		const closed = await broker.handleRequest("session.close", { sessionId }, "close-1");
		expect(closed).toMatchObject({ ok: true, result: { sessionId } });
		expect(await child.exited).toBe(0);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId })).toMatchObject({
			ok: false,
			error: { code: "resource_gone" },
		});
		await expect(
			SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 250, reconnectAttempts: 0 }),
		).rejects.toThrow();
		expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true, result: { sessions: [] } });
		expect(
			(await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as { type?: string; sessionId?: string })
				.at(-1),
		).toMatchObject({ type: "host_unregistered", sessionId });
		expect(await broker.handleRequest("session.close", { sessionId }, "close-1")).toEqual(closed);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("ACP, MCP, and daemon global requests bootstrap a broker with zero sessions", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-zero-global-"));
	const agentDirs = ["acp", "mcp", "daemon"].map(name => path.join(root, name, "agent"));
	brokerDirs.push(...agentDirs);
	try {
		const acp = new AcpAgent({ signal: new AbortController().signal } as never, { agentDir: agentDirs[0] });
		expect(await acp.listSessions({})).toEqual({ sessions: [] });
		expect(await readSdkBrokerDiscovery(agentDirs[0])).not.toBeNull();

		const mcp = createSdkMcpServer({ repo: path.join(root, "mcp"), agentDir: agentDirs[1] });
		expect(await mcp.callTool("gjc_session_global", { operation: "session.list" })).toMatchObject({
			ok: true,
			result: { sessions: [] },
		});
		expect(await readSdkBrokerDiscovery(agentDirs[1])).not.toBeNull();

		const output: unknown[] = [];
		await runSdkSessionCli(
			{ action: "global", operation: "session.list", agentDir: agentDirs[2], repo: path.join(root, "daemon") },
			value => output.push(value),
		);
		expect(output).toMatchObject([{ ok: true, result: { sessions: [] } }]);
		expect(await readSdkBrokerDiscovery(agentDirs[2])).not.toBeNull();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("lifecycle cleanup rejects transplanted and ambiguous receipts before mutation", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-cleanup-receipt-"));
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "cleanup-receipt";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	try {
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(markerPath, "preserve lifecycle receipt bytes");
		const stat = await fs.stat(markerPath, { bigint: true });
		const bytes = await fs.readFile(markerPath);
		const file = (plannedPath: string) => ({
			path: markerPath,
			identity: {
				dev: stat.dev.toString(),
				ino: stat.ino.toString(),
				size: Number(stat.size),
				mtimeNs: stat.mtimeNs.toString(),
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			attempt: 1,
			plannedPath,
		});
		const deleteCleanup: BrokerCleanupEvidence = {
			phase: "lifecycle",
			lifecycleDeleteMetadata: true,
			sessionId,
			metadataRoot: stateRoot,
			lifecycleFiles: [file(path.join(stateRoot, "sdk", ".gjc-delete-cleanup"))],
		};
		for (const [operation, input] of [
			["session.delete", { cwd: root, stateRoot, sessionId: "other-cleanup-receipt" }],
			[
				"session.delete",
				{ cwd: path.join(root, "other"), stateRoot: path.join(root, "other", ".gjc", "state"), sessionId },
			],
			["session.create", { cwd: root, stateRoot }],
		] as const) {
			const result = await executeLifecycle(broker, operation, input, "cleanup-receipt", deleteCleanup);
			expect(result.response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(await fs.readFile(markerPath)).toEqual(bytes);
		}
		const duplicate: BrokerCleanupEvidence = {
			phase: "lifecycle",
			sessionId,
			metadataRoot: stateRoot,
			lifecycleFiles: [
				file(path.join(stateRoot, "sdk", ".gjc-delete-one")),
				file(path.join(stateRoot, "sdk", ".gjc-delete-two")),
			],
		};
		const mixed: BrokerCleanupEvidence = {
			...duplicate,
			metadataPath: markerPath,
			lifecycleFiles: [file(path.join(stateRoot, "sdk", ".gjc-delete-mixed"))],
		};
		const shared: BrokerCleanupEvidence = {
			phase: "lifecycle",
			sessionId,
			metadataRoot: stateRoot,
			lifecycleFiles: [{ ...file(path.join(stateRoot, "sdk", ".gjc-delete-shared")), detachedPath: markerPath }],
		};
		for (const cleanup of [duplicate, mixed, shared]) {
			const result = await executeLifecycle(
				broker,
				"session.create",
				{ cwd: root, stateRoot },
				"cleanup-receipt",
				cleanup,
			);
			expect(result.response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(await fs.readFile(markerPath)).toEqual(bytes);
		}
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("lifecycle cleanup receipt parser rejects hostile bounded inputs without touching user data", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-hostile-lifecycle-receipt-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "hostile-lifecycle-receipt";
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const readyPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`);
	const transcriptPath = path.join(root, "user.jsonl");
	const artifactsPath = transcriptPath.slice(0, -6);
	const request = { cwd: root, stateRoot, sessionId };
	const broker = new Broker({ agentDir });
	const outsidePlannedPath = path.join(root, "outside-planned");
	const outsideDetachedPath = path.join(root, "outside-detached");
	const outsideMarkerPath = path.join(root, "outside-marker");
	const outsideReadyPath = path.join(root, "outside-ready");
	const marker = canonicalJson({ pid: process.pid, effectMarker: "hostile-replay", incarnation: "hostile-replay" });
	const capture = async (file: string) => {
		const [stat, bytes] = await Promise.all([fs.stat(file, { bigint: true }), fs.readFile(file)]);
		return {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs.toString(),
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	};
	const cleanup = async (): Promise<BrokerCleanupEvidence> => ({
		phase: "lifecycle",
		sessionId,
		metadataRoot: stateRoot,
		lifecycleDeleteMetadata: true,
		lifecycleFiles: [
			{
				path: markerPath,
				identity: await capture(markerPath),
				attempt: 1,
				plannedPath: path.join(stateRoot, "sdk", ".gjc-delete-hostile-marker"),
			},
			{
				path: readyPath,
				identity: await capture(readyPath),
				attempt: 1,
				plannedPath: path.join(stateRoot, "sdk", ".gjc-delete-hostile-ready"),
			},
		],
	});
	const restoreBoundSiblings = async (value = marker) => {
		await Promise.all([fs.rm(markerPath, { force: true }), fs.rm(readyPath, { force: true })]);
		await Promise.all([fs.writeFile(markerPath, value), fs.writeFile(readyPath, value)]);
	};
	let preserved: { transcript: Buffer; artifacts: string | undefined };
	const assertPreserved = async () => expect(await snapshotDeleteSurface(transcriptPath)).toEqual(preserved);
	const reject = async (name: string, evidence: BrokerCleanupEvidence) => {
		const siblingBytes = await Promise.all([fs.readFile(markerPath), fs.readFile(readyPath)]);
		const started = Date.now();
		const outcome = await executeLifecycle(broker, "session.delete", request, `hostile-lifecycle-${name}`, evidence);
		expect(outcome.response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(await Promise.all([fs.readFile(markerPath), fs.readFile(readyPath)])).toEqual(siblingBytes);
		await assertPreserved();
	};
	try {
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(transcriptPath, "preserve user transcript\n");
		await fs.mkdir(artifactsPath);
		await fs.writeFile(path.join(artifactsPath, "artifact.txt"), "preserve user artifact\n");
		await Promise.all([
			fs.writeFile(outsidePlannedPath, "preserve planned target\n"),
			fs.writeFile(outsideDetachedPath, "preserve detached target\n"),
			fs.writeFile(outsideMarkerPath, "preserve marker target\n"),
			fs.writeFile(outsideReadyPath, "preserve ready target\n"),
		]);
		await restoreBoundSiblings();
		preserved = await snapshotDeleteSurface(transcriptPath);
		await broker.start();

		const valid = await cleanup();
		const nested = { value: 0 } as { value: number | { value: unknown } };
		for (let depth = 0; depth < 16; depth++) nested.value = { value: nested.value };
		const excessiveCardinality: BrokerCleanupEvidence = {
			...valid,
			lifecycleFiles: [...valid.lifecycleFiles!, ...valid.lifecycleFiles!, valid.lifecycleFiles![0]],
		};
		const deepExtraEntry = {
			...valid,
			lifecycleFiles: [{ ...valid.lifecycleFiles![0], unexpected: nested }, valid.lifecycleFiles![1]],
		} as unknown as BrokerCleanupEvidence;
		const mixedLegacyEntry = {
			...valid,
			metadataPath: markerPath,
			metadataIdentity: valid.lifecycleFiles![0].identity,
		} as unknown as BrokerCleanupEvidence;
		const duplicateAuthority: BrokerCleanupEvidence = {
			...valid,
			lifecycleFiles: [
				valid.lifecycleFiles![0],
				{ ...valid.lifecycleFiles![0], plannedPath: valid.lifecycleFiles![1].plannedPath },
			],
		};
		for (const [name, evidence] of [
			["excessive-array", excessiveCardinality],
			["deep-extra-entry", deepExtraEntry],
			["mixed-legacy-entry", mixedLegacyEntry],
			["duplicate-authority", duplicateAuthority],
		] as const)
			await reject(name, evidence);

		for (const [name, corruptPath] of [
			["corrupt-marker", markerPath],
			["corrupt-ready", readyPath],
		] as const) {
			await restoreBoundSiblings();
			await fs.writeFile(corruptPath, Buffer.from([0xc3, 0x28]));
			await reject(name, await cleanup());
			await expect(fs.readFile(corruptPath)).resolves.toEqual(Buffer.from([0xc3, 0x28]));
		}

		for (const [name, siblingPath, outsidePath] of [
			["marker-symlink", markerPath, outsideMarkerPath],
			["ready-symlink", readyPath, outsideReadyPath],
		] as const) {
			await restoreBoundSiblings();
			await fs.rm(siblingPath);
			await fs.symlink(outsidePath, siblingPath);
			await reject(name, await cleanup());
			expect((await fs.lstat(siblingPath)).isSymbolicLink()).toBe(true);
			await expect(fs.readFile(outsidePath, "utf8")).resolves.toContain("preserve");
		}

		await restoreBoundSiblings();
		const traversal = await cleanup();
		traversal.lifecycleFiles![0].plannedPath = path.join(stateRoot, "sdk", "..", "outside-planned");
		await reject("planned-traversal", traversal);
		const detachedOutside = await cleanup();
		detachedOutside.lifecycleFiles![1].detachedPath = outsideDetachedPath;
		await reject("detached-outside", detachedOutside);
		await expect(fs.readFile(outsidePlannedPath, "utf8")).resolves.toBe("preserve planned target\n");
		await expect(fs.readFile(outsideDetachedPath, "utf8")).resolves.toBe("preserve detached target\n");

		const oversizedField = canonicalJson({
			pid: process.pid,
			effectMarker: "x".repeat(3_500),
			incarnation: "hostile-replay",
		});
		expect(Buffer.byteLength(oversizedField)).toBeLessThanOrEqual(4096);
		await restoreBoundSiblings(oversizedField);
		await reject("oversized-field", await cleanup());
		await expect(fs.readFile(markerPath, "utf8")).resolves.toBe(oversizedField);
		await expect(fs.readFile(readyPath, "utf8")).resolves.toBe(oversizedField);

		await restoreBoundSiblings();
		await broker.ledger.begin("hostile-lifecycle-control", "hostile-lifecycle-control-request");
		const control = await executeLifecycle(
			broker,
			"session.delete",
			request,
			"hostile-lifecycle-control",
			await cleanup(),
		);
		expect(control.response).toEqual({ ok: true, result: { sessionId } });
		await expect(fs.lstat(markerPath)).rejects.toThrow();
		await expect(fs.lstat(readyPath)).rejects.toThrow();
		await assertPreserved();
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
