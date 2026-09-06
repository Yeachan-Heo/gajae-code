import { afterEach, expect, type Mock, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as syncFs from "node:fs";
import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { NotificationServer } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { openLifecycleSessionManager, runSessionHost, watchSessionHostBrokerLiveness } from "../src/commands/sdk";
import { planLaunchWorktree } from "../src/gjc-runtime/launch-worktree";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { Broker, type BrokerCleanupEvidence, type BrokerResponse } from "../src/sdk/broker/broker";
import { brokerOwnerForTest, startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { deriveIdempotencyIdentity } from "../src/sdk/broker/identity";
import {
	canonicalDeleteLocatorPath,
	deriveLifecycleDeadlines,
	executeLifecycle,
	hasValidLifecycleDeadlines,
	observeProcessForTest,
	parseDarwinProcessIncarnation,
	processIncarnation,
	reapDeadLifecycleMarkers,
	reapDeadSessionRegistrations,
	setLifecycleCleanupHookForTest,
	setLifecycleCommandResolverForTest,
	setLifecycleTimingForTest,
	setProcessIncarnationForTest,
	writeSessionLifecycleFailure,
} from "../src/sdk/broker/lifecycle";
import { parseLifecycleJson } from "../src/sdk/broker/lifecycle-codec";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { SessionIndex, type SessionIndexEvent } from "../src/sdk/broker/session-index";
import { runSdkSessionCli } from "../src/sdk/cli";
import { SdkClient } from "../src/sdk/client";
import { readSdkBrokerDiscovery } from "../src/sdk/client/discovery";
import { createSdkMcpServer } from "../src/sdk/mcp";
import { SessionRouter } from "../src/sdk/router";
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

function spawnDisposableHost() {
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000_000)"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	if (!child.pid) throw new Error("fixture child has no pid");
	spawned.push(child);
	return child;
}
async function settleRetainedTranscriptForTest(
	broker: Broker,
	input: { sessionId: string; sessionPath: string; cwd: string; stateRoot?: string },
	key: string,
	response: BrokerResponse,
	fallbackExactUnlink?: typeof native.exactUnlink,
): Promise<BrokerResponse> {
	let current = response;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (current.ok || current.error.code !== "cleanup_pending" || current.error.cleanup?.phase !== "transcript")
			return current;
		const cleanup = current.error.cleanup;
		if (cleanup.retainedTranscriptPlaceholderPath && syncFs.existsSync(cleanup.retainedTranscriptPlaceholderPath)) {
			const placeholder = syncFs.lstatSync(cleanup.retainedTranscriptPlaceholderPath, { bigint: true });
			const parent = syncFs.lstatSync(path.dirname(cleanup.retainedTranscriptPlaceholderPath), { bigint: true });
			if (
				!placeholder.isFile() ||
				placeholder.nlink !== 1n ||
				placeholder.size !== 0n ||
				!cleanup.transcriptParentIdentity ||
				parent.dev.toString() !== cleanup.transcriptParentIdentity.dev ||
				parent.ino.toString() !== cleanup.transcriptParentIdentity.ino
			)
				throw new Error("Lifecycle test placeholder lacks exact native authority");
			syncFs.rmSync(cleanup.retainedTranscriptPlaceholderPath);
		}
		const previousExactUnlink = fallbackExactUnlink ?? native.exactUnlink.bind(native);
		const unlinkSpy = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (path.dirname(pathname) !== path.dirname(input.sessionPath)) return previousExactUnlink(pathname, identity);
			const parent = syncFs.lstatSync(path.dirname(pathname), { bigint: true });
			const stat = syncFs.lstatSync(pathname, { bigint: true });
			if (
				identity.parentDev === undefined ||
				identity.parentIno === undefined ||
				parent.dev !== identity.parentDev ||
				parent.ino !== identity.parentIno ||
				stat.dev !== identity.dev ||
				stat.ino !== identity.ino ||
				(identity.nlink !== undefined && stat.nlink !== identity.nlink) ||
				stat.size > identity.size
			)
				throw new Error("Lifecycle test cleanup lacks exact native authority");
			if (identity.sha256 && stat.size !== 0n) {
				const digest = createHash("sha256").update(syncFs.readFileSync(pathname)).digest("hex");
				if (digest !== identity.sha256) throw new Error("Lifecycle test cleanup digest changed");
			}
			syncFs.rmSync(pathname, { force: true });
			return { ok: true };
		});
		try {
			current = await broker.handleRequest("session.delete", input, key);
		} finally {
			unlinkSpy.mockRestore();
		}
	}
	return current;
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
function deleteRequestHash(request: Record<string, unknown>): string {
	const cwd = canonicalDeleteLocatorPath(String(request.cwd));
	const input = { ...request, cwd, stateRoot: path.join(cwd, ".gjc", "state") };
	return createHash("sha256")
		.update(canonicalJson({ operation: "session.delete", input }))
		.digest("hex");
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
				worktree: { cwdDigest: "a", created: true, reused: false, createdBranch: true },
				digest: "corrupt",
			},
		});
		const pendingIdentity = "pending-response-digest-corruption";
		await ledger.begin(pendingIdentity, "pending-request");
		await ledger.transition(pendingIdentity, "effect_started", {
			intendedSessionId: pendingIdentity,
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "pending",
					cleanup: {
						phase: "artifacts",
						sessionId: pendingIdentity,
						sessionsRoot: "/sessions",
						transcriptPath: `/sessions/${pendingIdentity}.jsonl`,
					},
				},
			},
		});
		const ledgerPath = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
		const persistedRows = (await fs.readFile(ledgerPath, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const pendingRow = persistedRows.findLast(row => row.identity === pendingIdentity);
		if (!pendingRow) throw new Error("Expected persisted pending cleanup row");
		pendingRow.responseDigest = "corrupt";
		await fs.writeFile(ledgerPath, `${persistedRows.map(row => JSON.stringify(row)).join("\n")}\n`);
		const reopened = await new LifecycleLedger(agentDir).open();
		expect(await reopened.begin(responseIdentity, "response-request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(await reopened.begin(effectsIdentity, "effects-request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(await reopened.begin(pendingIdentity, "pending-request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(reopened.hasUncertainCleanupForSession(pendingIdentity, "other-delete")).toBe(true);
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

test("rejects oversized lifecycle idempotency keys before create admission", async () => {
	if (process.platform !== "linux") return;
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-key-bound-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	try {
		await broker.start();
		await expect(broker.handleRequest("session.create", { cwd: root }, "x".repeat(257))).resolves.toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

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
	const session = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
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
		await fs.writeFile(replacementPath, `${await fs.readFile(sessionPath, "utf8")}\n`, { mode: 0o600 });
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
	const source = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, agentDir));
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

test("session host opts cached default profiles into lifecycle startup only", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-cached-default-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "cached-default-policy";
	const effectMarker = "cached-default-policy-marker";
	const deadlines = deriveLifecycleDeadlines(Date.now(), 60_000);
	const names = [
		"GJC_AGENT_DIR",
		"GJC_STATE_ROOT",
		"GJC_LIFECYCLE_REQUEST_ID",
		"GJC_SDK_LIFECYCLE_REQUEST",
		"GJC_SDK_TEST_IN_MEMORY_SESSION",
	] as const;
	const previous = names.map(name => process.env[name]);
	let captured:
		| {
				preferCachedModels: boolean | undefined;
				preferCachedDefaultProfile: boolean | undefined;
		  }
		| undefined;
	try {
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
			JSON.stringify({ pid: process.pid, effectMarker, incarnation: "test-incarnation" }),
		);
		process.env.GJC_AGENT_DIR = agentDir;
		process.env.GJC_STATE_ROOT = stateRoot;
		process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
		process.env.GJC_SDK_TEST_IN_MEMORY_SESSION = "1";
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
				cwd: root,
				processIncarnation: () => "test-incarnation",
				applyStartupModelProfiles: async options => {
					captured = {
						preferCachedModels: options.preferCachedModels,
						preferCachedDefaultProfile: options.preferCachedDefaultProfile,
					};
					throw new Error("stop-after-profile-policy-capture");
				},
			}),
		).rejects.toThrow("stop-after-profile-policy-capture");
		expect(captured).toEqual({ preferCachedModels: true, preferCachedDefaultProfile: true });
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("session host fails closed when its lifecycle effect marker is corrupt", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-corrupt-marker-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "corrupt-marker";
	const effectMarker = "corrupt-marker-effect";
	const deadlines = deriveLifecycleDeadlines(1_000, 4_000);
	const names = ["GJC_AGENT_DIR", "GJC_STATE_ROOT", "GJC_LIFECYCLE_REQUEST_ID", "GJC_SDK_LIFECYCLE_REQUEST"] as const;
	const previous = names.map(name => process.env[name]);
	try {
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		await fs.writeFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`), "{");
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
		).rejects.toThrow("marker authority was not published");
		await expect(fs.stat(path.join(stateRoot, "sdk", `${sessionId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("session host orphan watchdog resolves only after the broker publication stays unobservable for the full grace window", async () => {
	let nowMs = 0;
	const observations: (Record<string, unknown> | null | Error)[] = [
		{ pid: 1 }, // live broker
		null, // broker vanishes: absence window opens
		new Error("EACCES"), // unreadable publication accrues against the same bound
		{ pid: 2 }, // replacement broker resets the window
		null, // broker vanishes again
		null,
		null, // grace elapses here
	];
	let reads = 0;
	await watchSessionHostBrokerLiveness({
		agentDir: "/unused",
		now: () => nowMs,
		sleep: async ms => {
			nowMs += ms;
		},
		readDiscovery: async () => {
			const observation = observations[reads];
			reads += 1;
			if (observation instanceof Error) throw observation;
			return observation ?? null;
		},
		graceMs: 20,
		pollMs: 10,
	});
	// One live read, then two absent polls (window survives the replacement at
	// read 4 only because it reset), then three consecutive absent polls whose
	// third crosses the 20ms grace: 7 reads total, never fewer.
	expect(reads).toBe(7);
	expect(nowMs).toBe(60);
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
test("Windows lifecycle readiness uses the native process handle instead of signal-zero", () => {
	const originalPlatform = process.platform;
	const originalKill = process.kill;
	const processRef = {
		incarnation: "windows:133830291061234567",
		status: () => "running" as const,
	};
	const fromPid = vi.spyOn(native.Process, "fromPid").mockReturnValue(processRef as never);
	process.kill = (() => {
		throw Object.assign(new Error("signal zero unavailable"), { code: "EINVAL" });
	}) as typeof process.kill;
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	try {
		expect(observeProcessForTest(4_242, processRef.incarnation, () => processRef.incarnation)).toBe("alive");
		fromPid.mockReturnValue(null);
		expect(observeProcessForTest(4_242, processRef.incarnation, () => processRef.incarnation)).toBe("exited");
		fromPid.mockReturnValue({ ...processRef, status: () => "exited" as const } as never);
		expect(observeProcessForTest(4_242, processRef.incarnation, () => processRef.incarnation)).toBe("exited");
	} finally {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		process.kill = originalKill;
		fromPid.mockRestore();
	}
});
test("native absent-process null skips PowerShell on native Windows without repeated spawns (#4362, #4367)", () => {
	// The native binding returns null as the authoritative absent-process result.
	// processIncarnation must return undefined without spawning powershell.exe —
	// spawning it only allocates a console that Windows Terminal renders as a
	// visible window flash, and Get-Process cannot recover an incarnation either
	// because it uses the same OpenProcess path.  The test proves:
	//   1. A single absent-pid call never spawns.
	//   2. Repeated calls (simulating the broker's ~5s liveness poll) never spawn.
	//   3. The null check fires on every platform, not just win32.
	const originalPlatform = process.platform;
	const fromPid = vi.spyOn(native.Process, "fromPid").mockReturnValue(null);
	const spawnSync = vi.spyOn(Bun, "spawnSync");
	try {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		// Single call: no spawn
		expect(processIncarnation(4_242)).toBeUndefined();
		expect(spawnSync).not.toHaveBeenCalled();
		// Repeated calls simulating liveness polling: still no spawn
		for (let i = 0; i < 5; i++) expect(processIncarnation(4_242)).toBeUndefined();
		expect(spawnSync).not.toHaveBeenCalled();
	} finally {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		fromPid.mockRestore();
		spawnSync.mockRestore();
	}
});

test("native absent-process null returns undefined on every native platform", () => {
	// The null check is platform-agnostic: it fires on linux, darwin, and win32
	// because null is always the native binding's "process does not exist" result.
	const fromPid = vi.spyOn(native.Process, "fromPid").mockReturnValue(null);
	try {
		expect(processIncarnation(process.pid)).toBeUndefined();
	} finally {
		fromPid.mockRestore();
	}
});

test("native throw preserves PowerShell fallback on native Windows", () => {
	// When the native binding throws (addon not loaded, unexpected error),
	// the PowerShell fallback must be preserved — throwing does not mean absent.
	const originalPlatform = process.platform;
	const fromPid = vi.spyOn(native.Process, "fromPid").mockImplementation(() => {
		throw new Error("native binding error");
	});
	const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
		exitCode: 0,
		stdout: Buffer.from("4242\t133830291061234567\r\n", "utf8"),
		stderr: Buffer.alloc(0),
		success: true,
		signalCode: null,
		resourceUsage: undefined,
	} as unknown as Bun.SyncSubprocess<"pipe", "ignore">);
	try {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		expect(processIncarnation(4_242)).toBe("windows:133830291061234567");
		expect(spawnSync).toHaveBeenCalledTimes(1);
	} finally {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		fromPid.mockRestore();
		spawnSync.mockRestore();
	}
});

test("native non-canonical incarnation preserves PowerShell fallback on native Windows", () => {
	// When the native binding returns a non-null Process whose incarnation is
	// malformed (should not happen in practice but is defensively handled),
	// the PowerShell fallback must be preserved.
	const originalPlatform = process.platform;
	const fromPid = vi
		.spyOn(native.Process, "fromPid")
		.mockReturnValue({ incarnation: "garbage:not-canonical" } as unknown as native.Process);
	const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
		exitCode: 0,
		stdout: Buffer.from("4242\t133830291061234567\r\n", "utf8"),
		stderr: Buffer.alloc(0),
		success: true,
		signalCode: null,
		resourceUsage: undefined,
	} as unknown as Bun.SyncSubprocess<"pipe", "ignore">);
	try {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		expect(processIncarnation(4_242)).toBe("windows:133830291061234567");
		expect(spawnSync).toHaveBeenCalledTimes(1);
	} finally {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		fromPid.mockRestore();
		spawnSync.mockRestore();
	}
});

test("cross-platform win32 simulation still spawns PowerShell with windowsHide", () => {
	// When simulating win32 from another host (e.g. Linux CI), the PowerShell
	// contract is preserved for test-injected / cross-platform simulation.
	// windowsHide must still be set so the contract is never weakened.
	const fromPid = vi.spyOn(native.Process, "fromPid").mockReturnValue(null);
	const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
		exitCode: 0,
		stdout: Buffer.from("4242\t133830291061234567\r\n", "utf8"),
		stderr: Buffer.alloc(0),
		success: true,
		signalCode: null,
		resourceUsage: undefined,
	} as unknown as Bun.SyncSubprocess<"pipe", "ignore">);
	try {
		// On Linux, platform !== process.platform, so the native null check
		// does not fire even when fromPid returns null — the PowerShell path runs.
		expect(processIncarnation(4_242, { platform: "win32" })).toBe("windows:133830291061234567");
		expect(spawnSync).toHaveBeenCalledTimes(1);
		const options = spawnSync.mock.calls[0]?.[1] as { windowsHide?: boolean } | undefined;
		expect(options?.windowsHide).toBe(true);
	} finally {
		spawnSync.mockRestore();
		fromPid.mockRestore();
	}
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
const event={type:'host_registered',sessionId:id,locator: { cwd: agent, worktreeRoot: null, stateRoot: root },endpointGeneration:1,pid:process.pid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
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
const event={type:'host_registered',sessionId:id,locator: { cwd: 'fixture', worktreeRoot: null, stateRoot: root },endpointGeneration:1,pid:process.pid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
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
		if (previous === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previous;
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
		const source = SessionManager.create(sourceCwd, SessionManager.managedDestination(sourceCwd, agentDir));
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
			const session = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
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
		const source = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
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
			{ cwd: root, stateRoot, sessionId: sourceId, sessionPath: sourcePath, readinessTimeoutMs: 20_000 },
			"canonical-cold-resume",
		);
		expect(resumed).toMatchObject({ ok: true, result: { sessionId: sourceId } });
		if (!resumed.ok) throw new Error(resumed.error.message);
		const resumedGeneration = broker.index
			.listSessions()
			.sessions.find(session => session.sessionId === sourceId)?.endpointGeneration;
		if (resumedGeneration === undefined) throw new Error("Expected indexed resumed endpoint generation.");
		const proofRouter = new SessionRouter({ agentDir });
		const resumedSourceCandidate = await assertCanonicalSource();
		expect(resumedSourceCandidate.identity).toMatchObject({ canonicalPath: sourcePath, sessionId: sourceId });
		expect(resumedSourceCandidate.identity).not.toEqual(sourceCandidate.identity);
		expect(
			await broker.handleRequest("session.close", { sessionId: sourceId }, "canonical-cold-resume-close"),
		).toMatchObject({
			ok: true,
			result: { sessionId: sourceId },
		});
		expect(await proofRouter.generationStatus(sourceId, resumedGeneration)).toMatchObject({
			status: "retired",
			evidence: { source: "session_index", event: "host_unregistered" },
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
			{
				cwd: root,
				stateRoot,
				sourceSessionId: sourceId,
				sourceSessionPath: sourcePath,
				readinessTimeoutMs: 20_000,
			},
			"canonical-cold-fork",
		);
		expect(forked).toMatchObject({ ok: true });
		if (!forked.ok) throw new Error(forked.error.message);
		const forkResult = forked.result as { sessionId?: unknown };
		const forkId = String(forkResult.sessionId);
		const forkGeneration = broker.index
			.listSessions()
			.sessions.find(session => session.sessionId === forkId)?.endpointGeneration;
		if (forkGeneration === undefined) throw new Error("Expected indexed forked endpoint generation.");
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
		expect(await proofRouter.generationStatus(forkId, forkGeneration)).toMatchObject({
			status: "retired",
			evidence: { source: "session_index", event: "host_unregistered" },
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
		const forkDeleteInput = { cwd: root, stateRoot, sessionId: forkId, sessionPath: forkCandidate.path };
		expect(
			await settleRetainedTranscriptForTest(
				broker,
				forkDeleteInput,
				"canonical-cold-fork-delete",
				await broker.handleRequest("session.delete", forkDeleteInput, "canonical-cold-fork-delete"),
			),
		).toEqual({ ok: true, result: { sessionId: forkId } });
		expect(await proofRouter.generationStatus(forkId, forkGeneration)).toMatchObject({
			status: "retired",
			evidence: { source: "session_index", event: "session_deleted" },
		});
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: expect.not.arrayContaining([expect.objectContaining({ sessionId: forkId })]) },
		});
		expect(
			(await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as { sessionId?: string; type?: string })
				.findLast(event => event.sessionId === forkId),
		).toMatchObject({ type: "session_deleted", sessionId: forkId });
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
		const sourceDeleteInput = { cwd: root, stateRoot, sessionId: sourceId, sessionPath: sourcePath };
		expect(
			await settleRetainedTranscriptForTest(
				broker,
				sourceDeleteInput,
				"canonical-cold-resume-delete",
				await broker.handleRequest("session.delete", sourceDeleteInput, "canonical-cold-resume-delete"),
			),
		).toEqual({ ok: true, result: { sessionId: sourceId } });
		expect(await proofRouter.generationStatus(sourceId, resumedGeneration)).toMatchObject({
			status: "retired",
			evidence: { source: "session_index", event: "session_deleted" },
		});
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
		await proofRouter.stop();
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 50_000);

test("broker replays one identity-bound lifecycle metadata cleanup plan after the first delete detach", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-delete-metadata-crash-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const saved = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
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
		setLifecycleCleanupHookForTest(crashing, () => {});
		const deleteInput = { cwd: root, stateRoot, sessionId, sessionPath };
		await expect(
			settleRetainedTranscriptForTest(
				crashing,
				deleteInput,
				"delete-metadata-crash",
				await crashing.handleRequest("session.delete", deleteInput, "delete-metadata-crash"),
			),
		).resolves.toMatchObject({ ok: true, result: { sessionId } });
		await expect(fs.stat(markerPath)).rejects.toThrow();
		await expect(fs.stat(readyPath)).rejects.toThrow();
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
			const saved = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
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
			const deleteInput = { cwd: root, stateRoot, sessionId, sessionPath };
			const result = await settleRetainedTranscriptForTest(
				broker,
				deleteInput,
				`delete-incarnation-${name}`,
				await broker.handleRequest("session.delete", deleteInput, `delete-incarnation-${name}`),
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
	const saved = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
	const broker = new Broker({ agentDir });
	try {
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted delete transcript.");
		await saved.close();
		const artifactsPath = sessionPath.slice(0, -6);
		await fs.mkdir(path.join(artifactsPath, "nested"), { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(artifactsPath, "nested", "preserve.txt"), "preserve mismatch artifacts", {
			mode: 0o600,
		});

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
	const saved = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
	const broker = new Broker({ agentDir });
	try {
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted delete transcript.");
		await saved.close();
		const artifactsPath = sessionPath.slice(0, -6);
		await fs.mkdir(path.join(artifactsPath, "nested"), { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(artifactsPath, "nested", "preserve.txt"), "preserve ready-only artifacts", {
			mode: 0o600,
		});

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
		const requestHash = deleteRequestHash(request);
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(identity, requestHash);
		await ledger.transition(identity, "effect_started", {
			intendedSessionId: sessionId,
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
			intendedSessionId: mismatchedSessionId,
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
		const [markerStat, markerBytes, readyBytes, parentStat] = await Promise.all([
			fs.stat(markerPath, { bigint: true }),
			fs.readFile(markerPath),
			fs.readFile(readyPath),
			fs.stat(path.dirname(markerPath), { bigint: true }),
		]);
		const target = createHash("sha256").update(canonicalJson({ sessionId })).digest("hex");
		const identity = await deriveIdempotencyIdentity(agentDir, "session.delete", key, target);
		const requestHash = deleteRequestHash(request);
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(identity, requestHash);
		await ledger.transition(identity, "effect_started", {
			intendedSessionId: sessionId,
			response: {
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Lifecycle cleanup is pending.",
					cleanup: {
						phase: "lifecycle",
						sessionId,
						metadataRoot: stateRoot,
						lifecycleParentIdentity: {
							dev: parentStat.dev.toString(),
							ino: parentStat.ino.toString(),
						},
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
			nlink: stat.nlink.toString(),
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs.toString(),
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	};
	const cleanup = async (): Promise<BrokerCleanupEvidence> => ({
		phase: "lifecycle",
		sessionId,
		metadataRoot: stateRoot,
		lifecycleParentIdentity: await fs.stat(path.dirname(markerPath), { bigint: true }).then(stat => ({
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
		})),
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
		await ledger.begin(identity, deleteRequestHash(request));
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
			intendedSessionId: sessionId,
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
		await ledger.begin(identity, deleteRequestHash(request));
		await ledger.transition(identity, "effect_started", {
			intendedSessionId: sessionId,
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
		const lifecycleParent = await fs.stat(path.dirname(markerPath), { bigint: true });
		const identity = await deriveIdempotencyIdentity(
			agentDir,
			"session.delete",
			key,
			createHash("sha256").update(canonicalJson({ sessionId })).digest("hex"),
		);
		const ledger = await new LifecycleLedger(agentDir).open();
		await ledger.begin(identity, deleteRequestHash(request));
		await ledger.transition(identity, "effect_started", {
			intendedSessionId: sessionId,
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
						lifecycleParentIdentity: {
							dev: lifecycleParent.dev.toString(),
							ino: lifecycleParent.ino.toString(),
						},
						lifecycleFiles: captures.map(({ path: file, stat, bytes }) => ({
							path: file,
							identity: {
								dev: stat.dev.toString(),
								ino: stat.ino.toString(),
								nlink: stat.nlink.toString(),
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

test("broker preserves spawn_failed when the ChildProcess emits an error before PID ownership", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-child-error-"));
	const broker = new Broker({ agentDir: path.join(root, "agent") });
	try {
		setLifecycleCommandResolverForTest(broker, () => ({ file: path.join(root, "missing-gjc"), args: [] }));
		await broker.start();
		await expect(
			broker.handleRequest("session.create", { cwd: root }, "child-error-before-pid"),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "spawn_failed" },
		});
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("reaps only lifecycle markers whose exact owner is proven dead", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-marker-reap-"));
	const sdk = path.join(root, ".gjc", "state", "sdk");
	const deadId = "dead-session";
	const liveId = "live-session";
	const unreadableId = "unreadable-session";
	try {
		await fs.mkdir(sdk, { recursive: true });
		const dead = { pid: 999_999_999, effectMarker: "dead", incarnation: "linux:1" };
		const live = { pid: process.pid, effectMarker: "live", incarnation: await incarnation(process.pid) };
		await Bun.write(path.join(sdk, `${deadId}.lifecycle.json`), JSON.stringify(dead));
		await Bun.write(path.join(sdk, `${deadId}.lifecycle.ready.json`), JSON.stringify(dead));
		await Bun.write(path.join(sdk, `${liveId}.lifecycle.json`), JSON.stringify(live));
		await Bun.write(path.join(sdk, `${unreadableId}.lifecycle.json`), "not lifecycle JSON");
		const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(path.join(sdk, `${deadId}.lifecycle.json`), expiredAt, expiredAt);

		expect(await reapDeadLifecycleMarkers(path.dirname(sdk))).toBe(1);
		await expect(Bun.file(path.join(sdk, `${deadId}.lifecycle.json`)).exists()).resolves.toBe(false);
		await expect(Bun.file(path.join(sdk, `${deadId}.lifecycle.ready.json`)).exists()).resolves.toBe(false);
		await expect(Bun.file(path.join(sdk, `${liveId}.lifecycle.json`)).exists()).resolves.toBe(true);
		await expect(Bun.file(path.join(sdk, `${unreadableId}.lifecycle.json`)).exists()).resolves.toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("bounds stale lifecycle marker inspection even when candidates are not reapable", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-marker-limit-"));
	const stateRoot = path.join(root, ".gjc", "state");
	const sdk = path.join(stateRoot, "sdk");
	const originalKill = process.kill;
	let observations = 0;
	try {
		await fs.mkdir(sdk, { recursive: true });
		const live = { pid: process.pid, effectMarker: "live", incarnation: await incarnation(process.pid) };
		for (let index = 0; index < 5; index += 1)
			await Bun.write(path.join(sdk, `live-${index}.lifecycle.json`), JSON.stringify(live));
		process.kill = ((pid, signal) => {
			observations += 1;
			return originalKill.call(process, pid, signal);
		}) as typeof process.kill;

		expect(await reapDeadLifecycleMarkers(stateRoot, 2)).toBe(0);
		expect(observations).toBe(2);
	} finally {
		process.kill = originalKill;
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("does not follow lifecycle sdk symlinks or partially reap an unsafe ready sibling", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-marker-safety-"));
	const stateRoot = path.join(root, ".gjc", "state");
	const redirectedSdk = path.join(root, "redirected-sdk");
	const dead = { pid: 999_999_999, effectMarker: "dead", incarnation: "linux:1" };
	try {
		await fs.mkdir(redirectedSdk, { recursive: true });
		await fs.mkdir(stateRoot, { recursive: true });
		await fs.symlink(redirectedSdk, path.join(stateRoot, "sdk"));
		await Bun.write(path.join(redirectedSdk, "redirected.lifecycle.json"), JSON.stringify(dead));
		expect(await reapDeadLifecycleMarkers(stateRoot)).toBe(0);
		await expect(Bun.file(path.join(redirectedSdk, "redirected.lifecycle.json")).exists()).resolves.toBe(true);

		await fs.rm(path.join(stateRoot, "sdk"));
		await fs.mkdir(path.join(stateRoot, "sdk"));
		const markerPath = path.join(stateRoot, "sdk", "unsafe-ready.lifecycle.json");
		await Bun.write(markerPath, JSON.stringify(dead));
		await Bun.write(path.join(stateRoot, "sdk", "unsafe-ready.lifecycle.ready.json"), "unsafe ready sibling");
		const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(markerPath, expiredAt, expiredAt);
		expect(await reapDeadLifecycleMarkers(stateRoot)).toBe(0);
		await expect(Bun.file(markerPath).exists()).resolves.toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("retains the concrete spawn failure when cleanup proof is unavailable", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-spawn-failure-cause-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	try {
		setLifecycleCommandResolverForTest(broker, () => {
			throw new Error("runtime executable is not a readable regular file.");
		});
		await broker.start();
		const response = await broker.handleRequest("session.create", { cwd: root }, "concrete-spawn-failure");
		expect(response).toEqual({
			ok: false,
			error: {
				code: "spawn_failed",
				message: "Unable to spawn session: runtime executable is not a readable regular file.",
			},
		});
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
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

test("broker preserves a code-less lifecycle startup failure message", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-startup-message-"));
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "startup-failure.ts");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`import { writeSessionLifecycleFailure } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"))};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
await writeSessionLifecycleFailure(
	request.stateRoot,
	request.sessionId,
	request.effectMarker,
	{ phase: "startup", reason: "failed", message: "owned synthetic startup failure" },
	{ endpointGeneration: null, fenced: true, runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true },
);
await Bun.sleep(60_000);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 4_000 },
			"code-less-startup-failure",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", message: "owned synthetic startup failure" },
		});
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
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
await index.append({ type: "host_registered", sessionId: request.sessionId, locator: { cwd: request.cwd, worktreeRoot: null, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs, lifecycleRequestId: request.effectMarker });
const source = await fs.readFile(request.sessionPath);
const stat = await fs.stat(request.sessionPath, { bigint: true });
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "owned synthetic startup failure" }, { endpointGeneration, fenced: true, runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true }, { digest: createHash("sha256").update(source).digest("hex"), identity: { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), mtimeNs: stat.mtimeNs.toString(), sha256: createHash("sha256").update(source).digest("hex") } });

await index.append({ type: "host_unregistered", sessionId: request.sessionId, locator: { cwd: request.cwd, worktreeRoot: null, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, lifecycleRequestId: request.effectMarker });
await fs.rm(endpoint);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		const saved = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
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
			SessionManager.managedDestination(normalRoot, normalAgentDir),
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
			expect(normalResponse).toMatchObject({
				ok: false,
				error: { code: "spawn_failed", message: "owned synthetic startup failure" },
			});
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
	const host = spawnDisposableHost();
	const shared = {
		sessionId: "reused-registration",
		locator: { cwd: "fixture", worktreeRoot: null, stateRoot: path.join(agentDir, "state") },
		endpointGeneration: 5,
		pid: host.pid,
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
	const host = spawnDisposableHost();
	const shared = {
		sessionId: "ordinary-host",
		locator: { cwd: "fixture", worktreeRoot: null, stateRoot: path.join(agentDir, "state") },
		endpointGeneration: 6,
		pid: host.pid,
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

test("session index accepts a legacy unregister that predates endpoint file identity", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-session-index-legacy-unregister-"));
	const index = await new SessionIndex(agentDir).open();
	try {
		const shared = {
			sessionId: "legacy-unregister",
			locator: { cwd: "fixture", worktreeRoot: null, stateRoot: path.join(agentDir, "state") },
			endpointGeneration: 7,
			pid: process.pid,
			lifecycleRequestId: "legacy-close",
		};
		const registration = await index.append({
			type: "host_registered",
			...shared,
			endpointMtimeMs: 1234,
			endpointFileId: "11:22",
		});
		await index.append({ type: "host_unregistered", ...shared });
		expect(index.hostUnregisteredAfter(registration)).toEqual({
			indexSeq: registration.indexSeq + 1,
			lifecycleRequestId: "legacy-close",
		});
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
		await fs.writeFile(path.join(repo, ".gitignore"), "/.worktrees\n");
		const committed = Bun.spawnSync(["git", "add", "README", ".gitignore"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
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
const event={type:'host_registered',sessionId:id,locator: { cwd: 'foreign', worktreeRoot: null, stateRoot: root },endpointGeneration:1,pid:process.ppid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
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

test("broker fences ambiguous state roots from checkpoint, endpoint, and resume authority until one resolves", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ambiguous-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const alternateStateRoot = path.join(root, ".gjc", "alternate-state");
	const broker = new Broker({ agentDir });
	const source = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
	await source.ensureOnDisk();
	const sessionId = source.getSessionId();
	const sessionPath = source.getSessionFile();
	if (!sessionPath) throw new Error("Expected a saved session path.");
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	let launchAttempts = 0;
	try {
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "current-token" }),
		);
		const endpointIdentity = await fs.stat(endpointPath, { bigint: true });
		const endpointMtimeMs = Number(endpointIdentity.mtimeNs) / 1_000_000;
		const endpointFileId = `${endpointIdentity.dev}:${endpointIdentity.ino}`;
		await broker.start();
		setLifecycleCommandResolverForTest(broker, () => {
			launchAttempts += 1;
			return { file: "/bin/false", args: [] };
		});
		const alternate = await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot: alternateStateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: 1,
		});
		const current = await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs,
			endpointFileId,
		});
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({
				sessionId,
				endpointGeneration: current.endpointGeneration,
				ambiguous: true,
				live: false,
			}),
		]);
		const ambiguousSeq = broker.index.indexSeq;
		expect(await broker.heartbeatSessions()).toBe(0);
		expect(broker.index.indexSeq).toBe(ambiguousSeq);
		expect(await reapDeadSessionRegistrations({ index: broker.index })).toEqual([]);
		expect(broker.index.indexSeq).toBe(ambiguousSeq);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId })).toEqual({
			ok: false,
			error: { code: "resource_gone", message: "session endpoint record is gone" },
		});
		expect(
			await broker.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"ambiguous-resume",
			),
		).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "Session authority is ambiguous and cannot be resumed safely." },
		});
		expect(launchAttempts).toBe(0);

		await broker.index.append({
			type: "host_unregistered",
			sessionId,
			locator: alternate.locator,
			endpointGeneration: alternate.endpointGeneration,
			pid: alternate.pid,
			...(alternate.processIncarnation === undefined ? {} : { processIncarnation: alternate.processIncarnation }),
			...(alternate.hostIncarnation === undefined ? {} : { hostIncarnation: alternate.hostIncarnation }),
		});
		expect(await broker.heartbeatSessions()).toBe(1);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId })).toMatchObject({
			ok: true,
			result: { sessionId, pid: process.pid, token: "current-token" },
		});
		expect(
			await broker.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"resolved-resume",
			),
		).toMatchObject({
			ok: true,
			result: {
				sessionId,
				endpointGeneration: current.endpointGeneration,
				endpointFileId,
				reused: true,
				endpoint: { token: "current-token" },
			},
		});

		const originalHandleRequest = broker.handleRequest.bind(broker);
		let racingOwner: SessionIndexEvent | undefined;
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			const response = await originalHandleRequest(operation, input, idempotencyKey);
			if (operation === "session.get_endpoint" && input.sessionId === sessionId && racingOwner === undefined) {
				racingOwner = await broker.index.append({
					type: "host_registered",
					sessionId,
					locator: { cwd: root, worktreeRoot: null, stateRoot: alternateStateRoot },
					endpointGeneration: alternate.endpointGeneration,
					pid: process.pid,
					endpointMtimeMs: 1,
				});
			}
			return response;
		};
		expect(
			await broker.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"racing-owner-resume",
			),
		).toEqual({
			ok: false,
			error: {
				code: "endpoint_stale",
				message: "Session authority became ambiguous while it was being verified.",
			},
		});
		broker.handleRequest = originalHandleRequest;
		if (!racingOwner) throw new Error("Expected the competing live owner to be registered.");
		await broker.index.append({
			type: "host_unregistered",
			sessionId,
			locator: racingOwner.locator,
			endpointGeneration: racingOwner.endpointGeneration,
			pid: racingOwner.pid,
			...(racingOwner.processIncarnation === undefined
				? {}
				: { processIncarnation: racingOwner.processIncarnation }),
			...(racingOwner.hostIncarnation === undefined ? {} : { hostIncarnation: racingOwner.hostIncarnation }),
		});

		const replayAlternate = await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot: alternateStateRoot },
			endpointGeneration: alternate.endpointGeneration,
			pid: process.pid,
			endpointMtimeMs: 1,
		});
		expect(
			await broker.handleRequest(
				"session.resume",
				{ cwd: root, stateRoot, sessionId, sessionPath },
				"resolved-resume",
			),
		).toEqual({
			ok: false,
			error: { code: "resource_gone", message: "session endpoint record is gone" },
		});
		await broker.index.append({
			type: "host_unregistered",
			sessionId,
			locator: replayAlternate.locator,
			endpointGeneration: replayAlternate.endpointGeneration,
			pid: replayAlternate.pid,
			...(replayAlternate.processIncarnation === undefined
				? {}
				: { processIncarnation: replayAlternate.processIncarnation }),
			...(replayAlternate.hostIncarnation === undefined ? {} : { hostIncarnation: replayAlternate.hostIncarnation }),
		});
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("broker promotes the lower-generation root after the higher-generation root terminates", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ambiguous-reverse-"));
	const agentDir = path.join(root, "agent");
	const currentStateRoot = path.join(root, ".gjc", "state");
	const alternateRepo = path.join(root, "alternate-worktree");
	const alternateStateRoot = path.join(alternateRepo, ".gjc", "state");
	const broker = new Broker({ agentDir });
	const sessionId = "reverse-root";
	const endpointPath = path.join(alternateStateRoot, "sdk", `${sessionId}.json`);
	try {
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await Bun.write(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "alternate-token" }),
		);
		const alternateEndpointIdentity = await fs.stat(endpointPath, { bigint: true });
		const alternateEndpointMtimeMs = Number(alternateEndpointIdentity.mtimeNs) / 1_000_000;
		const alternateEndpointFileId = `${alternateEndpointIdentity.dev}:${alternateEndpointIdentity.ino}`;
		await broker.start();
		const alternate = await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: alternateRepo, worktreeRoot: null, stateRoot: alternateStateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs: alternateEndpointMtimeMs,
			endpointFileId: alternateEndpointFileId,
		});
		const current = await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot: currentStateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: 1,
		});
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId, endpointGeneration: current.endpointGeneration, ambiguous: true }),
		]);

		await broker.index.append({
			type: "host_unregistered",
			sessionId,
			locator: current.locator,
			endpointGeneration: current.endpointGeneration,
			pid: current.pid,
			...(current.processIncarnation === undefined ? {} : { processIncarnation: current.processIncarnation }),
			...(current.hostIncarnation === undefined ? {} : { hostIncarnation: current.hostIncarnation }),
		});
		expect(await broker.heartbeatSessions()).toBe(1);
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({
				sessionId,
				locator: alternate.locator,
				endpointGeneration: alternate.endpointGeneration,
				ambiguous: false,
				live: true,
			}),
		]);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId })).toMatchObject({
			ok: true,
			result: { sessionId, pid: process.pid, token: "alternate-token" },
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("broker refuses a stale registered PID when no durable effect marker proves ownership", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-stale-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const host = spawnDisposableHost();
	try {
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "stale",
			locator: { cwd: "fixture", worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: host.pid,
		});
		expect(await broker.handleRequest("session.close", { sessionId: "stale" }, "stale-close")).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});

		expect(host.exitCode).toBeNull();
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker closes a live host whose workspace state root is gone using its registered incarnation", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-lost-workspace-"));
	// The workspace — and with it the spawn-time lifecycle marker and endpoint —
	// was deleted while the host kept running, which is exactly how an orphan that
	// still serves its original source outlives every later close attempt.
	const stateRoot = path.join(agentDir, "deleted-workspace", ".gjc", "state");
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	const pid = child.pid;
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		const incarnation = processIncarnation(pid);
		expect(incarnation).toBeString();

		await broker.index.append({
			type: "host_registered",
			sessionId: "wrong-incarnation",
			locator: { cwd: "fixture", worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid,
			processIncarnation: `${incarnation}-recycled`,
			lifecycleRequestId: "wrong-incarnation-request",
		});
		expect(await broker.handleRequest("session.close", { sessionId: "wrong-incarnation" }, "recycled-close")).toEqual(
			{
				ok: false,
				error: {
					code: "terminal_uncertain",
					message:
						"Session did not close after SIGTERM and its durable process identity could not be verified for SIGKILL.",
				},
			},
		);
		expect(child.exitCode).toBeNull();

		await broker.index.append({
			type: "host_registered",
			sessionId: "orphan",
			locator: { cwd: "fixture", worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid,
			processIncarnation: incarnation,
			lifecycleRequestId: "orphan-request",
		});
		const closed = await broker.handleRequest("session.close", { sessionId: "orphan" }, "orphan-close");
		expect(closed).toMatchObject({ ok: true, result: { sessionId: "orphan" } });
		expect(await child.exited).toBe(143);
		// The killed host never withdrew its own registration, so the broker owes the
		// index that retirement; leaving it open would keep advertising a dead session.
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: {
				sessions: [
					expect.objectContaining({ sessionId: "wrong-incarnation" }),
					expect.objectContaining({ sessionId: "orphan", terminal: true, live: false }),
				],
			},
		});
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 15_000);

test("broker refuses same-generation close authority from a prior endpoint incarnation", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-close-incarnation-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "successor";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	const host = spawnDisposableHost();
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: host.pid, url: "ws://127.0.0.1:1", token: "successor-token" }),
		);
		const endpointMtimeMs = (await fs.stat(endpoint)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: "fixture", worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: host.pid,
			endpointMtimeMs,
		});
		const staleEndpointIncarnation = createHash("sha256")
			.update(
				JSON.stringify({
					endpointGeneration: 1,
					endpointMtimeMs: endpointMtimeMs - 1,
					pid: host.pid,
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

test("dead endpoint cleanup preserves a successor rebound between capture and native unlink", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-dead-endpoint-rebind-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "dead-endpoint-rebind";
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const successorPath = path.join(stateRoot, "sdk", `${sessionId}.successor.json`);
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);

	const child = Bun.spawn(["/bin/sleep", "30"]);
	const broker = new Broker({ agentDir });
	const originalExactUnlink = native.exactUnlink.bind(native);
	let intercepted = false;
	const originalHandleRequest = broker.handleRequest.bind(broker);

	try {
		const childIncarnation = await waitFor(
			async () => processIncarnation(child.pid) ?? undefined,
			"child incarnation",
		);

		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: child.pid, url: "ws://127.0.0.1:1", token: "retired-token" }),
		);
		await fs.utimes(endpointPath, 1_700_000_000, 1_700_000_000);
		await fs.writeFile(
			markerPath,
			canonicalJson({ pid: child.pid, effectMarker: "dead-endpoint-rebind-request", incarnation: childIncarnation }),
		);

		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: child.pid,
			endpointMtimeMs,
			lifecycleRequestId: "dead-endpoint-rebind-request",
			processIncarnation: childIncarnation,
		});
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.get_endpoint" && input.sessionId === sessionId)
				return { ok: false, error: { code: "resource_gone", message: "session endpoint record is gone" } };
			return originalHandleRequest(operation, input, idempotencyKey);
		};

		child.kill("SIGKILL");
		await child.exited;
		await fs.writeFile(
			successorPath,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:2", token: "successor-token" }),
		);
		const unlinkSpy = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === endpointPath && !intercepted) {
				intercepted = true;
				syncFs.renameSync(successorPath, endpointPath);
			}
			return originalExactUnlink(pathname, identity);
		});
		try {
			await expect(
				broker.handleRequest("session.close", { sessionId }, "dead-endpoint-rebind-close"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "terminal_uncertain" },
			});
		} finally {
			unlinkSpy.mockRestore();
		}
		expect(intercepted).toBe(true);
		expect(await fs.readFile(endpointPath, "utf8")).toContain("successor-token");
		const registration = broker.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		expect(registration).toMatchObject({ endpointGeneration: 1, pid: child.pid });
		broker.handleRequest = originalHandleRequest;
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
test("broker rebinds implicit close only for a matching non-empty lifecycle request id", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-close-rebind-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const originalHandleRequest = broker.handleRequest.bind(broker);
	try {
		await broker.start();
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		for (const [label, initialRequestId, replacementRequestId, successor, expectedCode] of [
			["same", "request-a", "request-a", false, "close_refused"],
			["absent", undefined, undefined, false, "endpoint_stale"],
			["empty", "", "", false, "endpoint_stale"],
			["different", "request-a", "request-b", false, "endpoint_stale"],
			["successor", "request-a", "request-a", true, "endpoint_stale"],
		] as const) {
			const host = spawnDisposableHost();
			const processIdentity = await waitFor(
				async () => processIncarnation(host.pid) ?? undefined,
				`${label} fixture host incarnation`,
			);
			const replacementIncarnation = successor ? `${processIdentity}:successor` : processIdentity;
			const sessionId = `close-rebind-${label}`;
			const locator = { cwd: "fixture", worktreeRoot: null, stateRoot };
			await fs.writeFile(
				path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
				JSON.stringify({
					pid: host.pid,
					effectMarker: "fixture-mismatched-request",
					incarnation: processIdentity,
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator,
				endpointGeneration: 1,
				pid: host.pid,
				endpointMtimeMs: 1,
				processIncarnation: processIdentity,
				...(initialRequestId === undefined ? {} : { lifecycleRequestId: initialRequestId }),
			});
			await broker.index.append({
				type: "host_heartbeat",
				sessionId,
				locator,
				endpointGeneration: 1,
				pid: host.pid,
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
							pid: host.pid,
							endpointMtimeMs: 2,
							processIncarnation: replacementIncarnation,
							...(replacementRequestId === undefined ? {} : { lifecycleRequestId: replacementRequestId }),
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
			expect(host.exitCode).toBeNull();
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
	const savedSession = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
	await savedSession.ensureOnDisk();
	const sessionId = savedSession.getSessionId();
	const sessionPath = savedSession.getSessionFile();
	if (!sessionPath) throw new Error("Expected saved session path.");
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	const host = spawnDisposableHost();
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await Bun.write(
			endpointPath,
			JSON.stringify({ sessionId, pid: host.pid, url: "ws://127.0.0.1:1", token: "live-owner-token" }),
		);
		const endpointIdentity = await fs.stat(endpointPath, { bigint: true });
		const hostIncarnation = await incarnation(host.pid);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 17,
			pid: host.pid,
			endpointMtimeMs: Number(endpointIdentity.mtimeNs) / 1_000_000,
			endpointFileId: `${endpointIdentity.dev}:${endpointIdentity.ino}`,
			processIncarnation: hostIncarnation,
			hostIncarnation,
		});
		await broker.index.append({
			type: "host_heartbeat",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 17,
			pid: host.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
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
test("session.create rejects a forged effective host incarnation during readiness", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-forged-host-incarnation-"));
	const workspace = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(workspace, ".gjc", "state");
	const broker = new Broker({ agentDir });
	try {
		await fs.mkdir(workspace, { recursive: true });
		await broker.start();
		const index = await new SessionIndex(agentDir).open();
		const forgeOwner = (async () => {
			const row = await waitFor(async () => {
				await index.refresh();
				return index
					.listSessionIdentities()
					.find(session => session.endpointGeneration > 0 && session.lifecycleRequestId !== undefined);
			}, "lifecycle host registration");
			const actualIncarnation = row.hostIncarnation ?? row.processIncarnation;
			if (!actualIncarnation) throw new Error("Expected lifecycle host incarnation.");
			const forgedIncarnation = `${actualIncarnation}:forged`;
			await index.append({
				type: "host_registered",
				sessionId: row.sessionId,
				locator: row.locator,
				endpointGeneration: row.endpointGeneration,
				pid: row.pid,
				endpointMtimeMs: row.endpointMtimeMs,
				...(row.endpointFileId === undefined ? {} : { endpointFileId: row.endpointFileId }),
				lifecycleRequestId: row.lifecycleRequestId,
				processIncarnation: actualIncarnation,
				hostIncarnation: forgedIncarnation,
			});
		})();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: workspace, stateRoot, readinessTimeoutMs: 7_000 },
			"forged-host-incarnation",
		);
		await forgeOwner;
		expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
test("broker never signals a PID reused after its lifecycle marker was written", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reused-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "reused";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const marker = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const broker = new Broker({ agentDir });
	const host = spawnDisposableHost();
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: host.pid, url: "ws://127.0.0.1:1", token: "stale" }),
		);
		await fs.writeFile(
			marker,
			JSON.stringify({ pid: host.pid, effectMarker: "old-effect", incarnation: "reused-process-incarnation" }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: "fixture", worktreeRoot: null, stateRoot },
			endpointGeneration: 7,
			pid: host.pid,
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
		expect(host.exitCode).toBeNull();
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("broker binds close-escalation terminal uncertainty to the indexed reused-pid incarnation", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reused-terminal-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "reused-terminal";
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const endpointServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("WebSocket required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "reused-terminal" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as { id?: string; type?: string };
				if (frame.type === "control_request" && frame.id) socket.send(JSON.stringify({ id: frame.id, ok: true }));
			},
		},
	});
	const broker = new Broker({ agentDir });
	const originalHandleRequest = broker.handleRequest.bind(broker);
	const indexedIncarnation = "reused-indexed-incarnation";
	let now = 0;
	try {
		if (!child.pid) throw new Error("fixture child has no pid");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		const endpoint = {
			sessionId,
			pid: child.pid,
			url: `ws://127.0.0.1:${endpointServer.port}`,
			token: "reused-terminal-token",
		};
		await fs.writeFile(endpointPath, JSON.stringify(endpoint));
		await fs.writeFile(
			markerPath,
			JSON.stringify({ pid: child.pid, effectMarker: "reused-terminal-effect", incarnation: indexedIncarnation }),
		);
		await broker.start();
		setLifecycleTimingForTest(broker, {
			now: () => now,
			sleep: async milliseconds => {
				now += milliseconds;
			},
		});
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: child.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			lifecycleRequestId: "reused-terminal-effect",
			processIncarnation: indexedIncarnation,
			hostIncarnation: indexedIncarnation,
		});
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.get_endpoint" && input.sessionId === sessionId)
				return { ok: true, result: endpoint };
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		expect(await broker.handleRequest("session.close", { sessionId }, "reused-terminal-close")).toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		const terminal = (await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.findLast(event => event.type === "lifecycle_terminal");
		expect(terminal).toMatchObject({
			type: "lifecycle_terminal",
			sessionId,
			processIncarnation: indexedIncarnation,
			hostIncarnation: indexedIncarnation,
			terminalUncertain: true,
		});
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId, terminalUncertain: true }),
		]);
		expect(await broker.handleRequest("session.delete", { sessionId }, "reused-terminal-delete")).toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
	} finally {
		broker.handleRequest = originalHandleRequest;
		setLifecycleTimingForTest(broker, undefined);
		endpointServer.stop(true);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
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
			locator: { cwd: "fixture", worktreeRoot: null, stateRoot },
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

test("reconcile_uncertain retires one dead create identity and refuses live hosts", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reconcile-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const sessionId = "reconcile-proof";
	const child = spawnDisposableHost();
	const broker = new Broker({ agentDir });
	try {
		const processIdentity = await incarnation(child.pid!);
		await broker.start();
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		const marker = { pid: child.pid!, effectMarker: "reconcile-effect", incarnation: processIdentity };
		await fs.writeFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`), canonicalJson(marker));
		await fs.writeFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`), canonicalJson(marker));
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		await fs.writeFile(endpointPath, canonicalJson({ sessionId, pid: child.pid! }));
		const endpointStat = await fs.stat(endpointPath);
		const endpointFileId = `${endpointStat.dev}:${endpointStat.ino}`;
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: 4,
			pid: child.pid!,
			endpointMtimeMs: endpointStat.mtimeMs,
			endpointFileId,
			lifecycleRequestId: "reconcile-effect",
			processIncarnation: processIdentity,
			hostIncarnation: processIdentity,
			terminalUncertain: true,
		});
		await fs.rm(endpointPath);
		const createIdentity = "reconcile-create-identity";
		await broker.ledger.begin(createIdentity, "reconcile-create-request");
		await broker.ledger.transition(createIdentity, "terminal_uncertain", {
			intendedSessionId: sessionId,
			effectMarker: "reconcile-effect",
			effectIntent: { sessionId, stateRoot, childOwnershipEstablished: true },
			operationKey: "session.create\u0000reconcile-create-key",
			response: { ok: false, error: { code: "terminal_uncertain", message: "fixture" } },
		});
		await expect(
			broker.handleRequest(
				"session.reconcile_uncertain",
				{
					sessionId,
					cwd: agentDir,
					stateRoot,
					endpointGeneration: 4,
					endpointMtimeMs: endpointStat.mtimeMs,
					processIncarnation: processIdentity,
					hostIncarnation: processIdentity,
					lifecycleRequestId: "reconcile-effect",
				},
				"reconcile-missing-remote-key",
			),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		await expect(
			broker.handleRequest(
				"session.reconcile_uncertain",
				{
					sessionId,
					cwd: agentDir,
					stateRoot,
					endpointGeneration: 4,
					endpointMtimeMs: endpointStat.mtimeMs,
					processIncarnation: processIdentity,
					hostIncarnation: processIdentity,
					lifecycleRequestId: "reconcile-effect",
					remoteCreateKey: "reconcile-create-key",
				},
				"reconcile-live",
			),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		await expect(
			broker.handleRequest(
				"session.reconcile_uncertain",
				{
					sessionId,
					cwd: agentDir,
					stateRoot,
					endpointGeneration: 4,
					endpointMtimeMs: endpointStat.mtimeMs,
					processIncarnation: processIdentity,
					hostIncarnation: processIdentity,
					lifecycleRequestId: "stale-marker",
					remoteCreateKey: "reconcile-create-key",
				},
				"reconcile-stale-marker",
			),
		).resolves.toMatchObject({ ok: false, error: { code: "retirement_proof_stale" } });
		child.kill("SIGKILL");
		await child.exited;
		await expect(
			broker.handleRequest(
				"session.reconcile_uncertain",
				{
					sessionId,
					cwd: agentDir,
					stateRoot,
					endpointGeneration: 4,
					endpointMtimeMs: endpointStat.mtimeMs,
					processIncarnation: processIdentity,
					hostIncarnation: processIdentity,
					lifecycleRequestId: "reconcile-effect",
					remoteCreateKey: "reconcile-create-key",
					endpointFileId: "arbitrary-file-id",
				},
				"reconcile-mismatched-file-id",
			),
		).resolves.toMatchObject({ ok: false, error: { code: "retirement_proof_stale" } });
		const deadResponse = await broker.handleRequest(
			"session.reconcile_uncertain",
			{
				sessionId,
				cwd: agentDir,
				stateRoot,
				endpointGeneration: 4,
				endpointMtimeMs: endpointStat.mtimeMs,
				processIncarnation: processIdentity,
				hostIncarnation: processIdentity,
				lifecycleRequestId: "reconcile-effect",
				remoteCreateKey: "reconcile-create-key",
			},
			"reconcile-dead",
		);
		let retiredResponse = deadResponse;
		for (let attempt = 0; attempt < 4 && !retiredResponse.ok; attempt++) {
			if (retiredResponse.error.code !== "cleanup_pending") break;
			retiredResponse = await broker.handleRequest(
				"session.reconcile_uncertain",
				{
					sessionId,
					cwd: agentDir,
					stateRoot,
					endpointGeneration: 4,
					endpointMtimeMs: endpointStat.mtimeMs,
					processIncarnation: processIdentity,
					hostIncarnation: processIdentity,
					lifecycleRequestId: "reconcile-effect",
					remoteCreateKey: "reconcile-create-key",
				},
				"reconcile-dead",
			);
		}
		expect(retiredResponse).toMatchObject({
			ok: true,
			result: { sessionId, retired: true, indexType: "session_closed", endpointFileId },
		});
		expect(broker.ledger.get(createIdentity)).toMatchObject({
			state: "terminal_error",
			intendedSessionId: sessionId,
		});
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId, terminal: true, terminalUncertain: false, live: false }),
		]);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("reconcile_uncertain replays a ledger-stage receipt after deletion and same-ID replacement", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reconcile-delete-race-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const sessionId = "reconcile-delete-race";
	const lifecycleRequestId = "reconcile-delete-effect";
	const remoteCreateKey = "reconcile-delete-create";
	const retirementKey = "reconcile-delete-retirement";
	const child = spawnDisposableHost();
	const broker = new Broker({ agentDir });
	const createIdentity = "reconcile-delete-create-identity";
	try {
		if (!child.pid) throw new Error("fixture child has no pid");
		const processIdentity = await incarnation(child.pid);
		const input = {
			sessionId,
			cwd: agentDir,
			stateRoot,
			endpointGeneration: 4,
			endpointMtimeMs: 1,
			lifecycleRequestId,
			processIncarnation: processIdentity,
			hostIncarnation: processIdentity,
			remoteCreateKey,
		};
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		const marker = { pid: child.pid, effectMarker: lifecycleRequestId, incarnation: processIdentity };
		await fs.writeFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`), canonicalJson(marker));
		await fs.writeFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`), canonicalJson(marker));
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: input.endpointGeneration,
			pid: process.pid,
			endpointMtimeMs: input.endpointMtimeMs,
			lifecycleRequestId: "older-incarnation",
			processIncarnation: "older-process",
			hostIncarnation: "older-host",
		});
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: input.endpointGeneration,
			pid: child.pid,
			endpointMtimeMs: input.endpointMtimeMs,
			lifecycleRequestId,
			processIncarnation: processIdentity,
			hostIncarnation: processIdentity,
		});
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: input.endpointGeneration,
			pid: child.pid,
			endpointMtimeMs: input.endpointMtimeMs,
			lifecycleRequestId,
			processIncarnation: processIdentity,
			hostIncarnation: processIdentity,
			terminalUncertain: true,
		});
		await broker.ledger.begin(createIdentity, "reconcile-delete-create-request");
		await broker.ledger.transition(createIdentity, "terminal_uncertain", {
			intendedSessionId: sessionId,
			effectMarker: lifecycleRequestId,
			effectIntent: { sessionId, stateRoot, childOwnershipEstablished: true },
			operationKey: `session.create\u0000${remoteCreateKey}`,
			response: { ok: false, error: { code: "terminal_uncertain", message: "fixture" } },
		});
		child.kill("SIGKILL");
		await child.exited;

		const originalTransition = broker.ledger.transition.bind(broker.ledger);
		let injectCrash = true;
		const transitionSpy = vi
			.spyOn(broker.ledger, "transition")
			.mockImplementation(async (identity, state, fields) => {
				if (injectCrash && identity === createIdentity && state === "terminal_error") {
					injectCrash = false;
					throw new Error("simulated broker crash after retirement ledger stage");
				}
				return originalTransition(identity, state, fields);
			});
		const first = await broker.handleRequest("session.reconcile_uncertain", input, retirementKey);
		transitionSpy.mockRestore();
		expect(first).toMatchObject({
			ok: false,
			error: {
				code: "cleanup_pending",
				cleanup: { uncertainRetirement: { stage: "ledger", indexSeq: expect.any(Number) } },
			},
		});

		const staged = broker.ledger.findByOperationKey(`session.reconcile_uncertain\u0000${retirementKey}`);
		expect(staged?.response).toMatchObject({
			ok: false,
			error: { cleanup: { uncertainRetirement: { stage: "ledger" } } },
		});
		const indexed = broker.index.listSessionIdentities().find(session => session.sessionId === sessionId);
		if (!indexed) throw new Error("Expected staged retirement identity in the index");
		await broker.index.append({
			type: "session_deleted",
			sessionId: indexed.sessionId,
			locator: indexed.locator,
			endpointGeneration: indexed.endpointGeneration,
			pid: indexed.pid,
			processIncarnation: indexed.processIncarnation,
			hostIncarnation: indexed.hostIncarnation,
			endpointMtimeMs: indexed.endpointMtimeMs,
			lifecycleRequestId: indexed.lifecycleRequestId,
		});
		await expect(
			broker.handleRequest("session.reconcile_uncertain", input, "reconcile-delete-without-receipt"),
		).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: indexed.locator,
			endpointGeneration: indexed.endpointGeneration,
			pid: indexed.pid,
			endpointMtimeMs: input.endpointMtimeMs + 1,
			lifecycleRequestId: "same-id-successor",
			processIncarnation: input.processIncarnation,
			hostIncarnation: input.hostIncarnation,
		});
		await broker.stop();

		const reopened = new Broker({ agentDir });
		await reopened.start();
		const replay = await reopened.handleRequest("session.reconcile_uncertain", input, retirementKey);
		expect(replay).toMatchObject({ ok: true, result: { sessionId, retired: true, indexType: "session_closed" } });
		expect(reopened.ledger.get(createIdentity)).toMatchObject({ state: "terminal_error" });
		expect(reopened.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId, endpointGeneration: indexed.endpointGeneration }),
		]);

		await expect(
			reopened.handleRequest(
				"session.reconcile_uncertain",
				{ ...input, endpointMtimeMs: input.endpointMtimeMs + 1 },
				retirementKey,
			),
		).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		const events = (await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { sessionId?: string; type?: string });
		expect(events.filter(event => event.sessionId === sessionId && event.type === "session_closed")).toHaveLength(1);
		expect(events.filter(event => event.sessionId === sessionId && event.type === "session_deleted")).toHaveLength(1);
		await reopened.stop();
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("reconcile_uncertain fails closed when deletion wins the closure append race", async () => {
	const agentDir = await fs.mkdtemp(
		path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reconcile-index-delete-race-"),
	);
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const sessionId = "reconcile-index-delete-race";
	const lifecycleRequestId = "reconcile-index-delete-effect";
	const remoteCreateKey = "reconcile-index-delete-create";
	const retirementKey = "reconcile-index-delete-retirement";
	const child = spawnDisposableHost();
	const broker = new Broker({ agentDir });
	const createIdentity = "reconcile-index-delete-create-identity";
	try {
		if (!child.pid) throw new Error("fixture child has no pid");
		const processIdentity = await incarnation(child.pid);
		const input = {
			sessionId,
			cwd: agentDir,
			stateRoot,
			endpointGeneration: 4,
			endpointMtimeMs: 1,
			lifecycleRequestId,
			processIncarnation: processIdentity,
			hostIncarnation: processIdentity,
			remoteCreateKey,
		};
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		const marker = { pid: child.pid, effectMarker: lifecycleRequestId, incarnation: processIdentity };
		await fs.writeFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`), canonicalJson(marker));
		await fs.writeFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.ready.json`), canonicalJson(marker));
		await broker.start();
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId,
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: input.endpointGeneration,
			pid: child.pid,
			endpointMtimeMs: input.endpointMtimeMs,
			lifecycleRequestId,
			processIncarnation: processIdentity,
			hostIncarnation: processIdentity,
			terminalUncertain: true,
		});
		await broker.ledger.begin(createIdentity, "reconcile-index-delete-create-request");
		await broker.ledger.transition(createIdentity, "terminal_uncertain", {
			intendedSessionId: sessionId,
			effectMarker: lifecycleRequestId,
			effectIntent: { sessionId, stateRoot, childOwnershipEstablished: true },
			operationKey: `session.create\u0000${remoteCreateKey}`,
			response: { ok: false, error: { code: "terminal_uncertain", message: "fixture" } },
		});
		child.kill("SIGKILL");
		await child.exited;

		const originalAppend = broker.index.append.bind(broker.index);
		const appendFailureSpy = vi.spyOn(broker.index, "append").mockImplementation(async event => {
			if (event.type === "session_closed") throw new Error("simulated index append failure");
			return originalAppend(event);
		});
		await expect(broker.handleRequest("session.reconcile_uncertain", input, retirementKey)).resolves.toMatchObject({
			ok: false,
			error: { code: "cleanup_pending", cleanup: { uncertainRetirement: { stage: "index" } } },
		});
		appendFailureSpy.mockRestore();
		const staged = broker.ledger.findByOperationKey(`session.reconcile_uncertain\u0000${retirementKey}`);
		expect(staged?.response).toMatchObject({
			ok: false,
			error: { cleanup: { uncertainRetirement: { stage: "index" } } },
		});
		await broker.stop();

		const reopened = new Broker({ agentDir });
		await reopened.start();
		const reopenedAppend = reopened.index.append.bind(reopened.index);
		const raceSpy = vi.spyOn(reopened.index, "append").mockImplementation(async event => {
			if (event.type === "session_closed") await reopenedAppend({ ...event, type: "session_deleted" });
			return reopenedAppend(event);
		});
		await expect(reopened.handleRequest("session.reconcile_uncertain", input, retirementKey)).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		raceSpy.mockRestore();
		expect(reopened.ledger.get(createIdentity)).toMatchObject({ state: "terminal_uncertain" });
		expect(reopened.index.listSessions().sessions).toEqual([]);
		const events = (await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { sessionId?: string; type?: string });
		expect(events.filter(event => event.sessionId === sessionId && event.type === "session_deleted")).toHaveLength(1);
		expect(events.filter(event => event.sessionId === sessionId && event.type === "session_closed")).toHaveLength(1);
		await reopened.stop();
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

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

test("dead-registration sweeps retain terminal rows without appending duplicate retirements", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-sweep-terminal-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const deadPid = 4_194_304;
	try {
		expect(() => process.kill(deadPid, 0)).toThrow();
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-terminal",
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: deadPid,
		});
		const registration = broker.index.listSessions().sessions[0];
		if (!registration) throw new Error("Expected a dead registration.");
		expect(await broker.index.unregisterIfCurrent(registration)).toBe(true);
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId: "sweep-terminal", terminal: true, live: false }),
		]);
		const terminalSeq = broker.index.indexSeq;
		expect(await reapDeadSessionRegistrations({ index: broker.index })).toEqual([]);
		expect(broker.index.indexSeq).toBe(terminalSeq);
		expect(await reapDeadSessionRegistrations({ index: broker.index })).toEqual([]);
		expect(broker.index.indexSeq).toBe(terminalSeq);
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("dead-registration sweep retains stale and uncertain live registrations", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-sweep-proof-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const originalKill = process.kill;
	const epermPid = 4_194_303;
	try {
		const hostIncarnation = await incarnation(process.pid);
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-stale-heartbeat",
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
			ts: 0,
		});
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId: "sweep-stale-heartbeat", live: false, terminal: false }),
		]);
		expect(await reapDeadSessionRegistrations(broker)).toEqual([]);

		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			if (pid === epermPid && (signal === 0 || signal === undefined)) {
				const error = new Error("permission denied") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return originalKill(pid, signal);
		}) as typeof process.kill;
		await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-eperm",
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: epermPid,
			processIncarnation: "unreadable-eperm",
			hostIncarnation: "unreadable-eperm",
			ts: 0,
		});
		expect(await reapDeadSessionRegistrations(broker)).toEqual([]);

		await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-unreadable-incarnation",
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: 3,
			pid: process.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
			ts: 0,
		});
		setProcessIncarnationForTest(broker, pid => (pid === process.pid ? undefined : processIncarnation(pid)));
		expect(await reapDeadSessionRegistrations(broker)).toEqual([]);
		expect(
			broker.index
				.listSessionIdentities()
				.filter(session => session.sessionId.startsWith("sweep-"))
				.every(session => !session.terminal),
		).toBe(true);
	} finally {
		setProcessIncarnationForTest(broker, undefined);
		process.kill = originalKill;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("dead-registration sweep retires a reused identity without signaling its replacement", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-sweep-reused-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const replacement = spawnDisposableHost();
	try {
		const replacementIncarnation = await incarnation(replacement.pid);
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-reused-pid",
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: replacement.pid,
			processIncarnation: "retired-incarnation",
			hostIncarnation: "retired-incarnation",
			ts: 0,
		});
		setProcessIncarnationForTest(broker, pid =>
			pid === replacement.pid ? replacementIncarnation : processIncarnation(pid),
		);
		expect(await reapDeadSessionRegistrations(broker)).toEqual([
			{ sessionId: "sweep-reused-pid", pid: replacement.pid, endpointGeneration: 1 },
		]);
		expect(replacement.exitCode).toBeNull();
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId: "sweep-reused-pid", terminal: true, live: false }),
		]);
	} finally {
		setProcessIncarnationForTest(broker, undefined);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("dead-registration sweep retires a dead losing root and preserves the live authority", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-sweep-losing-root-"));
	const liveStateRoot = path.join(agentDir, "live-state");
	const deadStateRoot = path.join(agentDir, "dead-state");
	const broker = new Broker({ agentDir });
	const deadPid = 4_194_304;
	try {
		expect(() => process.kill(deadPid, 0)).toThrow();
		const hostIncarnation = await incarnation(process.pid);
		await broker.start();
		const live = await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-losing-root",
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot: liveStateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
		});
		await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-losing-root",
			locator: { cwd: agentDir, worktreeRoot: null, stateRoot: deadStateRoot },
			endpointGeneration: 2,
			pid: deadPid,
			processIncarnation: "dead-incarnation",
		});
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId: "sweep-losing-root", endpointGeneration: 2, ambiguous: true }),
		]);
		expect(await reapDeadSessionRegistrations(broker)).toEqual([
			{ sessionId: "sweep-losing-root", pid: deadPid, endpointGeneration: 2 },
		]);
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({
				sessionId: "sweep-losing-root",
				locator: live.locator,
				endpointGeneration: live.endpointGeneration,
				ambiguous: false,
				live: true,
			}),
		]);
		expect(await broker.heartbeatSessions()).toBe(1);
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("dead-registration sweep retains terminal uncertainty appended after its snapshot", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-sweep-race-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const deadPid = 4_194_304;
	try {
		expect(() => process.kill(deadPid, 0)).toThrow();
		await broker.start();
		const locator = { cwd: agentDir, worktreeRoot: null, stateRoot };
		await broker.index.append({
			type: "host_registered",
			sessionId: "sweep-race",
			locator,
			endpointGeneration: 1,
			pid: deadPid,
		});
		const originalUnregister = broker.index.unregisterIfCurrent.bind(broker.index);
		const unregisterSpy = vi.spyOn(broker.index, "unregisterIfCurrent").mockImplementation(async expected => {
			await broker.index.append({
				type: "lifecycle_terminal",
				sessionId: expected.sessionId,
				locator: expected.locator,
				endpointGeneration: expected.endpointGeneration,
				pid: expected.pid,
				terminalUncertain: true,
			});
			return await originalUnregister(expected);
		});
		try {
			expect(await reapDeadSessionRegistrations({ index: broker.index })).toEqual([]);
		} finally {
			unregisterSpy.mockRestore();
		}
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId: "sweep-race", terminalUncertain: true }),
		]);
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("conditional unregister accepts a reconciled equivalent repository locator", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-reconciled-repo-"));
	const repo = path.join(agentDir, "repo");
	const repoAlias = path.join(agentDir, "repo-alias");
	const stateRoot = path.join(repo, ".gjc", "state");
	const host = spawnDisposableHost();
	try {
		await fs.mkdir(repo, { recursive: true });
		await fs.symlink(repo, repoAlias, "dir");
		const index = await new SessionIndex(agentDir).open();
		const hostIncarnation = await incarnation(host.pid);
		await index.append({
			type: "host_registered",
			sessionId: "reconciled-repo",
			locator: { cwd: repoAlias, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: host.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
		});
		const expected = index.listSessions().sessions[0];
		if (!expected) throw new Error("Expected indexed registration.");
		await index.append({
			type: "record_reconciled",
			sessionId: expected.sessionId,
			locator: { cwd: repo, worktreeRoot: null, stateRoot },
			endpointGeneration: expected.endpointGeneration,
			pid: expected.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
		});
		expect(await index.unregisterIfCurrent(expected)).toBe(true);
		expect(index.listSessions().sessions).toEqual([
			expect.objectContaining({
				sessionId: "reconciled-repo",
				locator: { cwd: repoAlias, worktreeRoot: null, stateRoot },
				identityProvenance: "composite",
				live: false,
				terminal: true,
			}),
		]);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("close preserves terminal uncertainty when conditional endpoint unregister is refused", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-close-unregister-race-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const broker = new Broker({ agentDir });
	const deadPid = 4_194_304;
	try {
		expect(() => process.kill(deadPid, 0)).toThrow();
		await broker.start();
		const locator = { cwd: root, worktreeRoot: null, stateRoot };
		await broker.index.append({
			type: "host_registered",
			sessionId: "close-unregister-race",
			locator,
			endpointGeneration: 1,
			pid: deadPid,
			processIncarnation: "dead-incarnation",
			lifecycleRequestId: "close-unregister-race-request",
		});
		const originalUnregister = broker.index.unregisterIfCurrent.bind(broker.index);
		let terminalized = false;
		const unregisterSpy = vi.spyOn(broker.index, "unregisterIfCurrent").mockImplementation(async expected => {
			if (!terminalized) {
				terminalized = true;
				await broker.index.append({
					type: "lifecycle_terminal",
					sessionId: expected.sessionId,
					locator: expected.locator,
					endpointGeneration: expected.endpointGeneration,
					pid: expected.pid,
					processIncarnation: expected.processIncarnation,
					lifecycleRequestId: expected.lifecycleRequestId,
					terminalUncertain: true,
				});
			}
			return await originalUnregister(expected);
		});
		try {
			expect(
				await broker.handleRequest(
					"session.close",
					{ sessionId: "close-unregister-race" },
					"close-unregister-race",
				),
			).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		} finally {
			unregisterSpy.mockRestore();
		}
		expect(terminalized).toBe(true);
		expect(broker.index.listSessions().sessions).toEqual([
			expect.objectContaining({ sessionId: "close-unregister-race", terminalUncertain: true }),
		]);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("close removes an unchanged dead endpoint with a fractional nanosecond mtime", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-dead-mtime-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "fractional-mtime";
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	const deadPid = 4_194_304;
	try {
		expect(() => process.kill(deadPid, 0)).toThrow();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: deadPid, url: "ws://127.0.0.1:1", token: "fractional-mtime" }),
		);
		await fs.utimes(endpointPath, 1_700_000_000, 1_700_000_000.123_456);
		const metadata = await fs.stat(endpointPath, { bigint: true });
		expect(metadata.mtimeNs % 1_000_000n).not.toBe(0n);
		const endpointMtimeMs = Number(metadata.mtimeNs / 1_000_000n);
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: deadPid,
			processIncarnation: "dead-incarnation",
			endpointMtimeMs,
		});
		const originalExactUnlink = native.exactUnlink.bind(native);
		let unlinked = false;
		const unlinkSpy = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (path.resolve(pathname) !== endpointPath) return originalExactUnlink(pathname, identity);
			unlinked = true;
			syncFs.rmSync(pathname);
			return { ok: true };
		});
		try {
			expect(await broker.handleRequest("session.close", { sessionId }, "fractional-mtime-close")).toMatchObject({
				ok: true,
				result: { sessionId },
			});
		} finally {
			unlinkSpy.mockRestore();
		}
		expect(unlinked).toBe(true);
		await expect(fs.access(endpointPath)).rejects.toThrow();
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("close fails closed when a dead endpoint is replaced before its descriptor is opened", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-dead-endpoint-replacement-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "dead-endpoint-replacement";
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const displacedPath = `${endpointPath}.displaced`;
	const deadPid = 4_194_304;
	const broker = new Broker({ agentDir });
	const predecessorSource = JSON.stringify({ sessionId, pid: deadPid, url: "ws://127.0.0.1:1", token: "predecessor" });
	const successorSource = JSON.stringify({ sessionId, pid: deadPid, url: "ws://127.0.0.1:1", token: "successor" });
	let replacedBeforeOpen = false;
	try {
		expect(() => process.kill(deadPid, 0)).toThrow();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(endpointPath, predecessorSource);
		const fixedMtimeSeconds = 1_700_000_000;
		await fs.utimes(endpointPath, fixedMtimeSeconds, fixedMtimeSeconds);
		const predecessor = await fs.stat(endpointPath, { bigint: true });
		const predecessorFileId = `${predecessor.dev}:${predecessor.ino}`;
		const endpointMtimeMs = Number(predecessor.mtimeNs / 1_000_000n);
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: deadPid,
			processIncarnation: "dead-incarnation",
			endpointMtimeMs,
			endpointFileId: predecessorFileId,
		});
		const realOpen = fs.open.bind(fs);
		const openSpy = vi.spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
			if (!replacedBeforeOpen && path.resolve(file) === path.resolve(endpointPath)) {
				replacedBeforeOpen = true;
				await fs.rename(endpointPath, displacedPath);
				await fs.writeFile(endpointPath, successorSource);
				await fs.utimes(endpointPath, fixedMtimeSeconds, fixedMtimeSeconds);
			}
			return await (realOpen as (file: string, ...args: unknown[]) => Promise<fs.FileHandle>)(file, ...rest);
		}) as typeof fs.open);
		try {
			await expect(
				broker.handleRequest("session.close", { sessionId }, "dead-endpoint-replacement-close"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "terminal_uncertain" },
			});
		} finally {
			openSpy.mockRestore();
		}
		expect(replacedBeforeOpen).toBe(true);
		const successor = await fs.stat(endpointPath, { bigint: true });
		expect(`${successor.dev}:${successor.ino}`).not.toBe(predecessorFileId);
		expect(Number(successor.mtimeNs / 1_000_000n)).toBe(endpointMtimeMs);
		expect(await fs.readFile(endpointPath, "utf8")).toBe(successorSource);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("startup cleanup accepts a payload-durable scrubbed endpoint placeholder", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-scrubbed-endpoint-"));
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "retained-startup-failure.ts");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
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
await fs.writeFile(endpoint, JSON.stringify({ sessionId: request.sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "retained-startup-failure" }), { mode: 0o600 });
const index = await new SessionIndex(process.env.GJC_AGENT_DIR!).open();
const endpointGeneration = 1;
await index.append({ type: "host_registered", sessionId: request.sessionId, locator: { cwd: request.cwd, worktreeRoot: null, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs, lifecycleRequestId: request.effectMarker });
const source = await fs.readFile(request.sessionPath);
const stat = await fs.stat(request.sessionPath, { bigint: true });
await index.append({ type: "host_unregistered", sessionId: request.sessionId, locator: { cwd: request.cwd, worktreeRoot: null, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, lifecycleRequestId: request.effectMarker });
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "owned scrubbed startup failure" }, { endpointGeneration, fenced: true, runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true }, { digest: createHash("sha256").update(source).digest("hex"), identity: { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), mtimeNs: stat.mtimeNs.toString(), sha256: createHash("sha256").update(source).digest("hex") } });
await Bun.sleep(150);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		const saved = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted resume transcript.");
		await saved.close();
		const endpointPath = path.join(root, ".gjc", "state", "sdk", `${sessionId}.json`);
		const hasPublishedFailure = (): boolean => {
			try {
				return syncFs
					.readdirSync(path.join(root, ".gjc", "state", "sdk"))
					.some(name => name.startsWith(`${sessionId}.lifecycle.failure.`));
			} catch {
				return false;
			}
		};
		await broker.start();
		let transientExitObservation = false;
		setProcessIncarnationForTest(broker, pid => {
			if (!transientExitObservation && hasPublishedFailure()) {
				transientExitObservation = true;
				return undefined;
			}
			return processIncarnation(pid);
		});
		const originalExactUnlink = native.exactUnlink.bind(native);
		let detachedPath: string | undefined;
		let staleDetachedUnlinkAttempts = 0;
		const unlinkSpy = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (path.resolve(pathname) === endpointPath) {
				if (!identity.quarantineName) throw new Error("Expected endpoint cleanup quarantine name.");
				detachedPath = path.join(path.dirname(pathname), identity.quarantineName);
				syncFs.renameSync(pathname, detachedPath);
				syncFs.truncateSync(detachedPath, 0);
				return {
					ok: false,
					code: "cleanup_pending",
					payloadDurable: true,
					detachedPath,
					retainedPlaceholderPath: path.join(path.dirname(pathname), ".gjc-exact-unlink-placeholder-fixture"),
				};
			}
			if (detachedPath && path.resolve(pathname) === detachedPath) {
				staleDetachedUnlinkAttempts += 1;
				return { ok: false, code: "identity_mismatch" };
			}
			return originalExactUnlink(pathname, identity);
		});
		try {
			expect(
				await broker.handleRequest("session.resume", { cwd: root, sessionId, sessionPath }, "scrubbed-endpoint"),
			).toMatchObject({
				ok: false,
				error: { code: "spawn_failed", message: "owned scrubbed startup failure" },
			});
		} finally {
			unlinkSpy.mockRestore();
		}
		expect(transientExitObservation).toBe(true);
		if (!detachedPath) throw new Error("Expected a scrubbed detached endpoint path.");
		expect(staleDetachedUnlinkAttempts).toBe(0);
		expect(syncFs.lstatSync(detachedPath).size).toBe(0);
		await expect(fs.access(endpointPath)).rejects.toThrow();
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		setProcessIncarnationForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("idempotent lifecycle replay refreshes authority after a broker restart", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-replay-authority-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "replay-authority";
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	let initial: Broker | undefined;
	const host = spawnDisposableHost();
	let restarted: Broker | undefined;
	try {
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: host.pid, url: "ws://127.0.0.1:1", token: "successor-token" }),
		);
		const endpointIdentity = await fs.stat(endpointPath, { bigint: true });
		const endpointMtimeMs = Number(endpointIdentity.mtimeNs) / 1_000_000;
		const endpointFileId = `${endpointIdentity.dev}:${endpointIdentity.ino}`;
		const hostIncarnation = await incarnation(host.pid);
		initial = new Broker({ agentDir });
		await initial.start();
		await initial.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: host.pid,
			endpointMtimeMs,
			endpointFileId,
			processIncarnation: hostIncarnation,
			hostIncarnation,
		});
		await initial.index.append({
			type: "host_heartbeat",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: host.pid,
			processIncarnation: hostIncarnation,
			hostIncarnation,
		});
		const key = "replay-authority";
		const targetHash = createHash("sha256").update(canonicalJson({ sessionId })).digest("hex");
		const identity = await deriveIdempotencyIdentity(agentDir, "session.resume", key, targetHash);
		const input = { cwd: root, stateRoot, sessionId };
		const requestHash = createHash("sha256")
			.update(canonicalJson({ operation: "session.resume", input }))
			.digest("hex");
		expect(await initial.ledger.begin(identity, requestHash)).toMatchObject({ kind: "new" });
		await initial.ledger.transition(identity, "terminal_ok", {
			response: {
				ok: true,
				result: {
					sessionId,
					cwd: root,
					endpointGeneration: 1,
					pid: host.pid + 1,
					endpointMtimeMs: 1,
					endpointFileId: "stale:identity",
					reused: true,
				},
			},
		});
		await initial.stop();
		initial = undefined;
		restarted = new Broker({ agentDir });
		await restarted.start();
		expect(await restarted.handleRequest("session.resume", { cwd: root, sessionId }, key)).toEqual({
			ok: true,
			result: {
				sessionId,
				cwd: root,
				endpointGeneration: 2,
				pid: host.pid,
				endpointMtimeMs,
				endpointFileId,
				reused: true,
				endpoint: {
					sessionId,
					pid: host.pid,
					url: "ws://127.0.0.1:1",
					token: "successor-token",
				},
			},
		});

		const exactMtimeMs = Number((await fs.stat(endpointPath, { bigint: true })).mtimeNs) / 1_000_000;
		await restarted.index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: root, worktreeRoot: null, stateRoot },
			endpointGeneration: 2,
			pid: host.pid,
			endpointMtimeMs: exactMtimeMs,
			processIncarnation: hostIncarnation,
			hostIncarnation,
		});
		const identityLessKey = "replay-authority-identity-less";
		const identityLess = await deriveIdempotencyIdentity(agentDir, "session.resume", identityLessKey, targetHash);
		expect(await restarted.ledger.begin(identityLess, requestHash)).toMatchObject({ kind: "new" });
		await restarted.ledger.transition(identityLess, "terminal_ok", {
			response: {
				ok: true,
				result: {
					sessionId,
					cwd: root,
					endpointGeneration: 1,
					pid: host.pid + 1,
					endpointMtimeMs: 1,
					endpointFileId: "stale:identity",
					reused: true,
				},
			},
		});
		expect(await restarted.handleRequest("session.resume", { cwd: root, sessionId }, identityLessKey)).toEqual({
			ok: true,
			result: {
				sessionId,
				cwd: root,
				endpointGeneration: 2,
				pid: host.pid,
				endpointMtimeMs: exactMtimeMs,
				reused: true,
				endpoint: {
					sessionId,
					pid: host.pid,
					url: "ws://127.0.0.1:1",
					token: "successor-token",
				},
			},
		});
		const malformedReplayKey = "replay-authority-malformed-session";
		const malformedReplayIdentity = await deriveIdempotencyIdentity(
			agentDir,
			"session.resume",
			malformedReplayKey,
			targetHash,
		);
		expect(await restarted.ledger.begin(malformedReplayIdentity, requestHash)).toMatchObject({ kind: "new" });
		await restarted.ledger.transition(malformedReplayIdentity, "terminal_ok", {
			response: {
				ok: true,
				result: {
					sessionId: "../../outside",
					cwd: root,
					endpointGeneration: 2,
					pid: host.pid,
					endpointMtimeMs,
					reused: true,
				},
			},
		});
		expect(await restarted.handleRequest("session.resume", { cwd: root, sessionId }, malformedReplayKey)).toEqual({
			ok: false,
			error: { code: "invalid_input", message: "replayed sessionId must be a canonical safe identifier" },
		});
	} finally {
		await initial?.stop();
		await restarted?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("idempotent lifecycle replay rejects preserved-mtime endpoint identity transitions", async () => {
	for (const transition of ["identity-less-to-identityful", "identityful-to-identity-less"] as const) {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-replay-race-${transition}-`));
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, ".gjc", "state");
		const sessionId = `replay-race-${transition}`;
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const displacedPath = `${endpointPath}.displaced`;
		const host = spawnDisposableHost();
		const broker = new Broker({ agentDir });
		let refreshSpy: Mock<() => Promise<void>> | undefined;
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await Bun.write(
				endpointPath,
				JSON.stringify({ sessionId, pid: host.pid, url: "ws://127.0.0.1:1", token: "predecessor-token" }),
			);
			const fixedMtimeSeconds = 1_700_000_000;
			await fs.utimes(endpointPath, fixedMtimeSeconds, fixedMtimeSeconds);
			const initialFile = await fs.stat(endpointPath, { bigint: true });
			const initialMtimeMs = Number(initialFile.mtimeNs) / 1_000_000;
			const initialFileId = `${initialFile.dev}:${initialFile.ino}`;
			const hostIncarnation = await incarnation(host.pid);
			await broker.start();
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { cwd: root, worktreeRoot: null, stateRoot },
				endpointGeneration: 2,
				pid: host.pid,
				endpointMtimeMs: initialMtimeMs,
				...(transition === "identityful-to-identity-less" ? { endpointFileId: initialFileId } : {}),
				processIncarnation: hostIncarnation,
				hostIncarnation,
			});
			const key = `replay-race-${transition}`;
			const targetHash = createHash("sha256").update(canonicalJson({ sessionId })).digest("hex");
			const identity = await deriveIdempotencyIdentity(agentDir, "session.resume", key, targetHash);
			const input = { cwd: root, stateRoot, sessionId };
			const requestHash = createHash("sha256")
				.update(canonicalJson({ operation: "session.resume", input }))
				.digest("hex");
			expect(await broker.ledger.begin(identity, requestHash)).toMatchObject({ kind: "new" });
			await broker.ledger.transition(identity, "terminal_ok", {
				response: {
					ok: true,
					result: { sessionId, cwd: root, endpointGeneration: 1, pid: host.pid + 1, endpointMtimeMs: 1 },
				},
			});
			const replacementIndex = await new SessionIndex(agentDir).open();
			const realRefresh = broker.index.refresh.bind(broker.index);
			let refreshes = 0;
			refreshSpy = vi.spyOn(broker.index, "refresh").mockImplementation(async () => {
				refreshes += 1;
				if (refreshes === 2) {
					await fs.rename(endpointPath, displacedPath);
					await Bun.write(
						endpointPath,
						JSON.stringify({ sessionId, pid: host.pid, url: "ws://127.0.0.1:2", token: "successor-token" }),
					);
					await fs.utimes(endpointPath, fixedMtimeSeconds, fixedMtimeSeconds);
					const replacementFile = await fs.stat(endpointPath, { bigint: true });
					await replacementIndex.append({
						type: "host_registered",
						sessionId,
						locator: { cwd: root, worktreeRoot: null, stateRoot },
						endpointGeneration: 2,
						pid: host.pid,
						endpointMtimeMs: Number(replacementFile.mtimeNs) / 1_000_000,
						...(transition === "identity-less-to-identityful"
							? { endpointFileId: `${replacementFile.dev}:${replacementFile.ino}` }
							: {}),
						processIncarnation: hostIncarnation,
						hostIncarnation,
					});
				}
				await realRefresh();
			});
			expect(await broker.handleRequest("session.resume", { cwd: root, sessionId }, key)).toMatchObject({
				ok: false,
				error: { code: "endpoint_stale" },
			});
		} finally {
			refreshSpy?.mockRestore();
			await broker.stop();
			host.kill();
			await fs.rm(root, { recursive: true, force: true });
		}
	}
});

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
	const brokerFixture = await startFixtureBrokerWithLeaseForTest({ agentDir });
	expect(brokerOwnerForTest(agentDir)).toBeDefined();
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
		await brokerFixture.lease.close();
		expect(brokerOwnerForTest(agentDir)).toBeUndefined();
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
	if (process.platform !== "linux") return;
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
		if (
			!response.ok &&
			(response.error.code === "terminal_uncertain" ||
				(response.error.code === "spawn_failed" && response.startupFailure?.reason === "pending"))
		) {
			const startupFailure = response.startupFailure ?? response.durableEffects?.startup;
			expect(startupFailure).toBeDefined();
			if (startupFailure === undefined) throw new Error("Expected durable startup failure evidence.");
			expect(startupFailure).toMatchObject({
				artifactDigest: expect.any(String),
				rollback: {
					fenced: true,
					runtimeRemoved: true,
					hostStopped: true,
					brokerRegistrationReleased: true,
				},
			});
			if (startupFailure.reason === "factory_absent") {
				expect(startupFailure).toMatchObject({ phase: "registration" });
				expect(startupFailure.message).toContain("[redacted-secret]");
				expect(new TextEncoder().encode(startupFailure.message).byteLength).toBeLessThanOrEqual(512);
			} else {
				expect(startupFailure).toMatchObject({ phase: "startup", reason: "pending" });
			}
			if (response.error.code === "spawn_failed")
				expect(response.startupFailure).toMatchObject({
					phase: "startup",
					reason: "pending",
					cleanupProof: {
						processExited: true,
						endpointRemoved: true,
						hostUnregistered: { state: "not_registered" },
					},
				});
			const serialized = JSON.stringify(response);
			expect(serialized).not.toContain(bare);
			expect(serialized).not.toContain(overlap);
			expect(serialized).not.toContain(normalized);
			return;
		}
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
	if (process.platform !== "linux") return;
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-profile-cutoff-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const previous = process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE;
	process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE = root;
	try {
		await broker.start();
		const input = { cwd: root, readinessTimeoutMs: 4_000 };
		const response = await broker.handleRequest("session.create", input, "profile-cutoff");
		if (!response.ok && response.error.code === "terminal_uncertain") {
			expect(response.error.message).toBe(
				"Lifecycle startup cleanup could not be proven; retained artifacts require reconciliation.",
			);
			const replay = await broker.handleRequest("session.create", input, "profile-cutoff");
			expect(replay).toEqual(response);
			return;
		}
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

test("unregistered cutoff receipt gets bounded publication and post-signal proof", async () => {
	if (process.platform !== "linux") return;
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-pre-registration-boundary-"));
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "pre-registration-boundary.ts");
	const pidPath = path.join(root, "child.pid");
	const requestPath = path.join(root, "child.request.json");
	const receivedAt = 1_000;
	const deadlines = deriveLifecycleDeadlines(receivedAt, 4_000);
	let nowMs = receivedAt;
	let receiptPublished = false;
	const broker = new Broker({ agentDir });
	await fs.writeFile(
		fixture,
		`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
await Bun.write(${JSON.stringify(requestPath)}, process.env.GJC_SDK_LIFECYCLE_REQUEST ?? "");
setInterval(() => {}, 1_000_000);
`,
	);
	setLifecycleCommandResolverForTest(broker, () => ({ file: process.execPath, args: ["run", fixture] }));
	setLifecycleTimingForTest(broker, {
		now: () => nowMs,
		sleep: async ms => {
			const requestReady = await fs.access(requestPath).then(
				() => true,
				() => false,
			);
			if (!requestReady) {
				await Bun.sleep(1);
				return;
			}
			nowMs += ms;
			if (!receiptPublished && nowMs >= deadlines.semanticReadyDeadlineAt - 100) {
				const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as {
					sessionId: string;
					stateRoot: string;
					effectMarker: string;
				};
				const pid = Number(await fs.readFile(pidPath, "utf8"));
				const childIncarnation = processIncarnation(pid);
				if (!childIncarnation) throw new Error("Expected a readable child process incarnation.");
				await writeSessionLifecycleFailure(
					request.stateRoot,
					request.sessionId,
					request.effectMarker,
					{
						phase: "startup",
						reason: "pending",
						message: "deterministic cutoff receipt",
					},
					{
						endpointGeneration: null,
						fenced: true,
						runtimeRemoved: true,
						hostStopped: true,
						brokerRegistrationReleased: true,
					},
					undefined,
					childIncarnation,
					pid,
				);
				receiptPublished = true;
			}
			await Bun.sleep(1);
		},
	});
	try {
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: deadlines.requestedReadinessTimeoutMs },
			"pre-registration-boundary",
		);
		expect(receiptPublished).toBe(true);
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: "spawn_failed",
				endpoint: "unavailable",
				message: "deterministic cutoff receipt",
			},
			startupFailure: {
				phase: "startup",
				reason: "pending",
				message: "deterministic cutoff receipt",
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
		expect(nowMs).toBeLessThan(deadlines.lifecycleCleanupDeadlineAt);
	} finally {
		setLifecycleTimingForTest(broker, undefined);
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 10_000);

test("delayed lifecycle reconciliation proof cannot return spawn_failed cleanup after its deadline", async () => {
	if (process.platform !== "linux") return;
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-delayed-proof-"));
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "delayed-proof.ts");
	const pidPath = path.join(root, "child.pid");
	const requestPath = path.join(root, "child.request.json");
	const receivedAt = 1_000;
	const deadlines = deriveLifecycleDeadlines(receivedAt, 4_000);
	let nowMs = receivedAt;
	let receiptPublished = false;
	let delayedProof = false;
	const broker = new Broker({ agentDir });
	await fs.writeFile(
		fixture,
		`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
await Bun.write(${JSON.stringify(requestPath)}, process.env.GJC_SDK_LIFECYCLE_REQUEST ?? "");
setInterval(() => {}, 1_000_000);
`,
	);
	setLifecycleCommandResolverForTest(broker, () => ({ file: process.execPath, args: ["run", fixture] }));
	setLifecycleTimingForTest(broker, {
		now: () => nowMs,
		sleep: async ms => {
			const requestReady = await fs.access(requestPath).then(
				() => true,
				() => false,
			);
			if (!requestReady) {
				await Bun.sleep(1);
				return;
			}
			nowMs += ms;
			if (!receiptPublished && nowMs >= deadlines.semanticReadyDeadlineAt - 100) {
				const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as {
					sessionId: string;
					stateRoot: string;
					effectMarker: string;
				};
				const pid = Number(await fs.readFile(pidPath, "utf8"));
				const childIncarnation = processIncarnation(pid);
				if (!childIncarnation) throw new Error("Expected a readable child process incarnation.");
				await writeSessionLifecycleFailure(
					request.stateRoot,
					request.sessionId,
					request.effectMarker,
					{ phase: "startup", reason: "pending", message: "delayed lifecycle proof" },
					{
						endpointGeneration: null,
						fenced: true,
						runtimeRemoved: true,
						hostStopped: true,
						brokerRegistrationReleased: true,
					},
					undefined,
					childIncarnation,
					pid,
				);
				receiptPublished = true;
			}
			await Bun.sleep(1);
		},
	});
	const originalExactUnlink = native.exactUnlink.bind(native);
	const unlinkSpy = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
		const result = originalExactUnlink(pathname, identity);
		if (!delayedProof && receiptPublished && nowMs >= deadlines.terminationStartDeadlineAt) {
			nowMs = deadlines.lifecycleCleanupDeadlineAt;
			delayedProof = true;
		}
		return result;
	});
	try {
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: deadlines.requestedReadinessTimeoutMs },
			"delayed-lifecycle-proof",
		);
		expect(receiptPublished).toBe(true);
		expect(delayedProof).toBe(true);
		expect(nowMs).toBeGreaterThanOrEqual(deadlines.lifecycleCleanupDeadlineAt);
		expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		if (!response.ok) expect(response.error.code).not.toBe("spawn_failed");
	} finally {
		unlinkSpy.mockRestore();
		setLifecycleTimingForTest(broker, undefined);
		setLifecycleCommandResolverForTest(broker, undefined);
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 10_000);

test("production post-registration startup failure proves cleanup and exact replay", async () => {
	if (process.platform !== "linux") return;
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
				message: "Lifecycle test failure after SDK host registration.",
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
		expect(sessions).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ terminal: true, live: false })] },
		});
		const sdkDir = path.join(root, ".gjc", "state", "sdk");
		const entries = await fs.readdir(sdkDir);
		// Retained `.gjc-delete-*` quarantines are typed cleanup evidence; only
		// canonical lifecycle metadata must be gone. Every remaining entry that
		// still matches a lifecycle pattern must be an authorized quarantine name.
		const canonical = entries.filter(entry => !entry.startsWith(".gjc-delete-"));
		expect(canonical.some(entry => entry.includes(".lifecycle.failure."))).toBe(false);
		expect(canonical.some(entry => entry.endsWith(".lifecycle.json"))).toBe(false);
		const retained = entries.filter(
			entry => entry.includes(".lifecycle.failure.") || entry.endsWith(".lifecycle.json"),
		);
		expect(retained.every(entry => entry.startsWith(".gjc-delete-"))).toBe(true);
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
			// This boots a real source-workspace host. Preserve enough headroom when
			// Bun runs this file beside the broker unit shard on loaded CI workers.
			{ cwd: root, readinessTimeoutMs: 20_000 },
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
}, 30_000);

test("broker agentDir profile validates, activates, and is discoverable through session Q27", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-profile-agent-dir-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(
		path.join(agentDir, "models.yml"),
		`providers:\n  fixture:\n    baseUrl: https://example.invalid/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: fixture-model\n        name: Fixture Model\n        contextWindow: 4096\n        maxTokens: 1024\nprofiles:\n  agent-dir-only:\n    display_name: Agent Dir Only\n    required_providers: [fixture]\n    model_mapping:\n      executor: fixture/fixture-model\n`,
	);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		const created = await broker.handleRequest(
			"session.create",
			{ cwd, modelPreset: "agent-dir-only", readinessTimeoutMs: 20_000 },
			"agent-dir-profile-create",
		);
		if (!created.ok) throw new Error(created.error.message);
		const { sessionId, endpoint } = created.result as {
			sessionId: string;
			endpoint: { url: string; token: string };
		};
		const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
		try {
			expect(await client.query("models.profiles.list")).toMatchObject({
				ok: true,
				page: {
					items: expect.arrayContaining([
						expect.objectContaining({
							id: "agent-dir-only",
							displayName: "Agent Dir Only",
							source: "configured",
						}),
					]),
				},
			});
		} finally {
			await client.close();
		}
		expect(await broker.handleRequest("session.close", { sessionId }, "agent-dir-profile-close")).toMatchObject({
			ok: true,
			result: { sessionId },
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("child profile activation failures preserve typed codes through readiness and BrokerResponse", async () => {
	if (process.platform !== "linux") return;
	const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
	for (const scenario of [
		{ code: "unknown_model_profile", replacement: "profiles: {}\n" },
		{ code: "model_profile_registry_error", replacement: "profiles: [invalid\n" },
	] as const) {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", `gjc-sdk-${scenario.code}-`));
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "models.yml"),
			`providers:\n  fixture:\n    baseUrl: https://example.invalid/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: fixture-model\n        name: Fixture Model\n        contextWindow: 4096\n        maxTokens: 1024\nprofiles:\n  agent-dir-only:\n    required_providers: [fixture]\n    model_mapping:\n      executor: fixture/fixture-model\n`,
		);
		const broker = new Broker({ agentDir });
		setLifecycleCommandResolverForTest(broker, () => ({
			file: "/bin/sh",
			args: [
				"-c",
				`printf %s ${shellQuote(scenario.replacement)} > "$GJC_AGENT_DIR/models.yml"; exec ${shellQuote(process.execPath)} run ${shellQuote(cliEntrypoint)} sdk session-host-internal`,
			],
		}));
		try {
			await broker.start();
			const response = await broker.handleRequest(
				"session.create",
				{ cwd, modelPreset: "agent-dir-only", readinessTimeoutMs: 10_000 },
				`child-profile-${scenario.code}`,
			);
			expect(response).toMatchObject({
				ok: false,
				error: {
					code: scenario.code,
					details: { requestedProfile: "agent-dir-only", discoveryQuery: "models.profiles.list" },
				},
				startupFailure: {
					code: scenario.code,
					details: { requestedProfile: "agent-dir-only", discoveryQuery: "models.profiles.list" },
				},
			});
		} finally {
			setLifecycleCommandResolverForTest(broker, undefined);
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	}
}, 40_000);

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
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ sessionId, terminal: true, live: false })] },
		});
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

