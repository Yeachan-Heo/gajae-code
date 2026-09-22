import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import McpServe, {
	buildCoordinatorCheckPayload,
	type CoordinatorBrokerObservation,
	formatCoordinatorCheckPayload,
	probeCoordinatorBrokerCheck,
} from "../src/commands/mcp-serve";
import { acquireFileLock, FileLockAcquireError } from "../src/config/file-lock";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../src/coordinator/contract";
import { coordinatorNamespaceIdentity } from "../src/coordinator-mcp/policy";
import {
	assertCloseAdmission,
	type CanonicalSessionSnapshotV1,
	type CanonicalTurnSnapshotV1,
	type CoordinatorSessionTransactionV1,
	type CoordinatorStatePaths,
	claimCreationRequest,
	coordinatorStatePaths,
	createSessionTransaction,
	deterministicOutboxId,
	enumeratePublicDeliveries,
	type GateAuthorityEntryV1,
	initializeCoordinatorNamespace,
	readSessionTransaction,
	reconcileCreationRemoteVerifier,
	repairLegacyReportIds,
	rotateClaimedCreationVerifier,
	startCreationRemote,
	transactionLockPath,
	transactionPath,
	withNamespaceRegistry,
	withSessionTransaction,
} from "../src/coordinator-mcp/question-state";
import { createCoordinatorMcpServer, handleCoordinatorMcpRequest } from "../src/coordinator-mcp/server";
import { brokerDiscoveryPath, brokerProcessIncarnation, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { UnsupportedStateVersionError } from "../src/sdk/broker/state-version";
import { SDK_MCP_TOOL_NAMES } from "../src/sdk/mcp/server";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-mcp-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function captureMcpServeCheck(argv: string[]): Promise<string> {
	let stdout = "";
	const write = process.stdout.write;
	const exitCode = process.exitCode;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;
	try {
		await new McpServe(argv, { bin: "gjc", version: "test", commands: new Map() }).run();
		return stdout;
	} finally {
		process.stdout.write = write;
		process.exitCode = exitCode;
	}
}

async function withAgentDir<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
	const previous = getAgentDir();
	setAgentDir(agentDir);
	try {
		return await run();
	} finally {
		setAgentDir(previous);
	}
}

describe("canonical SDK coordinator compatibility handler", () => {
	it("serves initialization and the canonical tool inventory", async () => {
		await withTempRoot(async root => {
			const env = { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root };
			const initialized = await handleCoordinatorMcpRequest(
				{ jsonrpc: "2.0", id: 1, method: "initialize" },
				{ env },
			);
			expect(initialized).toMatchObject({
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION,
					serverInfo: { name: COORDINATOR_MCP_SERVER_NAME, version: expect.any(String) },
					capabilities: { tools: {}, prompts: {}, resources: {} },
				},
			});
			const listed = await handleCoordinatorMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { env });
			expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
				...COORDINATOR_MCP_TOOL_NAMES,
			]);
			const promptTool = listed.result.tools.find(
				(tool: { name: string }) => tool.name === "gjc_coordinator_send_prompt",
			);
			expect(promptTool.inputSchema.required).toEqual(expect.arrayContaining(["idempotency_key", "allow_mutation"]));
		});
	});

	it("requires the complete public question-answer correlation tuple", async () => {
		await withTempRoot(async root => {
			const response = await handleCoordinatorMcpRequest(
				{ jsonrpc: "2.0", id: 3, method: "tools/list" },
				{ env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root } },
			);
			const tool = response.result.tools.find(
				(candidate: { name: string }) => candidate.name === "gjc_coordinator_submit_question_answer",
			);
			expect(tool.inputSchema.required).toEqual(
				expect.arrayContaining([
					"session_id",
					"turn_id",
					"question_id",
					"answer_binding",
					"answer",
					"idempotency_key",
					"allow_mutation",
				]),
			);
		});
	});

	it("preserves mutation authorization and read-only artifact boundaries", async () => {
		await withTempRoot(async root => {
			const artifact = path.join(root, "result.txt");
			await Bun.write(artifact, "coordinator artifact");
			const server = createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				},
			});
			expect(
				await server.callTool("gjc_coordinator_start_session", { cwd: root, idempotency_key: "start-1" }),
			).toEqual({ ok: false, reason: "coordinator_mutation_call_not_allowed:sessions" });
			if (process.platform === "linux") {
				expect(await server.callTool("gjc_coordinator_read_artifact", { path: artifact })).toMatchObject({
					ok: true,
					text: "coordinator artifact",
				});
				expect(await server.callTool("gjc_coordinator_read_artifact", { path: os.tmpdir() })).toEqual({
					ok: false,
					reason: "artifact_outside_allowed_roots",
				});
			} else {
				await expect(server.callTool("gjc_coordinator_read_artifact", { path: artifact })).resolves.toMatchObject({
					ok: false,
					error: { code: "artifact_unavailable" },
				});
			}
		});
	});
});

