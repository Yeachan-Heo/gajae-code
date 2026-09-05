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
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../src/coordinator/contract";
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
	rewriteSessionEndpointAuthority,
	rotateClaimedCreationVerifier,
	startCreationRemote,
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

	const migrationAt = "2026-08-20T02:00:00.000Z";
	const legacyEndpointIncarnation = "a".repeat(64);
	const currentEndpointIncarnation = "b".repeat(64);
	const migrationAuthorityId = (namespaceId: string, sessionId: string, endpointIncarnation: string): string =>
		createHash("sha256").update(`${namespaceId}\0${sessionId}\0${endpointIncarnation}\0gate-migration`).digest("hex");

	async function seedGateMigrationState(root: string, answered: boolean) {
		const namespaceId = answered ? "namespace-gate-answered" : "namespace-gate-pending";
		const sessionId = answered ? "session-gate-answered" : "session-gate-pending";
		const paths = coordinatorStatePaths(path.join(root, "state"), namespaceId);
		const authorityId = migrationAuthorityId(namespaceId, sessionId, legacyEndpointIncarnation);
		const session: CanonicalSessionSnapshotV1 = {
			schema_version: 1,
			namespace_id: namespaceId,
			session_id: sessionId,
			cwd: root,
			created_at: migrationAt,
			updated_at: migrationAt,
			mpreset: null,
			source: "coordinator",
			model: null,
			tmux: { session: null, window: null, pane: null },
			broker: {
				workspace: root,
				endpoint_url: "ws://private.example.test",
				endpoint_generation: 1,
				endpoint_incarnation: legacyEndpointIncarnation,
				sidecar_verifier: { key_id: createHash("sha256").update("sidecar").digest("hex"), public_key: "test-key" },
			},
			ephemeral: false,
			visible: true,
		};
		await initializeCoordinatorNamespace(paths);
		await createSessionTransaction(paths, {
			kind: "register",
			session,
			initial_state: answered ? "completed" : "needs_user_input",
			initial_events: [
				{
					kind: "question.opened",
					entity: "question",
					entity_id: "question-migration",
					turn_id: "turn-migration",
					question_id: "question-migration",
					authority_id: authorityId,
					created_at: migrationAt,
				},
			],
		});
		await withSessionTransaction(paths, sessionId, async transaction => {
			const runtimeProvenance = {
				namespace_id: namespaceId,
				session_id: sessionId,
				endpoint_incarnation: legacyEndpointIncarnation,
				coordinator_turn_id: "turn-migration",
				runtime_turn_id: "runtime-migration",
				gate_created_at: migrationAt,
				schema_hash: "schema-migration",
				stage: "deep-interview",
				kind: "question",
			};
			transaction.canonical.turns["turn-migration"] = {
				schema_version: 1,
				turn_id: "turn-migration",
				session_id: sessionId,
				namespace_id: namespaceId,
				status: answered ? "completed" : "waiting_for_answer",
				prompt: { text: "Answer the migration question", created_at: migrationAt, source: "coordinator" },
				delivery: { delivered: false, queued: false, target: null, attempts: [] },
				runtime_provenance: runtimeProvenance,
				question_ids: ["question-migration"],
				final_response: { text: null, format: "markdown", source: null, artifact_path: null, truncated: false },
				evidence: [],
				error: null,
				liveness: {},
				created_at: migrationAt,
				updated_at: migrationAt,
				started_at: migrationAt,
				completed_at: answered ? migrationAt : null,
				terminal_fence: answered ? { epoch: 2, status: "completed", reason: null, at: migrationAt } : null,
			};
			const binding = answered ? "answered-migration-binding" : "pending-migration-binding";
			transaction.canonical.questions["question-migration"] = {
				question_id: "question-migration",
				authority_id: authorityId,
				session_id: sessionId,
				turn_id: "turn-migration",
				endpoint_incarnation: legacyEndpointIncarnation,
				stage: "deep-interview",
				kind: "question",
				prompt: "Answer the migration question",
				status: answered ? "answered" : "pending",
				binding_plaintext: binding,
				binding_sha256: createHash("sha256").update(binding).digest("hex"),
				codec: {
					schema_version: 1,
					labels: ["Continue"],
					recommended_index: null,
					multi: false,
					allow_empty: false,
					other_allowed: true,
					clarification_allowed: true,
				},
				claim_fence_epoch: answered ? 1 : null,
				answer_request_id: answered ? "answer-migration" : null,
				created_at: migrationAt,
				updated_at: migrationAt,
				answered_at: answered ? migrationAt : null,
				history: answered
					? [
							{ at: migrationAt, status: "pending", reason: null },
							{ at: migrationAt, status: "answered", reason: null },
						]
					: [{ at: migrationAt, status: "pending", reason: null }],
			};
			transaction.canonical.gate_authorities[authorityId] = {
				authority: {
					namespace_id: namespaceId,
					session_id: sessionId,
					endpoint_incarnation: legacyEndpointIncarnation,
					gate_id: "gate-migration",
				},
				observation: { kind: "valid", first_provenance: runtimeProvenance },
				outcome: answered
					? { state: "answered", turn_id: "turn-migration", question_id: "question-migration" }
					: { state: "pending", turn_id: "turn-migration", question_id: "question-migration" },
				first_seen_at: migrationAt,
				updated_at: migrationAt,
			};
			if (answered) {
				const answerHash = createHash("sha256").update("answer").digest("hex");
				const bindingHash = createHash("sha256").update(binding).digest("hex");
				transaction.requests.answers["answer-key"] = {
					request_id: "answer-migration",
					key_digest: "answer-key",
					request_digest: "answer-request-digest",
					answer_hash: answerHash,
					answer_binding_sha256: bindingHash,
					authority_id: authorityId,
					question_id: "question-migration",
					turn_id: "turn-migration",
					endpoint_incarnation: legacyEndpointIncarnation,
					sdk_idempotency_key: "answer-migration",
					claim_fence_epoch: 1,
					phase: "completed",
					safe_receipt: {
						status: "accepted",
						answer_hash: answerHash,
						answer_binding_sha256: bindingHash,
						authority_id: authorityId,
						turn_id: "turn-migration",
						endpoint_incarnation: legacyEndpointIncarnation,
						claim_fence_epoch: 1,
						resolved_at: migrationAt,
					},
					created_at: migrationAt,
					updated_at: migrationAt,
				};
			}
			transaction.canonical.queue.active_turn_id = answered ? null : "turn-migration";
			transaction.canonical.desired_session_state = answered ? "completed" : "needs_user_input";
		});
		return { paths, namespaceId, sessionId, authorityId };
	}

	it("rekeys a pending gate authority and preserves one question.opened event", async () => {
		await withTempRoot(async root => {
			const {
				paths,
				namespaceId,
				sessionId,
				authorityId: legacyAuthorityId,
			} = await seedGateMigrationState(root, false);
			const before = await readSessionTransaction(paths, sessionId);
			expect(before).not.toBeNull();
			expect(Object.values(before!.outbox).filter(event => event.kind === "question.opened")).toHaveLength(1);

			const currentAuthorityId = migrationAuthorityId(namespaceId, sessionId, currentEndpointIncarnation);
			const rewritten = await rewriteSessionEndpointAuthority(
				paths,
				sessionId,
				legacyEndpointIncarnation,
				currentEndpointIncarnation,
				"endpoint-file-pending",
			);
			expect(rewritten.broker).toMatchObject({
				endpoint_incarnation: currentEndpointIncarnation,
				endpoint_file_id: "endpoint-file-pending",
			});
			const migrated = await readSessionTransaction(paths, sessionId);
			expect(migrated).not.toBeNull();
			expect(Object.keys(migrated!.canonical.gate_authorities)).toEqual([currentAuthorityId]);
			expect(migrated!.canonical.gate_authorities[legacyAuthorityId]).toBeUndefined();
			expect(migrated!.canonical.gate_authorities[currentAuthorityId]).toMatchObject({
				authority: { endpoint_incarnation: currentEndpointIncarnation, gate_id: "gate-migration" },
				observation: { first_provenance: { endpoint_incarnation: currentEndpointIncarnation } },
			});
			expect(migrated!.canonical.questions["question-migration"]).toMatchObject({
				authority_id: currentAuthorityId,
				endpoint_incarnation: currentEndpointIncarnation,
				status: "pending",
			});
			expect(Object.values(migrated!.outbox).filter(event => event.kind === "question.opened")).toHaveLength(1);
			expect(
				Object.values(migrated!.outbox).find(event => event.kind === "question.opened")?.payload.authority_id,
			).toBe(currentAuthorityId);

			await rewriteSessionEndpointAuthority(
				paths,
				sessionId,
				legacyEndpointIncarnation,
				currentEndpointIncarnation,
				"endpoint-file-pending",
			);
			const replayed = await readSessionTransaction(paths, sessionId);
			expect(Object.keys(replayed!.canonical.gate_authorities)).toEqual([currentAuthorityId]);
			expect(Object.values(replayed!.outbox).filter(event => event.kind === "question.opened")).toHaveLength(1);
		});
	});

	it("rekeys an answered gate authority without breaking its durable answer receipt", async () => {
		await withTempRoot(async root => {
			const {
				paths,
				namespaceId,
				sessionId,
				authorityId: legacyAuthorityId,
			} = await seedGateMigrationState(root, true);
			const currentAuthorityId = migrationAuthorityId(namespaceId, sessionId, currentEndpointIncarnation);
			await rewriteSessionEndpointAuthority(
				paths,
				sessionId,
				legacyEndpointIncarnation,
				currentEndpointIncarnation,
				"endpoint-file-answered",
			);
			const migrated = await readSessionTransaction(paths, sessionId);
			expect(migrated).not.toBeNull();
			expect(Object.keys(migrated!.canonical.gate_authorities)).toEqual([currentAuthorityId]);
			expect(migrated!.canonical.gate_authorities[legacyAuthorityId]).toBeUndefined();
			expect(migrated!.canonical.gate_authorities[currentAuthorityId]?.outcome).toEqual({
				state: "answered",
				turn_id: "turn-migration",
				question_id: "question-migration",
			});
			expect(migrated!.canonical.questions["question-migration"]).toMatchObject({
				authority_id: currentAuthorityId,
				endpoint_incarnation: currentEndpointIncarnation,
				status: "answered",
				answer_request_id: "answer-migration",
			});
			expect(migrated!.requests.answers["answer-key"]).toMatchObject({
				authority_id: currentAuthorityId,
				endpoint_incarnation: currentEndpointIncarnation,
				phase: "completed",
				safe_receipt: {
					authority_id: currentAuthorityId,
					endpoint_incarnation: currentEndpointIncarnation,
					status: "accepted",
				},
			});
			expect(
				Object.values(migrated!.outbox).find(event => event.kind === "question.opened")?.payload.authority_id,
			).toBe(currentAuthorityId);
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
			const migrated = await readSessionTransaction(paths, sessionId);
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
});