test("broker preserves an acknowledged session.close result when endpoint client close rejects", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-close-cleanup-rejection-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "close-cleanup-rejection";
	const broker = new Broker({ agentDir });
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const close = vi
		.spyOn(SdkClient.prototype, "close")
		.mockRejectedValue(new Error("injected endpoint client close handshake rejection"));
	try {
		await broker.start();
		const { child } = await liveLifecycleSession(root, agentDir, sessionId);
		await waitFor(async () => {
			const listed = (await broker.handleRequest("session.list", {})) as {
				result?: { sessions?: Array<{ sessionId?: string }> };
			};
			return listed.result?.sessions?.some(session => session.sessionId === sessionId) ? true : undefined;
		}, "session indexed before rejected client cleanup");

		expect(await broker.handleRequest("session.close", { sessionId }, "close-cleanup-rejection")).toMatchObject({
			ok: true,
			result: { sessionId },
		});
		expect(await child.exited).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledWith(
			"SDK session-close client cleanup failed after control dispatch: injected endpoint client close handshake rejection",
		);
	} finally {
		close.mockRestore();
		warning.mockRestore();
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

		const mcp = createSdkMcpServer({ agentDir: agentDirs[1] });
		expect(await mcp.callTool("gjc_session_global", { operation: "session.list" })).toMatchObject({
			ok: true,
			result: { sessions: [] },
		});
		expect(await readSdkBrokerDiscovery(agentDirs[1])).not.toBeNull();
		await mcp.close();

		const output: unknown[] = [];
		await runSdkSessionCli({ action: "global", operation: "session.list", agentDir: agentDirs[2] }, value =>
			output.push(value),
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
			nlink: stat.nlink.toString(),
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs.toString(),
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	};
	const cleanup = async (): Promise<BrokerCleanupEvidence> => ({
		phase: "lifecycle",
		sessionId,
		metadataRoot: stateRoot,
		lifecycleParentIdentity: await fs.stat(path.dirname(markerPath), { bigint: true }).then(stat => ({
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
		})),
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

test("session/list does not grant a second ACP connection destructive lifecycle control", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-acp-list-ownership-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "repo");
	await fs.mkdir(cwd, { recursive: true });
	brokerDirs.push(agentDir);
	try {
		// Both connections share one broker, which is the situation that makes
		// enumeration dangerous: `session/list` reports sessions the caller does
		// not own, and knowing their cwd must not become authority over them.
		const owner = new AcpAgent({ signal: new AbortController().signal } as never, { agentDir });
		const stranger = new AcpAgent({ signal: new AbortController().signal } as never, { agentDir });

		const created = await owner.newSession({ cwd, mcpServers: [] } as never);
		const sessionId = created.sessionId;

		const listed = await stranger.listSessions({ cwd } as never);
		expect(listed.sessions.some((s: { sessionId: string }) => s.sessionId === sessionId)).toBe(true);

		// Enumeration succeeded; destructive control must still be refused. Both
		// return the protocol no-op rather than throwing, so the session's survival
		// is the assertion that matters.
		expect(await stranger.closeSession({ sessionId } as never)).toEqual({});
		expect(await stranger.deleteSession({ sessionId } as never)).toEqual({});

		const afterAttack = await owner.listSessions({ cwd } as never);
		expect(afterAttack.sessions.some((s: { sessionId: string }) => s.sessionId === sessionId)).toBe(true);

		// The owner is unaffected by the refusal and can still close its own session.
		expect(await owner.closeSession({ sessionId } as never)).toEqual({});

		// Admission to both operations happens while this connection still owns the
		// session. They must serialize, and delete must treat the preceding close's
		// completed teardown as success instead of trying to close the dead process again.
		const concurrent = await owner.newSession({ cwd, mcpServers: [] } as never);
		await expect(
			Promise.all([
				owner.closeSession({ sessionId: concurrent.sessionId } as never),
				owner.deleteSession({ sessionId: concurrent.sessionId } as never),
			]),
		).resolves.toEqual([{}, {}]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