describe("coordinator and hermes check contract", () => {
	const discovery = {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test-generation",
		ownerId: "owner-secret",
		pid: 987654321,
		incarnation: "incarnation-secret",
		host: "127.0.0.1",
		port: 54321,
		url: "ws://127.0.0.1:54321/secret-token",
		token: "secret-token",
		startedAt: 1,
		heartbeatAt: 2,
	} as const;

	it("builds the frozen additive, redacted coordinator and hermes JSON payload", async () => {
		const coordinator = await buildCoordinatorCheckPayload({ readBrokerDiscovery: async () => discovery });
		const hermes = await buildCoordinatorCheckPayload({ readBrokerDiscovery: async () => discovery });

		expect(coordinator).toEqual(hermes);
		expect(coordinator).toEqual({
			ok: true,
			server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
			readOnly: true,
			tools: [...COORDINATOR_MCP_TOOL_NAMES],
			catalog: { ready: true, reason: null },
			broker: {
				discovery_status: "ready",
				reason: null,
				operational_ready: null,
				bootstrap_supported: true,
				bootstrap_attempted: false,
			},
		});
		const serialized = JSON.stringify(coordinator);
		for (const secret of [
			discovery.url,
			discovery.token,
			discovery.ownerId,
			discovery.incarnation,
			String(discovery.pid),
			String(discovery.port),
		])
			expect(serialized).not.toContain(secret);
	});

	it("classifies every raw discovery result without exposing errors", async () => {
		const cases: Array<{
			name: string;
			readBrokerDiscovery: () => Promise<typeof discovery | null>;
			expected: CoordinatorBrokerObservation;
		}> = [
			{
				name: "unavailable",
				readBrokerDiscovery: async () => null,
				expected: { discovery_status: "unavailable", reason: "absent_or_invalid" },
			},
			{
				name: "unsupported state version",
				readBrokerDiscovery: async () => {
					throw new UnsupportedStateVersionError("/private/broker.json", 99);
				},
				expected: { discovery_status: "error", reason: "unsupported_state_version" },
			},
			{
				name: "access denied",
				readBrokerDiscovery: async () => {
					throw Object.assign(new Error("/private/broker.json"), { code: "EACCES" });
				},
				expected: { discovery_status: "error", reason: "discovery_access_denied" },
			},
			{
				name: "permission denied",
				readBrokerDiscovery: async () => {
					throw Object.assign(new Error("/private/broker.json"), { code: "EPERM" });
				},
				expected: { discovery_status: "error", reason: "discovery_access_denied" },
			},
			{
				name: "read failure",
				readBrokerDiscovery: async () => {
					throw new Error("private failure detail");
				},
				expected: { discovery_status: "error", reason: "discovery_read_failed" },
			},
		];

		for (const testCase of cases) {
			const observation = await probeCoordinatorBrokerCheck({ readBrokerDiscovery: testCase.readBrokerDiscovery });
			expect(observation, testCase.name).toEqual(testCase.expected);
			expect(JSON.stringify(formatCoordinatorCheckPayload(observation))).not.toContain("/private/broker.json");
		}
	});

	it("observes discovery once without attempting bootstrap or transport work", async () => {
		let reads = 0;
		const payload = await buildCoordinatorCheckPayload({
			agentDir: "/private/agent-dir",
			readBrokerDiscovery: async agentDir => {
				reads++;
				expect(agentDir).toBe("/private/agent-dir");
				return null;
			},
		});

		expect(reads).toBe(1);
		expect(payload.broker).toEqual({
			discovery_status: "unavailable",
			reason: "absent_or_invalid",
			operational_ready: null,
			bootstrap_supported: true,
			bootstrap_attempted: false,
		});
	});
});

describe("mcp serve check command compatibility", () => {
	it("keeps coordinator and hermes JSON additive, SDK JSON stable, and human checks discovery-free", async () => {
		await withTempRoot(async root => {
			const agentDir = path.join(root, "broker-path-sentinel-authority-error-sentinel");
			await withAgentDir(agentDir, async () => {
				expect(await Bun.file(brokerDiscoveryPath(agentDir)).exists()).toBe(false);
				const coordinator = JSON.parse(await captureMcpServeCheck(["coordinator", "--check", "--json"]));
				const hermes = JSON.parse(await captureMcpServeCheck(["hermes", "--check", "--json"]));
				const sdk = JSON.parse(await captureMcpServeCheck(["sdk", "--check", "--json"]));

				expect(coordinator).toEqual(hermes);
				expect(coordinator).toEqual({
					ok: true,
					server: { name: COORDINATOR_MCP_SERVER_NAME, protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION },
					readOnly: true,
					tools: [...COORDINATOR_MCP_TOOL_NAMES],
					catalog: { ready: true, reason: null },
					broker: {
						discovery_status: "unavailable",
						reason: "absent_or_invalid",
						operational_ready: null,
						bootstrap_supported: true,
						bootstrap_attempted: false,
					},
				});
				expect(sdk).toEqual({
					ok: true,
					server: { name: "gjc-sdk-mcp" },
					readOnly: false,
					tools: [...SDK_MCP_TOOL_NAMES],
				});
				await fs.mkdir(brokerDiscoveryPath(agentDir), { recursive: true });
				expect(await captureMcpServeCheck(["coordinator", "--check"])).toBe(
					`server: ${COORDINATOR_MCP_SERVER_NAME}\ntools: ${COORDINATOR_MCP_TOOL_NAMES.length}\n`,
				);
				expect(await captureMcpServeCheck(["hermes", "--check"])).toBe(
					`server: ${COORDINATOR_MCP_SERVER_NAME}\ntools: ${COORDINATOR_MCP_TOOL_NAMES.length}\n`,
				);
				expect(await captureMcpServeCheck(["sdk", "--check"])).toBe(
					`server: gjc-sdk-mcp\ntools: ${SDK_MCP_TOOL_NAMES.length}\n`,
				);
				expect(brokerOwnerForTest(agentDir)).toBeUndefined();
				for (const output of [JSON.stringify(coordinator), JSON.stringify(hermes), JSON.stringify(sdk)]) {
					expect(output).not.toContain(agentDir);
					expect(output).not.toContain("authority-error-sentinel");
				}
			});
		});
	});

	it("reads a valid broker discovery without mutating its portable file snapshot", async () => {
		await withTempRoot(async root => {
			const agentDir = path.join(root, "agent-dir");
			const incarnation = brokerProcessIncarnation(process.pid);
			if (!incarnation) throw new Error("Test process incarnation is unavailable.");
			await writeBrokerDiscovery(agentDir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "snapshot-test",
				ownerId: "authority-sentinel",
				pid: process.pid,
				incarnation,
				host: "127.0.0.1",
				port: 54321,
				url: "ws://127.0.0.1:54321/error-sentinel",
				token: "token-sentinel",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			});
			const discoveryFile = brokerDiscoveryPath(agentDir);
			const bytes = await fs.readFile(discoveryFile);
			const before = await fs.stat(discoveryFile);

			await withAgentDir(agentDir, async () => {
				const output = await captureMcpServeCheck(["coordinator", "--check", "--json"]);
				expect(JSON.parse(output)).toMatchObject({
					ok: true,
					broker: { discovery_status: "ready", reason: null },
				});
				for (const sentinel of [agentDir, "authority-sentinel", "error-sentinel", "token-sentinel"])
					expect(output).not.toContain(sentinel);
			});

			const after = await fs.stat(discoveryFile);
			expect(await fs.readFile(discoveryFile)).toEqual(bytes);
			expect(after.size).toBe(before.size);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			if (before.mode !== 0) expect(after.mode).toBe(before.mode);
			if (before.dev !== 0 && before.ino !== 0) {
				expect(after.dev).toBe(before.dev);
				expect(after.ino).toBe(before.ino);
			}
			expect(brokerOwnerForTest(agentDir)).toBeUndefined();
		});
	});
});

describe("coordinator question-state direct contracts", () => {
	it("rotates only an unspawned claimed creation verifier", async () => {
		await withTempRoot(async root => {
			const paths = coordinatorStatePaths(path.join(root, "state"), "namespace-rotate");
			await initializeCoordinatorNamespace(paths);
			const oldVerifier = { key_id: "a".repeat(64), public_key: "old-public-key" };
			const newVerifier = { key_id: "b".repeat(64), public_key: "new-public-key" };
			const claimed = await claimCreationRequest(paths, {
				key_digest: "creation-key",
				request_digest: "request-digest",
				tool: "gjc_coordinator_start_session",
				sidecar_verifier: oldVerifier,
			});
			expect(claimed.phase).toBe("claimed");
			const rotated = await rotateClaimedCreationVerifier(paths, "creation-key", oldVerifier.key_id, newVerifier);
			expect(rotated.sidecar_verifier).toEqual(newVerifier);
			const started = await startCreationRemote(paths, "creation-key", newVerifier);
			expect(started.phase).toBe("remote_started");
			expect(started.sidecar_verifier).toEqual(newVerifier);
			const replayed = await reconcileCreationRemoteVerifier(paths, "creation-key", oldVerifier, newVerifier.key_id);
			expect(replayed.sidecar_verifier).toEqual(newVerifier);
			const rotatedAfterProof = await reconcileCreationRemoteVerifier(
				paths,
				"creation-key",
				oldVerifier,
				oldVerifier.key_id,
			);
			expect(rotatedAfterProof.sidecar_verifier).toEqual(oldVerifier);
			const preserved = await rotateClaimedCreationVerifier(paths, "creation-key", oldVerifier.key_id, newVerifier);
			expect(preserved.phase).toBe("remote_started");
			expect(preserved.sidecar_verifier).toEqual(oldVerifier);
		});
	});

	it("persists the creation-session snapshot and rejects post-close admissions", async () => {
		await withTempRoot(async root => {
			const paths = coordinatorStatePaths(path.join(root, "state"), "namespace-2550");
			await initializeCoordinatorNamespace(paths);
			const session = {
				schema_version: 1 as const,
				namespace_id: "namespace-2550",
				session_id: "session-2550",
				cwd: root,
				created_at: "2026-07-17T00:00:00.000Z",
				updated_at: "2026-07-17T00:00:00.000Z",
				mpreset: null,
				source: "coordinator",
				model: null,
				tmux: { session: null, window: null, pane: null },
				broker: {
					workspace: root,
					endpoint_url: "ws://private.example.test",
					endpoint_generation: 1,
					endpoint_incarnation: "incarnation-1",
					sidecar_verifier: {
						key_id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
						public_key: "test-public-key",
					},
				},
				ephemeral: false,
				visible: true,
			};
			const transaction = await createSessionTransaction(paths, {
				kind: "register",
				session,
				initial_state: "ready_for_input",
				initial_events: [],
			});
			expect(transaction.canonical.session).toEqual(session);
			const file = transactionPath(paths, session.session_id);
			const legacy = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
			delete legacy.creation_intent_digest;
			delete (legacy.canonical as { session: { broker: Record<string, unknown> } }).session.broker.sidecar_verifier;
			for (const event of Object.values(legacy.outbox as Record<string, Record<string, unknown>>)) {
				delete event.public_event_id;
				delete event.public_delivery;
			}
			await fs.writeFile(file, JSON.stringify(legacy));
			const migrated = await readSessionTransaction(paths, session.session_id);
			expect(migrated).toMatchObject({
				creation_intent_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				canonical: {
					session: { broker: { sidecar_verifier: { key_id: expect.stringMatching(/^[a-f0-9]{64}$/) } } },
				},
			});
			expect(Object.values(migrated!.outbox).every(event => event.public_delivery.state === "pending")).toBe(true);
			await withNamespaceRegistry(paths, async registry => {
				registry.deletions["close-2550"] = {
					deletion_id: "close-2550",
					session_id: session.session_id,
					endpoint_incarnation: session.broker.endpoint_incarnation,
					operation_id: "operation-2550",
					key_digest: "key",
					request_digest: "request",
					close_key: "close",
					phase: "intent",
					cleanup: { wal: false, turns: false, reports: false, session: false, events: false },
					authority_digest: "authority",
					created_at: session.created_at,
					updated_at: session.updated_at,
				};
				expect(() => assertCloseAdmission(registry, transaction)).toThrow("session_closing");
				registry.deletions["close-2550"].phase = "completed";
				expect(() => assertCloseAdmission(registry, transaction)).toThrow("session_closing");
			});
		});
	});
});

describe("coordinator WAL delivery paging and capacity compaction", () => {
	const MAX_NORMAL_BYTES = 1024 * 1024;
	const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

	function capacitySessionSnapshot(
		namespaceId: string,
		sessionId: string,
		workspace: string,
	): CanonicalSessionSnapshotV1 {
		return {
			schema_version: 1,
			namespace_id: namespaceId,
			session_id: sessionId,
			cwd: workspace,
			created_at: "2026-08-20T00:00:00.000Z",
			updated_at: "2026-08-20T00:00:00.000Z",
			mpreset: null,
			source: "coordinator",
			model: null,
			tmux: { session: null, window: null, pane: null },
			broker: {
				workspace,
				endpoint_url: "ws://private.example.test",
				endpoint_generation: 1,
				endpoint_incarnation: "incarnation-1",
				sidecar_verifier: { key_id: sha256("sidecar"), public_key: "test-public-key" },
			},
			ephemeral: false,
			visible: true,
		};
	}

	function capacityTurn(
		namespaceId: string,
		sessionId: string,
		turnId: string,
		status: "queued" | "active" | "completed",
		at: string,
	): CanonicalTurnSnapshotV1 {
		return {
			schema_version: 1,
			turn_id: turnId,
			session_id: sessionId,
			namespace_id: namespaceId,
			status,
			prompt: { text: `prompt-${turnId}`, created_at: at, source: "coordinator" },
			delivery: { delivered: false, queued: false, target: null, attempts: [] },
			runtime_provenance: null,
			question_ids: [],
			final_response: { text: null, format: "markdown", source: null, artifact_path: null, truncated: false },
			evidence: [],
			error: null,
			liveness: {},
			created_at: at,
			updated_at: at,
			started_at: status === "queued" ? null : at,
			completed_at: status === "completed" ? at : null,
			terminal_fence: status === "completed" ? { epoch: 2, status: "completed", reason: null, at } : null,
		};
	}

	async function seedCapacitySession(
		paths: CoordinatorStatePaths,
		namespaceId: string,
		workspace: string,
	): Promise<string> {
		await initializeCoordinatorNamespace(paths);
		const sessionId = "session-capacity";
		await createSessionTransaction(paths, {
			kind: "register",
			session: capacitySessionSnapshot(namespaceId, sessionId, workspace),
			initial_state: "running",
			initial_events: [],
		});
		await withSessionTransaction(paths, sessionId, async transaction => {
			for (let index = 1; index <= 5; index++) {
				const at = `2026-08-20T00:00:0${index}.000Z`;
				transaction.canonical.turns[`old-${index}`] = capacityTurn(
					namespaceId,
					sessionId,
					`old-${index}`,
					"completed",
					at,
				);
			}
			transaction.canonical.turns["turn-source"] = capacityTurn(
				namespaceId,
				sessionId,
				"turn-source",
				"active",
				"2026-08-21T00:00:00.000Z",
			);
			transaction.canonical.turns["turn-next"] = capacityTurn(
				namespaceId,
				sessionId,
				"turn-next",
				"queued",
				"2026-08-20T12:00:00.000Z",
			);
			transaction.canonical.queue.ordered_turn_ids = ["turn-next"];
			transaction.canonical.queue.active_turn_id = "turn-source";
		});
		return sessionId;
	}

	function terminalOutboxEvent(
		sessionId: string,
		turnId: string,
		epoch: number,
		at: string,
	): CoordinatorSessionTransactionV1["outbox"][string] {
		const eventId = deterministicOutboxId(sessionId, epoch, "turn.completed", "turn", turnId);
		return {
			id: eventId,
			transaction_revision: epoch,
			kind: "turn.completed",
			entity: "turn",
			entity_id: turnId,
			payload: { session_id: sessionId, turn_id: turnId, status: "completed", created_at: at },
			emitted: false,
			public_event_id: eventId,
			public_delivery: {
				public_event_id: eventId,
				state: "pending",
				claim_fence: null,
				claim_expires_at: null,
				journal_seq: null,
				acknowledged_at: null,
			},
		};
	}

	function capacityReport(
		sessionId: string,
		reportId: string,
		operationId: string,
		turnId: string,
		at: string,
	): CoordinatorSessionTransactionV1["canonical"]["reports"][string] {
		return {
			schema_version: 1,
			report_id: reportId,
			operation_id: operationId,
			session_id: sessionId,
			turn_id: turnId,
			status: "completed",
			summary: "",
			blocker: null,
			pr_url: null,
			evidence_paths: [],
			created_at: at,
		};
	}

	/** Pads a report past normal capacity by more than every reclaimable terminal turn. */
	function padPastNormalCapacity(report: { summary: string }, transaction: CoordinatorSessionTransactionV1): void {
		report.summary = "p".repeat(
			Math.max(1, MAX_NORMAL_BYTES + 50_000 - Buffer.byteLength(JSON.stringify(transaction))),
		);
		expect(Buffer.byteLength(JSON.stringify(transaction))).toBeGreaterThan(MAX_NORMAL_BYTES);
	}

	it("limits each session's claim batch to the remaining delivery page", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-delivery-page";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			await initializeCoordinatorNamespace(paths);
			for (const [sessionId, count] of [
				["session-deficit", 1],
				["session-surplus", 5],
			] as const) {
				await createSessionTransaction(paths, {
					kind: "register",
					session: capacitySessionSnapshot(namespaceId, sessionId, root),
					initial_state: "ready_for_input",
					initial_events: Array.from({ length: count }, (_, index) => ({
						kind: `session.registered.${index}`,
						entity: "session",
						entity_id: `${sessionId}-${index}`,
						seq: index,
						created_at: "2026-08-20T00:00:00.000Z",
					})),
				});
			}
			const page = await enumeratePublicDeliveries(paths, "", 3);
			expect(page.claims.map(claim => claim.session_id)).toEqual([
				"session-deficit",
				"session-surplus",
				"session-surplus",
			]);
			const surplus = await readSessionTransaction(paths, "session-surplus");
			expect(surplus).not.toBeNull();
			expect(
				Object.values(surplus!.outbox)
					.map(event => event.public_delivery.state)
					.sort(),
			).toEqual(["claimed", "claimed", "pending", "pending", "pending"]);
		});
	});

	it("migrates legacy v1 gate provenance before validating the transaction", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-legacy-provenance";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			const sessionId = "session-legacy";
			await initializeCoordinatorNamespace(paths);
			await createSessionTransaction(paths, {
				kind: "register",
				session: capacitySessionSnapshot(namespaceId, sessionId, root),
				initial_state: "ready_for_input",
				initial_events: [],
			});
			await withSessionTransaction(paths, sessionId, async transaction => {
				const at = "2026-08-20T01:00:00.000Z";
				const authority: GateAuthorityEntryV1 = {
					authority: {
						namespace_id: namespaceId,
						session_id: sessionId,
						endpoint_incarnation: "incarnation-1",
						gate_id: "gate-1",
					},
					observation: {
						kind: "valid",
						first_provenance: {
							namespace_id: namespaceId,
							session_id: sessionId,
							endpoint_incarnation: "incarnation-1",
							coordinator_turn_id: "",
							runtime_turn_id: "runtime-turn-1",
							gate_created_at: at,
							schema_hash: "schema-hash",
							stage: "ask",
							kind: "question",
						},
					},
					outcome: { state: "stale", reason: "terminal_uncertain" },
					first_seen_at: at,
					updated_at: at,
				};
				transaction.canonical.gate_authorities["authority-legacy"] = authority;
			});
			// Rewind the WAL to the pre-upgrade v1 shape: no intent digest, verifier,
			// public delivery projection, or namespaced gate provenance.
			const file = transactionPath(paths, sessionId);
			const legacy = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
			delete legacy.creation_intent_digest;
			const canonical = legacy.canonical as {
				session: { broker: Record<string, unknown> };
				gate_authorities: Record<string, { observation: { first_provenance: Record<string, unknown> } }>;
			};
			delete canonical.session.broker.sidecar_verifier;
			for (const authority of Object.values(canonical.gate_authorities)) {
				const provenance = authority.observation.first_provenance;
				for (const field of ["namespace_id", "session_id", "coordinator_turn_id", "endpoint_incarnation"])
					delete provenance[field];
			}
			for (const event of Object.values(legacy.outbox as Record<string, Record<string, unknown>>)) {
				delete event.public_event_id;
				delete event.public_delivery;
			}
			await fs.writeFile(file, JSON.stringify(legacy));
			const originalBytes = await Bun.file(file).text();
			const release = await acquireFileLock(transactionLockPath(paths, sessionId));
			let migrated: CoordinatorSessionTransactionV1 | null;
			try {
				migrated = await readSessionTransaction(paths, sessionId);
				expect(await Bun.file(file).text()).toBe(originalBytes);
				await repairLegacyReportIds(paths, sessionId);
				expect(await Bun.file(file).text()).toBe(originalBytes);
				const signal = AbortSignal.abort(new Error("read cancelled"));
				await expect(readSessionTransaction(paths, sessionId, { signal })).rejects.toThrow("read cancelled");
			} finally {
				await release();
			}
			expect(migrated).toMatchObject({
				creation_intent_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				canonical: {
					session: { broker: { sidecar_verifier: { key_id: expect.stringMatching(/^[a-f0-9]{64}$/) } } },
					gate_authorities: {
						"authority-legacy": {
							observation: {
								first_provenance: {
									namespace_id: namespaceId,
									session_id: sessionId,
									endpoint_incarnation: "incarnation-1",
									coordinator_turn_id: "",
								},
							},
						},
					},
				},
			});
			// The write path must accept the migrated WAL without a second migration.
			await withSessionTransaction(paths, sessionId, async transaction => {
				transaction.canonical.desired_session_state = "running";
			});
			expect((await readSessionTransaction(paths, sessionId))?.canonical.desired_session_state).toBe("running");
		});
	});

	it("commits stable creation outbox ids for maximal-length session ids", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-max-session-id";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			await initializeCoordinatorNamespace(paths);
			const sessionId = `a${"b".repeat(127)}`;
			expect(sessionId).toHaveLength(128);
			const transaction = await createSessionTransaction(paths, {
				kind: "register",
				session: capacitySessionSnapshot(namespaceId, sessionId, root),
				initial_state: "ready_for_input",
				initial_events: [{ kind: "session.registered", entity: "session", entity_id: sessionId }],
			});
			const stableId = deterministicOutboxId(
				sessionId,
				1,
				"session.registered",
				"session",
				sessionId,
				"incarnation-1",
			);
			expect(stableId.length).toBeLessThanOrEqual(512);
			expect(
				deterministicOutboxId(sessionId, 1, "session.registered", "session", sessionId, "incarnation-2"),
			).not.toBe(stableId);
			expect(Object.keys(transaction.outbox)).toContain(stableId);
			expect(deterministicOutboxId(sessionId, 1, "k".repeat(600), "session", sessionId, "incarnation-1")).toMatch(
				/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,511}$/,
			);
			expect(await readSessionTransaction(paths, sessionId)).toMatchObject({ session_id: sessionId });
		});
	});

	it("retains promotion endpoints when capacity compaction visits terminal turns", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-capacity-promotion";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			const sessionId = await seedCapacitySession(paths, namespaceId, root);
			await withSessionTransaction(paths, sessionId, async transaction => {
				const epoch = transaction.revision + 1;
				const at = "2026-08-22T00:00:00.000Z";
				const source = transaction.canonical.turns["turn-source"];
				source.status = "completed";
				source.completed_at = at;
				source.updated_at = at;
				source.terminal_fence = { epoch, status: "completed", reason: null, at };
				const next = transaction.canonical.turns["turn-next"];
				next.status = "active";
				next.started_at = at;
				next.updated_at = at;
				transaction.canonical.queue.ordered_turn_ids = [];
				transaction.canonical.queue.active_turn_id = "turn-next";
				transaction.canonical.queue.selected_promotion = {
					from_turn_id: "turn-source",
					to_turn_id: "turn-next",
					revision: epoch,
				};
				transaction.canonical.desired_session_state = "running";
				transaction.outbox[terminalOutboxEvent(sessionId, "turn-source", epoch, at).id] = terminalOutboxEvent(
					sessionId,
					"turn-source",
					epoch,
					at,
				);
				const report = capacityReport(
					sessionId,
					`report-${sha256("promotion-capacity")}`,
					"operation-report",
					"",
					at,
				);
				transaction.canonical.reports[report.report_id] = report;
				padPastNormalCapacity(report, transaction);
			});
			const reloaded = await readSessionTransaction(paths, sessionId);
			expect(reloaded?.canonical.desired_session_state).toBe("running");
			expect(reloaded?.canonical.turns["turn-source"]).toBeTruthy();
			expect(reloaded?.canonical.queue.selected_promotion).toEqual({
				from_turn_id: "turn-source",
				to_turn_id: "turn-next",
				revision: expect.any(Number),
			});
		});
	});

	it("keeps unsealed report operations during terminal capacity compaction", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-capacity-operation";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			const sessionId = await seedCapacitySession(paths, namespaceId, root);
			await withSessionTransaction(paths, sessionId, async transaction => {
				transaction.requests.operations["operation-status"] = {
					operation_id: "operation-status",
					tool: "gjc_coordinator_report_status",
					key_digest: sha256("report-key"),
					request_digest: sha256("report-request"),
					local_id: sha256("report-local"),
					phase: "claimed",
					intent: { session_id: sessionId, turn_id: "turn-source", status: "completed" },
					created_at: "2026-08-21T00:00:00.000Z",
					updated_at: "2026-08-21T00:00:00.000Z",
				};
			});
			await withSessionTransaction(paths, sessionId, async transaction => {
				const epoch = transaction.revision + 1;
				const at = "2026-08-22T00:00:00.000Z";
				const source = transaction.canonical.turns["turn-source"];
				source.status = "completed";
				source.completed_at = at;
				source.updated_at = at;
				source.terminal_fence = { epoch, status: "completed", reason: null, at };
				transaction.canonical.queue.ordered_turn_ids = [];
				transaction.canonical.queue.active_turn_id = null;
				transaction.canonical.queue.selected_promotion = null;
				transaction.canonical.desired_session_state = "completed";
				transaction.outbox[terminalOutboxEvent(sessionId, "turn-source", epoch, at).id] = terminalOutboxEvent(
					sessionId,
					"turn-source",
					epoch,
					at,
				);
				const report = capacityReport(
					sessionId,
					`report-${sha256("operation-capacity")}`,
					"operation-status",
					"turn-source",
					at,
				);
				transaction.canonical.reports[report.report_id] = report;
				padPastNormalCapacity(report, transaction);
			});
			const reloaded = await readSessionTransaction(paths, sessionId);
			expect(reloaded?.requests.operations["operation-status"]?.phase).toBe("claimed");
			expect(reloaded?.canonical.turns["turn-source"]).toBeTruthy();
			expect(Object.values(reloaded?.canonical.reports ?? {})).toEqual([
				expect.objectContaining({ operation_id: "operation-status", turn_id: "turn-source" }),
			]);
		});
	});

	it("archives sealed canonical history before compacting the hot WAL", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-capacity-archive";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			const sessionId = await seedCapacitySession(paths, namespaceId, root);
			await withSessionTransaction(paths, sessionId, async transaction => {
				const report = capacityReport(
					sessionId,
					`report-${sha256("archive-capacity")}`,
					"operation-archive",
					"turn-source",
					"2026-08-22T00:00:00.000Z",
				);
				transaction.canonical.reports[report.report_id] = report;
				padPastNormalCapacity(report, transaction);
			});
			const reloaded = await readSessionTransaction(paths, sessionId);
			expect(reloaded?.canonical.turns["old-1"]).toBeUndefined();
			const endpointIncarnation = reloaded?.canonical.session.broker.endpoint_incarnation;
			if (!endpointIncarnation) throw new Error("missing endpoint incarnation");
			const archive = JSON.parse(
				await fs.readFile(
					path.join(path.dirname(transactionPath(paths, sessionId)), `history.${endpointIncarnation}.v1.json`),
					"utf8",
				),
			) as { schema_version: number; turns: Record<string, CanonicalTurnSnapshotV1> };
			expect(archive.schema_version).toBe(1);
			expect(archive.turns["old-1"]).toMatchObject({ turn_id: "old-1", status: "completed" });
		});
	});

	it("keeps the prompt request that proves an active turn's runtime receipt", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-capacity-receipt";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			const sessionId = await seedCapacitySession(paths, namespaceId, root);
			const promptKey = sha256("receipt-prompt-key");
			// Timestamps must predate RETENTION_MS so the retention sweep actually
			// considers this request; a recent request is never a regression subject.
			const retired = "2026-01-01T00:00:00.000Z";
			// An acknowledged active turn proves its runtime receipt only through the
			// prompt request that carries it. Retention used to drop that request once
			// it was completed and old, which left the WAL failing its own receipt
			// invariant on the very next read — permanently, for the whole namespace.
			await withSessionTransaction(paths, sessionId, async transaction => {
				const source = transaction.canonical.turns["turn-source"];
				source.prompt = { ...source.prompt, created_at: retired };
				source.created_at = retired;
				source.updated_at = retired;
				source.started_at = retired;
				source.delivery = {
					...source.delivery,
					delivered: true,
					prompt_acknowledged: true,
					state: "acknowledged",
					runtime_command_id: "command-receipt",
					runtime_turn_id: "runtime-turn-receipt",
				} as typeof source.delivery;
				transaction.requests.prompts[promptKey] = {
					request_id: "request-receipt",
					key_digest: promptKey,
					request_digest: sha256("receipt-request"),
					operation: "turn.prompt",
					coordinator_turn_id: "turn-source",
					phase: "completed",
					canonical_prompt: { text: "prompt-turn-source" },
					sdk_idempotency_key: "idempotency-receipt",
					runtime_receipt: {
						accepted: true,
						command_id: "command-receipt",
						turn_id: "runtime-turn-receipt",
					},
					created_at: retired,
					updated_at: retired,
				} as (typeof transaction.requests.prompts)[string];
			});
			// Any later write runs compaction, which is where retention used to
			// delete the receipt-bearing request and corrupt the WAL.
			await withSessionTransaction(paths, sessionId, async transaction => {
				transaction.canonical.session.updated_at = "2026-09-30T00:00:00.000Z";
			});
			// Before the fix this read threw state_corrupt instead of returning.
			const reloaded = await readSessionTransaction(paths, sessionId);
			expect(reloaded?.requests.prompts[promptKey]?.runtime_receipt?.accepted).toBe(true);
			expect(reloaded?.canonical.turns["turn-source"]?.status).toBe("active");
		});
	});

	it("migrates legacy report ids onto the canonical digest form", async () => {
		await withTempRoot(async root => {
			const namespaceId = "namespace-legacy-report";
			const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
			const sessionId = await seedCapacitySession(paths, namespaceId, root);
			// Reports minted before COORDINATOR_REPORT_ID_PATTERN carry a uuid-shaped
			// id. The reader rejects that shape, and because the reader backs the
			// namespace-wide scan, one historical report bricked every coordination
			// read rather than only its own session.
			const legacyReportId = "report-9ae9a2fd-3939-46c7-8178-185e2d9a84b1";
			const file = transactionPath(paths, sessionId);
			const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
				canonical: { reports: Record<string, unknown> };
				requests: { operations: Record<string, Record<string, unknown>> };
				outbox: Record<string, Record<string, unknown>>;
			};
			raw.canonical.reports[legacyReportId] = {
				schema_version: 1,
				report_id: legacyReportId,
				operation_id: "report:i50-rp4",
				session_id: sessionId,
				turn_id: "",
				status: "probe",
				summary: "",
				blocker: null,
				pr_url: null,
				evidence_paths: [],
				created_at: "2026-08-18T13:19:54.844Z",
			};
			raw.requests.operations["report-operation"] = {
				operation_id: "report-operation",
				tool: "gjc_coordinator_report_status",
				key_digest: sha256("report-operation-key"),
				request_digest: sha256("report-operation-request"),
				local_id: legacyReportId,
				phase: "completed",
				intent: { session_id: sessionId },
				created_at: "2026-08-18T13:19:54.844Z",
				updated_at: "2026-08-18T13:19:54.844Z",
			};
			raw.outbox["legacy-report-event"] = {
				id: "legacy-report-event",
				transaction_revision: 1,
				kind: "report.written",
				entity: "report",
				entity_id: legacyReportId,
				payload: { session_id: sessionId, report_id: legacyReportId, status: "probe" },
				emitted: false,
				public_event_id: "legacy-report-event",
				public_delivery: {
					public_event_id: "legacy-report-event",
					state: "pending",
					claim_fence: null,
					claim_expires_at: null,
					journal_seq: null,
					acknowledged_at: null,
				},
			};
			await fs.writeFile(file, JSON.stringify(raw));
			// Before the fix this read threw state_corrupt instead of returning.
			const release = await acquireFileLock(transactionLockPath(paths, sessionId));
			try {
				expect((await readSessionTransaction(paths, sessionId))?.canonical.reports[legacyReportId]).toBeUndefined();
				await expect(repairLegacyReportIds(paths, sessionId)).rejects.toBeInstanceOf(FileLockAcquireError);
				await expect(
					repairLegacyReportIds(paths, sessionId, { signal: AbortSignal.abort(new Error("repair cancelled")) }),
				).rejects.toThrow("repair cancelled");
				expect(await Bun.file(file).json()).toEqual(raw);
			} finally {
				await release();
			}
			const reloaded = await readSessionTransaction(paths, sessionId);
			if (!reloaded) throw new Error("legacy transaction did not reload");
			expect(reloaded?.canonical.reports[legacyReportId]).toBeUndefined();
			const migrated = Object.entries(reloaded.canonical.reports).find(
				([, report]) => report.operation_id === "report:i50-rp4",
			);
			if (!migrated) throw new Error("legacy report did not migrate");
			const [migratedReportId, migratedReport] = migrated;
			expect(migratedReportId).toMatch(/^report-[a-f0-9]{64}$/);
			expect(migratedReport).toMatchObject({ report_id: migratedReportId, status: "probe" });
			expect(migratedReportId).toBe(reloaded.requests.operations["report-operation"]?.local_id);
			const reportEvent = reloaded.outbox["legacy-report-event"];
			expect(reportEvent.entity_id).toBe(migratedReportId);
			expect(reportEvent.payload.report_id).toBe(migratedReportId);
			await repairLegacyReportIds(paths, sessionId);
			const persisted = JSON.parse(await fs.readFile(file, "utf8")) as CoordinatorSessionTransactionV1;
			expect(persisted.canonical.reports[legacyReportId]).toBeUndefined();
			expect(persisted.requests.operations["report-operation"]?.local_id).toBe(migratedReportId);
		});
	});

	it(
		"recovers namespace event reads with a legacy-id WAL beside a corrupt peer",
		async () => {
			await withTempRoot(async root => {
				const stateRoot = path.join(root, "state");
				const env = {
					GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_PROFILE: "coordinator-wal-test",
					GJC_COORDINATOR_MCP_REPO: "namespace-recovery",
				};
				const namespaceId = coordinatorNamespaceIdentity(env);
				const paths = coordinatorStatePaths(stateRoot, namespaceId);
				const healthySessionId = "session-healthy";
				const legacySessionId = "session-legacy";
				const corruptSessionId = "session-corrupt";
				await initializeCoordinatorNamespace(paths);
				for (const [sessionId, eventKind] of [
					[healthySessionId, "healthy.session.registered"],
					[legacySessionId, "legacy.session.registered"],
					[corruptSessionId, "corrupt.session.registered"],
				] as const) {
					await createSessionTransaction(paths, {
						kind: "register",
						session: capacitySessionSnapshot(namespaceId, sessionId, root),
						initial_state: "ready_for_input",
						initial_events: [
							{
								kind: eventKind,
								entity: "session",
								entity_id: sessionId,
								created_at: "2026-08-22T00:00:00.000Z",
							},
						],
					});
				}
				const legacyReportId = "report-9ae9a2fd-3939-46c7-8178-185e2d9a84b1";
				const legacyFile = transactionPath(paths, legacySessionId);
				const legacyRaw = JSON.parse(await fs.readFile(legacyFile, "utf8")) as {
					canonical: { reports: Record<string, unknown> };
				};
				legacyRaw.canonical.reports[legacyReportId] = {
					schema_version: 1,
					report_id: legacyReportId,
					operation_id: "namespace-recovery-report",
					session_id: legacySessionId,
					turn_id: "",
					status: "probe",
					summary: "legacy report",
					blocker: null,
					pr_url: null,
					evidence_paths: [],
					created_at: "2026-08-18T13:19:54.844Z",
				};
				await fs.writeFile(legacyFile, JSON.stringify(legacyRaw));
				const projections = path.join(stateRoot, "v1", namespaceId, "projections", "reports");
				await fs.mkdir(projections, { recursive: true });
				await fs.writeFile(
					path.join(projections, `${legacyReportId}.json`),
					JSON.stringify(legacyRaw.canonical.reports[legacyReportId]),
				);
				await fs.writeFile(transactionPath(paths, corruptSessionId), '{"schema_version":1');

				const server = createCoordinatorMcpServer({ env });
				try {
					const watch = await server.callTool("gjc_coordinator_watch_events", {
						timeout_ms: 0,
						after_seq: 0,
						limit: 50,
					});
					expect(watch).toMatchObject({ ok: true });
					expect(JSON.stringify(watch)).toContain(healthySessionId);
					expect(JSON.stringify(watch)).toContain(legacySessionId);
					expect(await fs.stat(path.join(projections, `${legacyReportId}.json`)).catch(() => null)).toBeNull();
					const migratedFiles = await fs.readdir(projections);
					expect(migratedFiles.some(file => /^report-[a-f0-9]{64}\.json$/.test(file))).toBe(true);

					const scopedCorrupt = await server.callTool("gjc_coordinator_watch_events", {
						session_id: corruptSessionId,
						timeout_ms: 0,
						after_seq: 0,
						limit: 50,
					});
					expect(scopedCorrupt).toMatchObject({ ok: false, error: { code: "unavailable" } });
				} finally {
					await server.close();
				}
			});
		},
		{ timeout: 15_000 },
	);
});
