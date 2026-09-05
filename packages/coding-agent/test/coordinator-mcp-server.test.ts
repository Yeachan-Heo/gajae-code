import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai";
import {
	type CodexHandoffOriginV1,
	readCodexHandoff,
	registerCodexHandoff,
} from "../src/coordinator-mcp/codex-handoff";
import { buildCoordinatorMcpConfig } from "../src/coordinator-mcp/policy";
import {
	buildCoordinatorAskAnswerSchema,
	type PrivateAskGateCodecV1,
	validateCoordinatorAskAnswer,
} from "../src/coordinator-mcp/question-gate-codec";
import {
	acknowledgePublicDelivery,
	admitSessionClose,
	advanceDeletion,
	advanceDeliveryDiscoveryCursor,
	claimPublicDelivery,
	coordinatorStatePaths,
	deterministicOutboxId,
	enumeratePublicDeliveries,
	readDeliveryDiscoveryCursor,
	readSessionTransaction,
	transactionPath,
	withNamespaceRegistry,
	withSessionTransaction,
} from "../src/coordinator-mcp/question-state";
import {
	appendCoordinatorEventForTest,
	awaitCodexWakePublishesForTest,
	awaitEventWebhookDeliveriesForTest,
	type CoordinatorMcpServer,
	createCoordinatorMcpServer,
	readCoordinatorArtifact,
} from "../src/coordinator-mcp/server";
import { withSessionStateFileLock } from "../src/gjc-runtime/session-state-lock";
import { persistMcpDelegateHostContext } from "../src/hooks/mcp-delegate-host-context";
import { schemaHash } from "../src/modes/shared/agent-wire/workflow-gate-schema";
import {
	buildAskGateAnswerSchema,
	GATE_OTHER_OPTION,
	type WorkflowGate,
} from "../src/modes/shared/agent-wire/workflow-gate-types";
import {
	type BrokerDiscovery,
	brokerDiscoveryPath,
	brokerProcessIncarnation,
	readBrokerDiscovery,
	writeBrokerDiscovery,
} from "../src/sdk/broker/discovery";
import {
	brokerOwnerForTest,
	type EnsureBrokerSettings,
	startFixtureBrokerWithLeaseForTest,
} from "../src/sdk/broker/ensure";
import type { SessionIndex } from "../src/sdk/broker/session-index";
import { UnsupportedStateVersionError } from "../src/sdk/broker/state-version";
import { type SdkClient, SdkClientError } from "../src/sdk/client/client";
import { resolveSdkHostModel, type SdkHostModelRegistryLoader } from "../src/sdk/host/model-pin";
import { type SessionRouterClient, SessionRouterError } from "../src/sdk/router";
import { installExactIdentityNatives } from "./helpers/exact-identity-natives";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
} from "./helpers/fixture-broker-cleanup";
import { prepareExactSessionAuthority } from "./helpers/sdk-exact-session-authority";

// Coordinator state writes serialize on a lock whose removals go through identity-bound
// native primitives; point them at a working implementation.
installExactIdentityNatives();

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-server-"));
	const canonical = await fs.realpath(dir);
	tempDirs.push(canonical);
	return canonical;
}

async function injectPendingDeliveryForTest(
	server: CoordinatorMcpServer,
	sessionId: string,
	publicEventId: string,
	revision: number,
): Promise<void> {
	const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
	await withSessionTransaction(paths, sessionId, async transaction => {
		transaction.revision = Math.max(transaction.revision, revision - 1);
		const event = {
			id: `txn:${sessionId}:${revision}:turn.active:turn:${publicEventId}`,
			transaction_revision: revision,
			kind: "turn.active",
			entity: "turn",
			entity_id: publicEventId,
			payload: {
				session_id: sessionId,
				turn_id: publicEventId,
				status: "active",
				created_at: new Date().toISOString(),
			},
			emitted: true,
			public_event_id: publicEventId,
			public_delivery: {
				public_event_id: publicEventId,
				state: "pending",
				claim_fence: null,
				claim_expires_at: null,
				journal_seq: null,
				acknowledged_at: null,
			},
		};
		(transaction.outbox as Record<string, unknown>)[event.id] = event;
	});
	await withNamespaceRegistry(paths, async registry => {
		registry.retained_sessions ??= {};
		registry.retained_sessions[sessionId] = { session_id: sessionId, updated_at: new Date().toISOString() };
	});
	await fs.access(transactionPath(paths, sessionId));
}

/** Real detached-broker fixtures are cleaned solely by cleanupFixtureRoot. */
async function managedFixtureRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-managed-broker-"));
	return fs.realpath(dir);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

type SdkControl = { operation: string; input: Record<string, unknown>; idempotencyKey?: string };

type SdkControlServerOptions = {
	platform?: NodeJS.Platform;
	ensureBroker?: (settings: EnsureBrokerSettings) => Promise<BrokerDiscovery>;
	/** Reopen the coordinator without restarting the already-published fake SDK host. */
	preserveEndpointAuthority?: boolean;
	canonicalizePath?: (value: string) => Promise<string>;
	controlResult?: (control: SdkControl) => unknown;
	globalResult?: (
		operation: string,
		input: Record<string, unknown>,
		brokerSessions: Array<Record<string, unknown>>,
	) => unknown;

	promptAckTimeoutMs?: number;
	mutations?: string;
	controlOptions?: Array<{ idempotencyKey?: string; timeoutMs?: number }>;
	/** Per-query transport options, in dispatch order, parallel to the recorded query names. */
	queryOptions?: Array<{ timeoutMs?: number } | undefined>;
	/** Deterministic barrier after the accepted prompt receipt is durable and before turn finalization. */
	afterPromptReceiptPersisted?: (sessionId: string) => void | Promise<void>;
	/** Deterministic barrier after an answer dispatch is claimed and before final admission. */
	afterAnswerRemoteStarted?: (sessionId: string) => void | Promise<void>;
	/** Deterministic barrier between canonical acknowledgement and projection. */
	afterCanonicalTurnCommit?: (sessionId: string) => void | Promise<void>;
	/** Deterministic barrier between a canonical report commit and projection repair. */
	afterCanonicalReportCommit?: (sessionId: string) => void | Promise<void>;
	/** Deterministic barrier after canonical report safe response persistence and before outer idempotency completion. */
	afterCanonicalReportSafeResponse?: (sessionId: string, response: Record<string, unknown>) => void | Promise<void>;
	afterDelegateAdmission?: (sessionId: string) => void | Promise<void>;
	beforeDelegateResponseCommit?: () => void | Promise<void>;
	afterDelegateResponseCommit?: () => void | Promise<void>;
	beforeDelegatePinRecovery?: () => void | Promise<void>;
	/** Every raw session frame the server sent, in order (activation frames included). */
	sessionFrames?: Array<Record<string, unknown>>;
	sessionFrameResult?: (frame: Record<string, unknown>) => unknown;
	codexTransportFactory?: NonNullable<
		NonNullable<Parameters<typeof createCoordinatorMcpServer>[0]>["services"]
	>["codexTransportFactory"];
	eventWebhookDelivery?: NonNullable<
		NonNullable<Parameters<typeof createCoordinatorMcpServer>[0]>["services"]
	>["eventWebhookDelivery"];
	/** Extra env layered into the coordinator server env for webhook opt-in tests. */
	eventWebhookEnv?: Record<string, string>;
	/** Injectable host model resolver for coordinator `model` pin tests. */
	/** Seed live broker sessions with established sidecar authority records. */
	establishedSidecarAuthority?: boolean;
	modelResolver?: NonNullable<
		NonNullable<Parameters<typeof createCoordinatorMcpServer>[0]>["services"]
	>["resolveModelPin"];
};
function lifecycleControls(controls: SdkControl[]): SdkControl[] {
	return controls.filter(control => control.operation !== "session.list");
}

function sharedAskGate(
	gateId: string,
	runtimeTurnId: string,
	stage: WorkflowGate["stage"] = "deep-interview",
	kind: WorkflowGate["kind"] = "question",
): WorkflowGate & { id: string; tag: "pending" } {
	const labels = ["Continue", "Stop"];
	const schema = buildAskGateAnswerSchema({ multi: false, allowEmpty: false }, labels);
	return {
		id: `pending:${gateId}`,
		tag: "pending",
		type: "workflow_gate",
		gate_id: gateId,
		runtime_turn_id: runtimeTurnId,
		stage,
		kind,
		schema,
		schema_hash: schemaHash(schema),
		required: true,
		created_at: "2026-07-17T00:00:00.000Z",
		context: {
			title: "Continue?",
			prompt: "Continue?",
			stage_state: {
				question_id: gateId,
				multi: false,
				allow_empty: false,
				options: labels,
				other_option: GATE_OTHER_OPTION,
				clarification_action: "clarify",
			},
		},
		options: labels.map(label => ({ value: label, label })),
	};
}

type BrokerTestServices = {
	ensureBroker: (settings: EnsureBrokerSettings) => Promise<BrokerDiscovery>;
	readSdkBrokerDiscovery: (agentDir: string) => Promise<BrokerDiscovery | null>;
	connectBroker: (url: string, token: string) => Promise<SdkClient>;
};

function testBrokerDiscovery(): BrokerDiscovery {
	return {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "test-owner",
		pid: process.pid,
		incarnation: brokerProcessIncarnation(process.pid) ?? "test-incarnation",
		host: "127.0.0.1",
		port: 1,
		url: "ws://broker.example.test",
		token: "test-token",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	};
}

function createBrokerTestServer(root: string, services: BrokerTestServices) {
	return createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
		},
		services: { ...services, getAgentDir: () => path.join(root, "agent-global") },
	});
}
function createRealBrokerServer(root: string, agentDir: string) {
	return createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
		},
		services: { getAgentDir: () => agentDir },
	});
}

function ownerLease(agentDir: string) {
	return {
		async close(): Promise<void> {
			await brokerOwnerForTest(agentDir)?.stop();
		},
	};
}

async function createSdkControlServer(
	root: string,
	controls: SdkControl[],
	queries: string[] = [],
	queryResult: (query: string, cursor?: string) => unknown = query =>
		query === "context.get"
			? {
					type: "query_response",
					id: "query-1",
					ok: true,
					page: { items: [{ isStreaming: true }], complete: true, revision: "test" },
				}
			: {
					type: "query_response",
					id: "query-1",
					ok: true,
					page: { items: ["first assistant line\nlatest assistant line"], complete: true, revision: "test" },
				},
	brokerSessions: Array<Record<string, unknown>> = [
		{
			sessionId: "visible-session",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
			endpointGeneration: 1,
			pid: 101,
			endpointMtimeMs: 1,
		},
	],
	sessionCommand?: string,
	_reserved?: never,
	serverOptions: SdkControlServerOptions = {},
): Promise<CoordinatorMcpServer> {
	const stateRoot = path.join(root, ".gjc", "coordinator-state");
	const agentDir = path.join(root, "agent-global");
	let createdSessions = 0;
	for (const session of brokerSessions) {
		if (session.live !== true) continue;
		if (serverOptions.preserveEndpointAuthority) continue;
		const sessionId = String(session.sessionId ?? session.session_id ?? "");
		if (!sessionId) continue;
		const cwd = root;
		const authority = await prepareExactSessionAuthority({
			agentDir,
			cwd,
			sessionId,
			url: "ws://sdk.example.test",
			token: "test-token",
			endpointGeneration: typeof session.endpointGeneration === "number" ? session.endpointGeneration : 1,
		});
		session.pid = authority.pid;
		session.endpointMtimeMs = authority.endpointMtimeMs;
	}
	const seedEstablishedSidecarAuthority = async (): Promise<void> => {
		const sessionsDirectory = path.join(coordinatorNamespace(root), "sessions");
		await fs.mkdir(sessionsDirectory, { recursive: true });
		for (const session of brokerSessions) {
			if (session.live !== true) continue;
			const sessionId = String(session.sessionId ?? session.session_id ?? "");
			if (!sessionId) continue;
			const declaredWorkspace = String((session.locator as Record<string, unknown> | undefined)?.cwd ?? root);
			const brokerWorkspace = (await serverOptions.canonicalizePath?.(declaredWorkspace)) ?? declaredWorkspace;
			const recordFile = Bun.file(path.join(sessionsDirectory, `${sessionId}.json`));
			const existing = (
				(await recordFile.exists())
					? (JSON.parse(await recordFile.text()) as Record<string, unknown>)
					: { session_id: sessionId, cwd: root }
			) as Record<string, unknown>;
			existing.broker_workspace = brokerWorkspace;
			existing.endpoint_generation = session.endpointGeneration ?? 1;
			existing.endpoint_incarnation = createHash("sha256")
				.update(
					// brokerEndpointIncarnation hashes a sorted-key canonical object;
					// keep the fixture digest byte-identical to the broker's.
					`{"endpointGeneration":${JSON.stringify(session.endpointGeneration ?? 1)},"endpointMtimeMs":${
						session.endpointMtimeMs
					},"pid":${session.pid},"sessionId":${JSON.stringify(sessionId)}}`,
				)
				.digest("hex");
			// The verifier is minted through the server so its private key stays in
			// the server's signing map and signed sidecar patches remain verifiable.
			existing.sidecar_verifier ??= server.mintSidecarSigningAuthorityForTest();
			await Bun.write(path.join(sessionsDirectory, `${sessionId}.json`), `${JSON.stringify(existing, null, 2)}\n`);
		}
	};
	const routerIndex = {
		open: async () => {},
		refresh: async () => {},
		refreshIfChanged: async () => true,
		listSessions: () => ({
			indexSeq: 1,
			sessions: brokerSessions.map(session => {
				const sessionId = String(session.sessionId ?? session.session_id ?? "");
				const workspace = root;
				return {
					sessionId,
					locator: { cwd: workspace, worktreeRoot: null, stateRoot: path.join(workspace, ".gjc", "state") },
					live: session.live === true,
					terminalUncertain: session.terminalUncertain === true,
					endpointGeneration: session.endpointGeneration,
					pid: session.pid,
					endpointMtimeMs: session.endpointMtimeMs,
					indexSeq: 1,
				};
			}),
			warnings: [],
		}),
	} as unknown as SessionIndex;
	const server = createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
			GJC_COORDINATOR_MCP_MUTATIONS: serverOptions.mutations ?? "sessions,questions,reports",
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
			...(sessionCommand ? { GJC_COORDINATOR_MCP_SESSION_COMMAND: sessionCommand } : {}),
			...(serverOptions.promptAckTimeoutMs === undefined
				? {}
				: { GJC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS: String(serverOptions.promptAckTimeoutMs) }),
			...(serverOptions.eventWebhookEnv ?? {}),
		},
		platform: serverOptions.platform,
		services: {
			getAgentDir: () => agentDir,
			ensureBroker: serverOptions.ensureBroker ?? (async () => testBrokerDiscovery()),
			resolveModelProfiles: () => new Map([["codex-eco", { name: "codex-eco" }]]),
			...(serverOptions.modelResolver ? { resolveModelPin: serverOptions.modelResolver } : {}),
			canonicalizePath: serverOptions.canonicalizePath,
			codexTransportFactory: serverOptions.codexTransportFactory,
			eventWebhookDelivery: serverOptions.eventWebhookDelivery,
			afterPromptReceiptPersisted: serverOptions.afterPromptReceiptPersisted,
			afterAnswerRemoteStarted: serverOptions.afterAnswerRemoteStarted,
			afterCanonicalTurnCommit: serverOptions.afterCanonicalTurnCommit,
			afterCanonicalReportCommit: serverOptions.afterCanonicalReportCommit,
			afterCanonicalReportSafeResponse: serverOptions.afterCanonicalReportSafeResponse,
			afterDelegateAdmission: serverOptions.afterDelegateAdmission,
			beforeDelegateResponseCommit: serverOptions.beforeDelegateResponseCommit,
			afterDelegateResponseCommit: serverOptions.afterDelegateResponseCommit,
			beforeDelegatePinRecovery: serverOptions.beforeDelegatePinRecovery,
			connectBroker: async () =>
				({
					global: async (
						operation: string,
						input: Record<string, unknown>,
						options: { idempotencyKey?: string } = {},
					) => {
						controls.push({ operation, input, idempotencyKey: options.idempotencyKey });
						const customResult = serverOptions.globalResult?.(operation, input, brokerSessions);
						if (customResult !== undefined) return customResult;
						if (operation === "session.list") return { ok: true, result: { sessions: brokerSessions } };
						if (operation === "session.close") {
							const sessionId = input.sessionId;
							const index = brokerSessions.findIndex(session => session.sessionId === sessionId);
							if (index >= 0) brokerSessions.splice(index, 1);
							return { ok: true, result: { sessionId } };
						}
						if (operation === "session.create") {
							const target = input.target as Record<string, unknown> | undefined;
							const worktree = target?.worktree as Record<string, unknown> | undefined;
							const lifecycleCwd = worktree?.enabled === true ? path.join(root, "hermes-worktree") : undefined;
							const sessionId = `created-session-${++createdSessions}`;
							const sessionCwd = lifecycleCwd ?? root;
							const endpointPath = path.join(sessionCwd, ".gjc", "state", "sdk", `${sessionId}.json`);
							await fs.mkdir(path.dirname(endpointPath), { recursive: true });
							await Bun.write(
								endpointPath,
								JSON.stringify({
									sessionId,
									pid: process.pid,
									url: "ws://sdk.example.test",
									token: "test-token",
								}),
							);
							const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
							brokerSessions.push({
								sessionId,
								locator: {
									cwd: sessionCwd,
									worktreeRoot: null,
									stateRoot: path.join(sessionCwd, ".gjc", "state"),
								},
								live: true,
								endpointGeneration: 1,
								pid: process.pid,
								endpointMtimeMs,
							});
							return {
								ok: true,
								result: {
									sessionId,
									...(typeof input.coordinatorSidecarKeyId === "string"
										? { coordinatorSidecarKeyId: input.coordinatorSidecarKeyId }
										: {}),
									...(lifecycleCwd
										? {
												cwd: lifecycleCwd,
												worktree: { enabled: true, cwd: lifecycleCwd, created: true, reused: false },
											}
										: {}),
									endpoint: {
										url: "ws://broker.example.test/new?token=created-endpoint-secret",
										token: "Bearer created-endpoint-secret",
										credentials: { nested: { token: "nested-created-endpoint-secret" } },
									},
								},
							};
						}
						return { ok: true, result: { sessionId: String(input.sessionId ?? "visible-session") } };
					},
					close: async () => {},
				}) as unknown as SdkClient,
			routerDeps: {
				createIndex: () => routerIndex,
				createClient: async endpoint => {
					const client: SessionRouterClient = {
						onFrame: _handler => () => {},
						request: async (frame, requestOptions) => {
							if (frame.type === "event_replay") {
								return { ok: true, generation: frame.sinceGeneration, lastSeq: frame.sinceSeq, events: [] };
							}
							if (frame.type === "control_request") {
								const control = {
									operation: String(frame.operation),
									input: (frame.input as Record<string, unknown>) ?? {},
									idempotencyKey: typeof frame.idempotencyKey === "string" ? frame.idempotencyKey : undefined,
								};
								controls.push(control);
								serverOptions.controlOptions?.push({ idempotencyKey: control.idempotencyKey });
								return (serverOptions.controlResult?.(control) ?? {
									accepted: true,
									command_id: `sdk-command-${controls.length}`,
									turn_id: `sdk-turn-${controls.length}`,
								}) as Record<string, unknown>;
							}
							if (frame.type === "query_request") {
								const query = String(frame.query);
								queries.push(query);
								serverOptions.queryOptions?.push(requestOptions);
								return queryResult(
									query,
									typeof frame.cursor === "string" ? frame.cursor : undefined,
								) as Record<string, unknown>;
							}
							if (frame.type === "session_activate") {
								serverOptions.sessionFrames?.push(frame);
								return (serverOptions.sessionFrameResult?.(frame) ?? {
									type: "session_activate_result",
									id: "activate-1",
									ok: true,
									status: "activated",
									sessionId: frame.sessionId,
									generation: frame.endpointGeneration,
								}) as Record<string, unknown>;
							}
							return {};
						},
						close: async () => {},
						send: () => {},
					};
					void endpoint;
					return client;
				},
				setInterval: (() => 0) as unknown as typeof setInterval,
				clearInterval: (() => {}) as unknown as typeof clearInterval,
			},
		},
	});
	await fs.mkdir(path.join(root, ".gjc", "state", "sdk"), { recursive: true });
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "test",
		pid: process.pid,
		incarnation: brokerProcessIncarnation(process.pid) ?? "test-incarnation",
		host: "127.0.0.1",
		port: 1,
		url: "ws://sdk.example.test",
		token: "broker-discovery-secret",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});
	if (serverOptions.establishedSidecarAuthority !== false) await seedEstablishedSidecarAuthority();
	return server;
}

async function registerSdkSession(server: CoordinatorMcpServer, root: string) {
	return await server.callTool("gjc_coordinator_register_session", {
		session_id: "visible-session",
		cwd: root,
		tmux_session: "visible-session",
		tmux_target: "visible-session:0.0",
		idempotency_key: "register-1",
		allow_mutation: true,
	});
}

function coordinatorNamespace(root: string): string {
	const config = buildCoordinatorMcpConfig({
		GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
		GJC_COORDINATOR_MCP_PROFILE: "local",
		GJC_COORDINATOR_MCP_REPO: "repo",
	});
	return path.join(config.stateRoot, "v1", config.namespace.identity, "projections");
}

function coordinatorSessionStatePath(root: string, sessionId: string): string {
	return path.join(coordinatorNamespace(root), "session-states", `${sessionId}.json`);
}

async function materializeLegacyProjectionFixture(
	root: string,
	namespaceIdentity: string,
	sessionId: string,
): Promise<string> {
	const projections = coordinatorNamespace(root);
	const legacy = path.join(root, ".gjc", "coordinator-state", "local", "repo");
	for (const directory of ["sessions", "turns", "active-turns", "questions", "reports", "session-states"]) {
		const sourceDirectory = path.join(projections, directory);
		const names = await fs.readdir(sourceDirectory).catch(error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
			throw error;
		});
		for (const name of names) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			const source = path.join(sourceDirectory, name);
			let value: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 10 && !value; attempt += 1) {
				const raw = await fs.readFile(source, "utf8");
				try {
					if (raw.trim().length > 0) value = JSON.parse(raw) as Record<string, unknown>;
				} catch (error) {
					if (!(error instanceof SyntaxError) || attempt === 9) throw error;
				}
				if (!value) await Bun.sleep(5);
			}
			if (!value) throw new Error(`empty_legacy_projection:${source}`);
			if (value.session_id !== sessionId) continue;
			const targetDirectory = path.join(legacy, directory);
			await fs.mkdir(targetDirectory, { recursive: true });
			await fs.writeFile(
				path.join(targetDirectory, name),
				JSON.stringify({ ...value, namespace_identity: namespaceIdentity }),
			);
		}
	}
	return legacy;
}

async function currentEventCursor(root: string): Promise<number> {
	const journal = path.join(coordinatorNamespace(root), "events", "event-journal.jsonl");
	const raw = await fs.readFile(journal, "utf8").catch(() => "");
	const lines = raw.trim().split("\n").filter(Boolean);
	if (lines.length === 0) return 0;
	const last = JSON.parse(lines.at(-1)!) as { seq?: unknown };
	return typeof last.seq === "number" && Number.isSafeInteger(last.seq) ? last.seq : 0;
}

async function patchSessionState(
	server: CoordinatorMcpServer,
	root: string,
	sessionId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	const file = coordinatorSessionStatePath(root, sessionId);
	const prior = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
	const signed = await server.signRuntimeSidecarPayloadForTest(sessionId, { ...prior, ...patch });
	await fs.writeFile(file, JSON.stringify(signed));
}

async function patchTurnDelivery(
	server: CoordinatorMcpServer,
	sessionId: string,
	turnId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
	await withSessionTransaction(paths, sessionId, async transaction => {
		const turn = transaction.canonical.turns[turnId];
		if (!turn) throw new Error(`missing turn ${turnId}`);
		turn.delivery = { ...turn.delivery, ...patch };
	});
}

describe("Coordinator MCP canonical SDK controls", () => {
	it("refuses to register a running session without an established sidecar authority", async () => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, [], [], undefined, undefined, undefined, undefined, {
			establishedSidecarAuthority: false,
		});
		await expect(
			server.callTool("gjc_coordinator_register_session", {
				session_id: "visible-session",
				cwd: root,
				idempotency_key: "unowned-runtime",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "runtime_authority_unavailable" } });
		await expect(
			Bun.file(path.join(coordinatorNamespace(root), "sessions", "visible-session.json")).exists(),
		).resolves.toBe(false);
	});

	it("repairs a torn journal tail but fails closed on malformed complete rows", async () => {
		const root = await tempRoot();
		const namespace = coordinatorNamespace(root);
		const journal = path.join(namespace, "events", "event-journal.jsonl");
		await fs.mkdir(path.dirname(journal), { recursive: true });
		await fs.writeFile(
			journal,
			'{"schema_version":1,"seq":4,"id":"event-000000000004","timestamp":"2026-08-19T00:00:00.000Z","kind":"turn.completed","summary":"complete"}\n{torn',
			"utf8",
		);
		await expect(
			appendCoordinatorEventForTest(namespace, { kind: "turn.completed", summary: "repair after torn tail" }),
		).resolves.toMatchObject({ seq: 5 });
		expect(await fs.readFile(journal, "utf8")).not.toContain("{torn");
		await fs.writeFile(
			journal,
			'{"schema_version":1,"seq":9007199254740992,"id":"unsafe","timestamp":"2026-08-19T00:00:00.000Z","kind":"turn.completed","summary":"unsafe"}\n',
			"utf8",
		);
		await expect(
			appendCoordinatorEventForTest(namespace, { kind: "turn.completed", summary: "must not reuse unsafe seq" }),
		).rejects.toThrow("state_corrupt");
	});

	it("serializes event sequence allocation across coordinator processes", async () => {
		const root = await tempRoot();
		const namespace = coordinatorNamespace(root);
		const marker = path.join(root, "start");
		const modulePath = path.resolve(import.meta.dir, "../src/coordinator-mcp/server.ts");
		const script = (writer: string) => `
import { appendCoordinatorEventForTest } from ${JSON.stringify(modulePath)};
while (!(await Bun.file(${JSON.stringify(marker)}).exists())) await Bun.sleep(1);
console.log(JSON.stringify(await appendCoordinatorEventForTest(${JSON.stringify(namespace)}, {
	kind: "turn.completed",
	summary: ${JSON.stringify(`writer:${writer}`)},
})));
`;
		const first = Bun.spawn({ cmd: [process.execPath, "-e", script("one")], stdout: "pipe", stderr: "pipe" });
		const second = Bun.spawn({ cmd: [process.execPath, "-e", script("two")], stdout: "pipe", stderr: "pipe" });
		await Bun.sleep(10);
		await Bun.write(marker, "");
		const [firstExit, secondExit, firstOutput, secondOutput] = await Promise.all([
			first.exited,
			second.exited,
			new Response(first.stdout).text(),
			new Response(second.stdout).text(),
		]);
		expect([firstExit, secondExit]).toEqual([0, 0]);
		const journal = await fs.readFile(path.join(namespace, "events", "event-journal.jsonl"), "utf8");
		const events = journal
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { seq: number; summary: string });
		expect(events.map(event => event.seq)).toEqual([1, 2]);
		expect([firstOutput, secondOutput].every(output => output.includes('"seq"'))).toBe(true);
	});

	async function pingServer(root: string) {
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: { getAgentDir: () => path.join(root, "agent-global") },
		});
		return server;
	}

	it("answers the MCP ping keepalive with an empty result instead of method-not-found", async () => {
		const root = await tempRoot();
		const server = await pingServer(root);
		const response = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "ping" });
		expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
	});

	it("preserves a string request id in the ping response", async () => {
		const root = await tempRoot();
		const server = await pingServer(root);
		const response = await server.handleJsonRpc({ jsonrpc: "2.0", id: "keepalive-1", method: "ping" });
		expect(response).toEqual({ jsonrpc: "2.0", id: "keepalive-1", result: {} });
	});

	it("answers ping with extra params by ignoring them (params carry no payload)", async () => {
		const root = await tempRoot();
		const server = await pingServer(root);
		const response = await server.handleJsonRpc({
			jsonrpc: "2.0",
			id: 42,
			method: "ping",
			params: { unexpected: "ignored" },
		});
		expect(response).toEqual({ jsonrpc: "2.0", id: 42, result: {} });
	});

	it("does not write any coordinator state files for a ping keepalive", async () => {
		const root = await tempRoot();
		const stateRoot = path.join(root, ".gjc", "coordinator-state");
		const server = await pingServer(root);
		await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "ping" });
		const exists = await fs
			.stat(stateRoot)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(false);
	});
	it("uses agent-global SDK discovery and returns credential-free broker status", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const registered = await registerSdkSession(server, root);
		expect(registered).toMatchObject({ ok: true, registered: true, session_state: { state: "ready_for_input" } });
		await Bun.write(
			path.join(coordinatorNamespace(root), "sessions", "visible-session.json"),
			JSON.stringify({
				session_id: "visible-session",
				cwd: root,
				endpoint: { url: "ws://broker.example.test/endpoint?token=session-record-secret" },
				token: "Bearer session-record-secret",
			}),
		);
		await Bun.write(
			path.join(coordinatorNamespace(root), "session-states", "visible-session.json"),
			JSON.stringify({
				schema_version: 1,
				session_id: "visible-session",
				state: "ready_for_input",
				ready_for_input: true,
				current_turn_id: null,
				last_turn_id: null,
				updated_at: new Date().toISOString(),
				source: "coordinator",
				live: true,
				reason: "Bearer session-state-secret",
			}),
		);
		const status = await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" });
		expect(status).toMatchObject({
			ok: true,
			session: { session_id: "visible-session" },
			status: { authority: "sdk_broker", live: true },
		});
		const publicResult = JSON.stringify(status);
		expect(publicResult).not.toContain("broker-endpoint-secret");
		expect(publicResult).not.toContain("broker-discovery-secret");
		expect(publicResult).not.toContain("session-endpoint-secret");
		expect(publicResult).not.toContain("session-record-secret");
		expect(publicResult).not.toContain("session-state-secret");

		expect(publicResult).not.toContain(root);
		expect(controls).toEqual([
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
		]);
	});
	const ACTIVITY_AT = "2026-03-01T00:00:02.000Z";
	/** Full-length correlation digests; anything shorter is refused as malformed. */
	const DIGEST_A = `a${"0".repeat(63)}`;
	const DIGEST_B = `b${"1".repeat(63)}`;

	function sessionStatePath(root: string): string {
		return path.join(coordinatorNamespace(root), "session-states", "visible-session.json");
	}

	/** A sidecar-shaped snapshot, including the private correlation state readers must never see. */
	function activitySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			seq: 4,
			last_activity_at: ACTIVITY_AT,
			tool: "bash",
			phase: "started",
			outcome: null,
			elapsed_ms: null,
			active_tool_count: 1,
			active_tools: [{ tool: "bash", started_at: ACTIVITY_AT }],
			in_flight: [{ digest: DIGEST_A, tool: "bash", started_at: ACTIVITY_AT }],
			...overrides,
		};
	}

	/** Annotate the coordinator's own session state exactly as the runtime sidecar does. */
	async function annotateSessionState(root: string, activity: unknown, state = "running"): Promise<void> {
		const file = sessionStatePath(root);
		const payload = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
		await Bun.write(
			file,
			JSON.stringify({
				...payload,
				state,
				ready_for_input: false,
				live: state === "running",
				source: "agent_session_event",
				activity,
			}),
		);
	}

	async function readStatusActivity(
		server: CoordinatorMcpServer,
	): Promise<{ status: Record<string, unknown>; activity: Record<string, unknown> | undefined }> {
		const status = await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" });
		const sessionState = status.session_state as Record<string, unknown>;
		return { status, activity: sessionState.activity as Record<string, unknown> | undefined };
	}

	it("projects a public-safe tool activity snapshot into coordinator session state", async () => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		await annotateSessionState(root, activitySnapshot());

		const { status, activity } = await readStatusActivity(server);
		expect(status).toMatchObject({ ok: true, session_state: { state: "running" } });
		expect(activity).toEqual({
			seq: 4,
			last_activity_at: ACTIVITY_AT,
			tool: "bash",
			phase: "started",
			outcome: null,
			elapsed_ms: null,
			active_tool_count: 1,
			active_tools: [{ tool: "bash", started_at: ACTIVITY_AT }],
		});
		const serialized = JSON.stringify(status);
		expect(serialized).not.toContain(DIGEST_A);
		expect(serialized).not.toContain("in_flight");
	});

	it("bounds the public active-tool list while publishing the exact count", async () => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		// Only the public list is capped; the private set is exact current state.
		const inFlight = Array.from({ length: 12 }, (_entry, index) => ({
			digest: `${index.toString(16)}${"c".repeat(63)}`,
			tool: "bash",
			started_at: ACTIVITY_AT,
		}));
		await annotateSessionState(
			root,
			activitySnapshot({
				seq: 12,
				active_tool_count: 12,
				active_tools: inFlight.slice(-8).map(({ digest: _digest, ...entry }) => entry),
				in_flight: inFlight,
			}),
		);

		const { status, activity } = await readStatusActivity(server);
		expect(activity).toMatchObject({ seq: 12, tool: "bash", active_tool_count: 12 });
		const activeTools = activity?.active_tools as Array<Record<string, unknown>>;
		expect(activeTools).toHaveLength(8);
		expect(activeTools.every(entry => Object.keys(entry).sort().join(",") === "started_at,tool")).toBe(true);
		expect(JSON.stringify(status)).not.toContain("in_flight");
	});

	for (const { name, activity } of [
		{ name: "an unparseable phase", activity: { phase: "exfiltrating", note: "LEAKY-NOTE" } },
		{
			name: "an unproven tool label from disk",
			activity: { tool: "bash --command 'echo LEAKY-NOTE'" },
		},
		{
			name: "a truncated correlation digest",
			activity: { in_flight: [{ digest: "abc123", tool: "bash", started_at: ACTIVITY_AT }] },
		},
		{
			name: "a public count contradicting the private set",
			activity: { active_tool_count: 9, note: "LEAKY-NOTE" },
		},
		{
			name: "a duplicated correlation digest",
			activity: {
				active_tool_count: 2,
				active_tools: [
					{ tool: "bash", started_at: ACTIVITY_AT },
					{ tool: "bash", started_at: ACTIVITY_AT },
				],
				in_flight: [
					{ digest: DIGEST_A, tool: "bash", started_at: ACTIVITY_AT },
					{ digest: DIGEST_A, tool: "bash", started_at: ACTIVITY_AT },
				],
			},
		},
	]) {
		it(`omits a snapshot carrying ${name} instead of publishing it`, async () => {
			const root = await tempRoot();
			const server = await createSdkControlServer(root, []);
			await registerSdkSession(server, root);
			await annotateSessionState(root, activitySnapshot(activity));

			const { status, activity: published } = await readStatusActivity(server);
			expect(status.session_state).toMatchObject({ state: "running" });
			expect(published).toBeUndefined();
			expect(JSON.stringify(status)).not.toContain("LEAKY-NOTE");
		});
	}

	it("omits an activity value that is not an object at all", async () => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		await annotateSessionState(root, "LEAKY-NOTE");

		const { status, activity } = await readStatusActivity(server);
		expect(status.session_state).toMatchObject({ state: "running" });
		expect(activity).toBeUndefined();
		expect(JSON.stringify(status)).not.toContain("LEAKY-NOTE");
	});

	it("waits for a state lock held in the shared owner format and keeps the activity snapshot", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		await annotateSessionState(root, activitySnapshot());

		// The runtime sidecar holds this exact lock through the shared implementation;
		// a coordinator lifecycle write must queue behind it, not fault on its format.
		let releasedAt = 0;
		const held = withSessionStateFileLock(sessionStatePath(root), async () => {
			await Bun.sleep(150);
			releasedAt = Date.now();
		});
		await Bun.sleep(25);

		const response = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "state-lock-1",
			allow_mutation: true,
		});
		const wroteAt = Date.now();
		await held;

		expect(response).toMatchObject({ ok: true, session_state: { state: "running" } });
		expect(releasedAt).toBeGreaterThan(0);
		expect(wroteAt).toBeGreaterThanOrEqual(releasedAt);
		expect((await readStatusActivity(server)).activity).toMatchObject({ seq: 4, active_tool_count: 1 });
	});

	it("settles orphaned active tools when canonical terminal repair completes the session", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const prompted = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "repair-prompt-1",
			allow_mutation: true,
		});
		expect(prompted).toMatchObject({ ok: true });
		// Two calls the runtime started and never ended before the report arrived.
		await annotateSessionState(
			root,
			activitySnapshot({
				seq: 7,
				active_tool_count: 2,
				active_tools: [
					{ tool: "bash", started_at: ACTIVITY_AT },
					{ tool: "edit", started_at: ACTIVITY_AT },
				],
				in_flight: [
					{ digest: DIGEST_A, tool: "bash", started_at: ACTIVITY_AT },
					{ digest: DIGEST_B, tool: "edit", started_at: ACTIVITY_AT },
				],
			}),
		);

		// A terminal report rebuilds every legacy projection from canonical state.
		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: prompted.turn_id,
			status: "completed",
			summary: "done",
			idempotency_key: "repair-report-1",
			allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, session_state: { state: "completed" } });

		const persisted = JSON.parse(await Bun.file(sessionStatePath(root)).text()) as Record<string, unknown>;
		expect(persisted.state).toBe("completed");
		// A settled session cannot still be running a tool, and the orphans are named
		// cancelled rather than claimed as a success nothing observed.
		expect(persisted.activity).toMatchObject({
			seq: 8,
			tool: "bash",
			phase: "finished",
			outcome: "cancelled",
			elapsed_ms: null,
			active_tool_count: 0,
			active_tools: [],
			in_flight: [],
		});
		expect((report.session_state as Record<string, unknown>).activity).toMatchObject({
			seq: 8,
			outcome: "cancelled",
			active_tool_count: 0,
			active_tools: [],
		});
	});

	it("preserves the previous activity when a terminal repair has nothing in flight", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const prompted = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "settled-prompt-1",
			allow_mutation: true,
		});
		expect(prompted).toMatchObject({ ok: true });
		const settled = {
			seq: 7,
			last_activity_at: ACTIVITY_AT,
			tool: "bash",
			phase: "finished",
			outcome: "success",
			elapsed_ms: 1200,
			active_tool_count: 0,
			active_tools: [],
			in_flight: [],
		};
		await annotateSessionState(root, settled);

		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: prompted.turn_id,
			status: "completed",
			summary: "done",
			idempotency_key: "settled-report-1",
			allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, session_state: { state: "completed" } });

		const persisted = JSON.parse(await Bun.file(sessionStatePath(root)).text()) as Record<string, unknown>;
		expect(persisted.activity).toEqual(settled);
	});

	it("keeps a malformed activity snapshot hidden across canonical terminal repair", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const prompted = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "malformed-prompt-1",
			allow_mutation: true,
		});
		expect(prompted).toMatchObject({ ok: true });
		await annotateSessionState(root, activitySnapshot({ phase: "exfiltrating", note: "LEAKY-NOTE" }));

		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: prompted.turn_id,
			status: "completed",
			summary: "done",
			idempotency_key: "malformed-report-1",
			allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, session_state: { state: "completed" } });
		// Never re-seeded into a valid-looking snapshot, and never published.
		expect(JSON.stringify(report)).not.toContain("LEAKY-NOTE");
		const persisted = JSON.parse(await Bun.file(sessionStatePath(root)).text()) as Record<string, unknown>;
		expect(persisted.activity).toMatchObject({ phase: "exfiltrating", note: "LEAKY-NOTE" });
		expect((report.session_state as Record<string, unknown>).activity).toBeUndefined();
	});

	it("marks lifecycle-created sessions ready after successful SDK lifecycle binding", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "ready-after-binding",
			allow_mutation: true,
		});

		expect(started).toMatchObject({
			ok: true,
			session: { session_id: "created-session-1" },
			session_state: { state: "ready_for_input", ready_for_input: true },
		});
		expect(controls.map(control => control.operation)).toEqual(["session.create", "session.list"]);
	});

	it("publishes one canonical session.started event for prompt starts and retries", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const args = {
			cwd: root,
			prompt: "start once",
			idempotency_key: "session-start-cardinality",
			allow_mutation: true,
		};
		await server.callTool("gjc_coordinator_start_session", args);
		await server.callTool("gjc_coordinator_start_session", args);
		await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		const journal = (
			await fs.readFile(path.join(coordinatorNamespace(root), "events", "event-journal.jsonl"), "utf8")
		)
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { kind: string });
		expect(journal.filter(event => event.kind === "session.started")).toHaveLength(1);
	});

	it("preserves typed worktree preparation timeouts without unobserved compensation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation =>
				operation === "session.create"
					? {
							ok: false,
							error: {
								code: "worktree_preparation_timeout",
								message: "Worktree preparation exceeded its deadline before the session host was spawned.",
							},
						}
					: undefined,
		});
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "typed-prep-timeout-start",
			allow_mutation: true,
		});
		const delegated = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "typed prep timeout",
			idempotency_key: "typed-prep-timeout-delegate",
			allow_mutation: true,
		});
		expect(started).toMatchObject({ ok: false, error: { code: "worktree_preparation_timeout" } });
		expect(delegated).toMatchObject({ ok: false, error: { code: "worktree_preparation_timeout" } });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(0);
	});

	it("compensates a remote session when local binding fails after creation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => {
				if (operation === "session.create")
					return { ok: true, result: { sessionId: "unbound-session", cwd: root } };
				if (operation === "session.list") return { ok: true, result: { sessions: [] } };
				return undefined;
			},
		});

		const result = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "compensate-unbound-session",
			allow_mutation: true,
		});

		expect(result).toMatchObject({ ok: false });
		expect(controls.filter(control => control.operation === "session.create")).toHaveLength(1);
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({ input: { sessionId: "unbound-session" } }),
		]);
	});

	it("leaves malformed remote creation outcomes retryable", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => (operation === "session.create" ? { ok: true, result: { cwd: root } } : undefined),
		});
		const args = { cwd: root, idempotency_key: "ambiguous-remote-create", allow_mutation: true };

		const first = await server.callTool("gjc_coordinator_start_session", args);
		const second = await server.callTool("gjc_coordinator_start_session", args);

		expect(first).toMatchObject({ ok: false, error: { code: "broker_compensation_unobserved" } });
		expect(second).toEqual(first);
		expect(controls.filter(control => control.operation === "session.create")).toHaveLength(2);
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(0);
	});

	it("retires a stranded start intent only after the indexed retirement proof is supplied", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const retirementStarted = Promise.withResolvers<void>();
		const releaseRetirement = Promise.withResolvers<void>();
		const creationKey = "stranded-start-to-retire";
		const remoteCreateKey = `remote_${createHash("sha256")
			.update(`gjc_coordinator_start_session\0${creationKey}`)
			.digest("hex")}`;
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: async operation => {
				if (operation === "session.create") return { ok: true, result: { cwd: root } };
				if (operation !== "session.reconcile_uncertain") return undefined;
				retirementStarted.resolve();
				await releaseRetirement.promise;
				return {
					ok: true,
					result: {
						sessionId: "retired-session",
						retired: true,
						ledgerState: "terminal_error",
						indexType: "session_closed",
						stateRoot: path.join(root, ".gjc", "state"),
						endpointGeneration: 2,
						endpointMtimeMs: 1,
						processIncarnation: "linux:123",
						hostIncarnation: "host:123",
						lifecycleRequestId: "retire-effect",
						remoteCreateKey,
					},
				};
			},
		});
		const startArgs = { cwd: root, idempotency_key: creationKey, allow_mutation: true };
		await expect(server.callTool("gjc_coordinator_start_session", startArgs)).resolves.toMatchObject({ ok: false });
		const originalPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(creationKey).digest("hex")}.json`,
		);
		const original = JSON.parse(await fs.readFile(originalPath, "utf8")) as { request_digest: string; state: string };
		expect(original.state).toBe("in_progress");

		const retirementArgs = {
			cwd: root,
			session_id: "retired-session",
			state_root: path.join(root, ".gjc", "state"),
			endpoint_generation: 2,
			endpoint_mtime_ms: 1,
			process_incarnation: "linux:123",
			host_incarnation: "host:123",
			lifecycle_request_id: "retire-effect",
			remote_create_key: remoteCreateKey,
			creation_idempotency_key: creationKey,
			request_digest: original.request_digest,
			idempotency_key: "retire-start-intent",
			allow_mutation: true,
		};
		const retirementPromise = server.callTool("gjc_coordinator_retire_start_session", retirementArgs);
		await retirementStarted.promise;
		const concurrentReplayPromise = server.callTool("gjc_coordinator_retire_start_session", retirementArgs);
		await expect(
			server.callTool("gjc_coordinator_retire_start_session", {
				...retirementArgs,
				creation_idempotency_key: `${creationKey}-conflict`,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		await Bun.sleep(2_100);
		releaseRetirement.resolve();
		const [retired, concurrentReplay] = await Promise.all([retirementPromise, concurrentReplayPromise]);
		expect(concurrentReplay).toEqual(retired);
		expect(retired).toMatchObject({ ok: true, session_id: "retired-session", retired: true });
		expect(retired).toMatchObject({
			lifecycle: {
				sessionId: "retired-session",
				retired: true,
				ledgerState: "terminal_error",
				indexType: "session_closed",
			},
		});
		expect(JSON.stringify(retired)).not.toContain("processIncarnation");
		expect(JSON.stringify(retired)).not.toContain("hostIncarnation");
		expect(JSON.stringify(retired)).not.toContain(path.join(root, ".gjc", "state"));
		expect(JSON.parse(await fs.readFile(originalPath, "utf8"))).toMatchObject({
			state: "completed",
			response: { ok: false, error: { code: "retired" } },
		});
		expect(controls.filter(control => control.operation === "session.create")).toHaveLength(1);
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(1);
		await expect(server.callTool("gjc_coordinator_start_session", startArgs)).resolves.toMatchObject({
			ok: false,
			error: { code: "retired" },
		});
		expect(controls.filter(control => control.operation === "session.create")).toHaveLength(1);
		const replay = await server.callTool("gjc_coordinator_retire_start_session", retirementArgs);
		expect(replay).toEqual(retired);
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(1);
		await expect(
			server.callTool("gjc_coordinator_retire_start_session", {
				...retirementArgs,
				idempotency_key: "retire-start-different-key",
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "retire_not_allowed" } });
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(1);
	}, 10_000);

	it("forwards the complete retirement identity and does not seal malformed broker proofs", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const creationKey = "malformed-retirement-proof";
		const remoteCreateKey = `remote_${createHash("sha256")
			.update(`gjc_coordinator_start_session\0${creationKey}`)
			.digest("hex")}`;
		let validAcknowledgement = false;
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: (operation, input) => {
				if (operation === "session.create") return { ok: true, result: { cwd: root } };
				if (operation !== "session.reconcile_uncertain") return undefined;
				if (input.lifecycleRequestId === "stale-effect")
					return { ok: false, error: { code: "retirement_proof_stale", message: "stale proof" } };

				if (!validAcknowledgement) return { ok: true, result: { sessionId: "wrong-session", retired: true } };
				return {
					ok: true,
					result: {
						sessionId: input.sessionId,
						retired: true,
						ledgerState: "terminal_error",
						indexType: "session_closed",
						stateRoot: input.stateRoot,
						endpointGeneration: input.endpointGeneration,
						endpointMtimeMs: input.endpointMtimeMs,
						processIncarnation: input.processIncarnation,
						hostIncarnation: input.hostIncarnation,
						lifecycleRequestId: input.lifecycleRequestId,
						remoteCreateKey: input.remoteCreateKey,
					},
				};
			},
		});
		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: creationKey,
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false });
		const originalPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(creationKey).digest("hex")}.json`,
		);
		const original = JSON.parse(await fs.readFile(originalPath, "utf8")) as { request_digest: string };
		const retirementArgs = {
			cwd: root,
			session_id: "retired-session",
			state_root: path.join(root, ".gjc", "state"),
			endpoint_generation: 2,
			endpoint_mtime_ms: 1,
			process_incarnation: "linux:123",
			host_incarnation: "host:123",
			lifecycle_request_id: "retire-effect",
			remote_create_key: remoteCreateKey,
			creation_idempotency_key: creationKey,
			request_digest: original.request_digest,
			idempotency_key: "malformed-retirement-proof-key",
			allow_mutation: true,
		};
		await expect(
			server.callTool("gjc_coordinator_retire_start_session", {
				...retirementArgs,
				idempotency_key: creationKey,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		const staleResponse = await server.callTool("gjc_coordinator_retire_start_session", {
			...retirementArgs,
			lifecycle_request_id: "stale-effect",
		});
		expect(staleResponse).toMatchObject({ ok: false, error: { code: "retirement_proof_stale" } });
		const malformed = await server.callTool("gjc_coordinator_retire_start_session", retirementArgs);
		expect(malformed).toMatchObject({ ok: false, error: { code: "protocol_error" } });
		expect(controls.at(-1)).toMatchObject({
			operation: "session.reconcile_uncertain",
			input: {
				sessionId: "retired-session",
				cwd: root,
				stateRoot: path.join(root, ".gjc", "state"),
				endpointGeneration: 2,
				endpointMtimeMs: 1,
				processIncarnation: "linux:123",
				hostIncarnation: "host:123",
				lifecycleRequestId: "retire-effect",
				remoteCreateKey,
			},
		});
		validAcknowledgement = true;
		const retried = await server.callTool("gjc_coordinator_retire_start_session", retirementArgs);
		expect(retried).toMatchObject({ ok: true, session_id: "retired-session", retired: true });
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(3);
	});

	it("rejects missing or wrong retirement proof before broker mutation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const creationKey = "retirement-proof-validation";
		const remoteCreateKey = `remote_${createHash("sha256")
			.update(`gjc_coordinator_start_session\0${creationKey}`)
			.digest("hex")}`;
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => (operation === "session.create" ? { ok: true, result: { cwd: root } } : undefined),
		});
		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: creationKey,
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false });
		const originalPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(creationKey).digest("hex")}.json`,
		);
		const original = JSON.parse(await fs.readFile(originalPath, "utf8")) as { request_digest: string };
		const base = {
			cwd: root,
			session_id: "retired-session",
			state_root: path.join(root, ".gjc", "state"),
			endpoint_generation: 2,
			endpoint_mtime_ms: 1,
			process_incarnation: "linux:123",
			host_incarnation: "host:123",
			lifecycle_request_id: "retire-effect",
			remote_create_key: remoteCreateKey,
			creation_idempotency_key: creationKey,
			request_digest: original.request_digest,
			allow_mutation: true,
		};
		await expect(
			server.callTool("gjc_coordinator_retire_start_session", {
				...base,
				lifecycle_request_id: "bad/id",
				idempotency_key: "invalid-marker-key",
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		await expect(
			server.callTool("gjc_coordinator_retire_start_session", {
				...base,
				idempotency_key: "missing-proof-key",
				remote_create_key: undefined,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		await expect(
			server.callTool("gjc_coordinator_retire_start_session", {
				...base,
				idempotency_key: "malformed-marker-key",
				lifecycle_request_id: "retire/effect",
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		await expect(
			server.callTool("gjc_coordinator_retire_start_session", {
				...base,
				idempotency_key: "wrong-proof-key",
				remote_create_key: "remote_wrong",
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(0);
	});

	it("serializes different retirement keys on the original creation lock", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const creationKey = "retirement-key-race";
		const remoteCreateKey = `remote_${createHash("sha256")
			.update(`gjc_coordinator_start_session\0${creationKey}`)
			.digest("hex")}`;
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: (operation, input) => {
				if (operation === "session.create") return { ok: true, result: { cwd: root } };
				if (operation !== "session.reconcile_uncertain") return undefined;
				return {
					ok: true,
					result: {
						sessionId: input.sessionId,
						retired: true,
						ledgerState: "terminal_error",
						indexType: "session_closed",
						stateRoot: input.stateRoot,
						endpointGeneration: input.endpointGeneration,
						endpointMtimeMs: input.endpointMtimeMs,
						processIncarnation: input.processIncarnation,
						hostIncarnation: input.hostIncarnation,
						lifecycleRequestId: input.lifecycleRequestId,
						remoteCreateKey: input.remoteCreateKey,
					},
				};
			},
		});
		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: creationKey,
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false });
		const originalPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(creationKey).digest("hex")}.json`,
		);
		const original = JSON.parse(await fs.readFile(originalPath, "utf8")) as { request_digest: string };
		const base = {
			cwd: root,
			session_id: "retired-session",
			state_root: path.join(root, ".gjc", "state"),
			endpoint_generation: 2,
			endpoint_mtime_ms: 1,
			process_incarnation: "linux:123",
			host_incarnation: "host:123",
			lifecycle_request_id: "retire-effect",
			remote_create_key: remoteCreateKey,
			creation_idempotency_key: creationKey,
			request_digest: original.request_digest,
			allow_mutation: true,
		};
		const results = await Promise.all([
			server.callTool("gjc_coordinator_retire_start_session", { ...base, idempotency_key: "race-one" }),
			server.callTool("gjc_coordinator_retire_start_session", { ...base, idempotency_key: "race-two" }),
		]);
		expect(results.filter(result => result.ok === true)).toHaveLength(1);
		expect(
			results.filter(
				result =>
					typeof result.error === "object" &&
					result.error !== null &&
					(result.error as Record<string, unknown>).code === "retire_not_allowed",
			),
		).toHaveLength(1);
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(1);
	});

	it("replays a staged broker proof after coordinator persistence is interrupted", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const creationKey = "retirement-persistence-retry";
		const retirementKey = "retirement-persistence-retry-effect";
		const remoteCreateKey = `remote_${createHash("sha256")
			.update(`gjc_coordinator_start_session\0${creationKey}`)
			.digest("hex")}`;
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: (operation, input) => {
				if (operation === "session.create") return { ok: true, result: { cwd: root } };
				if (operation !== "session.reconcile_uncertain") return undefined;
				return {
					ok: true,
					result: {
						sessionId: input.sessionId,
						retired: true,
						ledgerState: "terminal_error",
						indexType: "session_closed",
						stateRoot: input.stateRoot,
						endpointGeneration: input.endpointGeneration,
						endpointMtimeMs: input.endpointMtimeMs,
						processIncarnation: input.processIncarnation,
						hostIncarnation: input.hostIncarnation,
						lifecycleRequestId: input.lifecycleRequestId,
						remoteCreateKey: input.remoteCreateKey,
					},
				};
			},
		});
		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: creationKey,
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false });
		const originalPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(creationKey).digest("hex")}.json`,
		);
		const original = JSON.parse(await fs.readFile(originalPath, "utf8")) as { request_digest: string };
		const retirementArgs = {
			cwd: root,
			session_id: "retired-session",
			state_root: path.join(root, ".gjc", "state"),
			endpoint_generation: 2,
			endpoint_mtime_ms: 1,
			process_incarnation: "linux:123",
			host_incarnation: "host:123",
			lifecycle_request_id: "retire-effect",
			remote_create_key: remoteCreateKey,
			creation_idempotency_key: creationKey,
			request_digest: original.request_digest,
			idempotency_key: retirementKey,
			allow_mutation: true,
		};
		const first = await server.callTool("gjc_coordinator_retire_start_session", retirementArgs);
		expect(first).toMatchObject({ ok: true, retired: true });
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(1);
		const interruptedOriginal = JSON.parse(await fs.readFile(originalPath, "utf8")) as Record<string, unknown>;
		const retirementPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(retirementKey).digest("hex")}.json`,
		);
		const interruptedRetirementOnly = JSON.parse(await fs.readFile(retirementPath, "utf8")) as Record<
			string,
			unknown
		>;
		interruptedRetirementOnly.state = "in_progress";
		delete interruptedRetirementOnly.response;
		delete interruptedRetirementOnly.completed_at;
		await fs.writeFile(retirementPath, `${JSON.stringify(interruptedRetirementOnly)}\n`);
		const registryPath = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity).registry;
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
			creations: Record<string, { retirement_intent?: { retirement_key_digest?: string } }>;
		};
		const creationDigest = createHash("sha256").update(`gjc_coordinator_start_session\0${creationKey}`).digest("hex");
		const retirementIntent = registry.creations[creationDigest]?.retirement_intent;
		const originalRetirementDigest = retirementIntent?.retirement_key_digest;
		expect(originalRetirementDigest).toBeDefined();
		if (!retirementIntent || typeof originalRetirementDigest !== "string")
			throw new Error("missing durable retirement intent");
		retirementIntent.retirement_key_digest = "0".repeat(64);
		await fs.writeFile(registryPath, `${JSON.stringify(registry)}\n`);
		await expect(server.callTool("gjc_coordinator_retire_start_session", retirementArgs)).resolves.toMatchObject({
			ok: false,
			error: { code: "retire_not_allowed" },
		});
		retirementIntent.retirement_key_digest = originalRetirementDigest;
		await fs.writeFile(registryPath, `${JSON.stringify(registry)}\n`);
		interruptedRetirementOnly.state = "in_progress";
		delete interruptedRetirementOnly.response;
		delete interruptedRetirementOnly.completed_at;
		await fs.writeFile(retirementPath, `${JSON.stringify(interruptedRetirementOnly)}\n`);
		const replayAfterRetirementSealCrash = await server.callTool(
			"gjc_coordinator_retire_start_session",
			retirementArgs,
		);
		expect(replayAfterRetirementSealCrash).toEqual(first);
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(1);

		interruptedOriginal.state = "in_progress";
		delete interruptedOriginal.response;
		delete interruptedOriginal.completed_at;
		await fs.writeFile(originalPath, `${JSON.stringify(interruptedOriginal)}\n`);
		const interruptedRetirement = JSON.parse(await fs.readFile(retirementPath, "utf8")) as Record<string, unknown>;
		interruptedRetirement.state = "in_progress";
		delete interruptedRetirement.response;
		delete interruptedRetirement.completed_at;
		await fs.writeFile(retirementPath, `${JSON.stringify(interruptedRetirement)}\n`);
		const retried = await server.callTool("gjc_coordinator_retire_start_session", retirementArgs);
		expect(retried).toEqual(first);
		expect(controls.filter(control => control.operation === "session.reconcile_uncertain")).toHaveLength(1);
	});

	it("keeps compensation unobserved when broker close is rejected", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => {
				if (operation === "session.create")
					return { ok: true, result: { sessionId: "close-rejected-session", cwd: root } };
				if (operation === "session.list") return { ok: true, result: { sessions: [] } };
				if (operation === "session.close")
					return { ok: false, error: { code: "close_refused", message: "close refused" } };
				return undefined;
			},
		});

		const result = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "close-rejected-compensation",
			allow_mutation: true,
		});

		expect(result).toMatchObject({ ok: false, error: { code: "broker_compensation_unobserved" } });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(1);
	});

	it("does not seal a prepared-session failure when compensation is rejected", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => {
				if (operation === "session.create")
					return { ok: true, result: { sessionId: "unprepared-session", readiness: "ready", cwd: root } };
				if (operation === "session.close")
					return { ok: false, error: { code: "close_refused", message: "close refused" } };
				return undefined;
			},
		});

		const result = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			prepare_existing_thread: true,
			idempotency_key: "prepared-close-rejected",
			allow_mutation: true,
		});

		expect(result).toMatchObject({ ok: false, error: { code: "broker_compensation_unobserved" } });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(2);
	});

	it("does not admit a closed session after successful prepared-session compensation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => {
				if (operation === "session.create")
					return { ok: true, result: { sessionId: "closed-unprepared-session", readiness: "ready", cwd: root } };
				if (operation === "session.close") return { ok: true, result: { sessionId: "closed-unprepared-session" } };
				return undefined;
			},
		});

		const result = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			prepare_existing_thread: true,
			idempotency_key: "prepared-close-success",
			allow_mutation: true,
		});

		expect(result).toMatchObject({ ok: false, error: { code: "broker_request_unavailable" } });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(1);
		expect(controls.filter(control => control.operation === "session.list")).toHaveLength(0);
	});

	it("treats a malformed compensation close response as unobserved", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => {
				if (operation === "session.create")
					return { ok: true, result: { sessionId: "malformed-close-session", cwd: root } };
				if (operation === "session.list") return { ok: true, result: { sessions: [] } };
				if (operation === "session.close") return { ok: true, result: {} };
				return undefined;
			},
		});

		const result = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "malformed-close-compensation",
			allow_mutation: true,
		});

		expect(result).toMatchObject({ ok: false, error: { code: "broker_compensation_unobserved" } });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(1);
	});

	it("compensates a broker session before rejecting an unsafe coordinator identity", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => {
				if (operation === "session.create") return { ok: true, result: { sessionId: "../unsafe", cwd: root } };
				if (operation === "session.list") return { ok: true, result: { sessions: [] } };
				return undefined;
			},
		});

		const result = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "unsafe-identity-compensation",
			allow_mutation: true,
		});

		expect(result).toMatchObject({ ok: false });
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({ input: { sessionId: "../unsafe" } }),
		]);
	});

	it("classifies a prepared-session response without identity as unobserved", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation =>
				operation === "session.create" ? { ok: true, result: { readiness: "ready", cwd: root } } : undefined,
		});

		const result = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			prepare_existing_thread: true,
			idempotency_key: "prepared-missing-identity",
			allow_mutation: true,
		});

		expect(result).toMatchObject({ ok: false, error: { code: "broker_compensation_unobserved" } });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(0);
	});

	it("preserves multiline delegated task text in one SDK turn.prompt control", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const task = "first line\n\n  exact indentation\nlast line";

		const delegated = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			session_id: "visible-session",
			task,
			idempotency_key: "multiline-delegation",
			allow_mutation: true,
		});

		expect(delegated).toMatchObject({ ok: true, workflow: "execute" });
		const promptControls = controls.filter(control => control.operation === "turn.prompt");
		expect(promptControls).toHaveLength(1);
		expect(promptControls[0]).toEqual(
			expect.objectContaining({
				input: { text: expect.stringContaining(`Task:\n${task}\n\nReturn durable status`) },
			}),
		);
	});

	it("normalizes camelCase runtime acknowledgement identities into durable and public turns", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			controlResult: () => ({
				type: "control_response",
				id: "runtime-ack-1",
				ok: true,
				result: { accepted: true, commandId: "runtime-command-1", turnId: "runtime-turn-1" },
			}),
		});
		await registerSdkSession(server, root);

		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "acknowledged work",
			idempotency_key: "camel-ack",
			allow_mutation: true,
		});

		expect(sent).toMatchObject({
			ok: true,
			result: { accepted: true, command_id: "runtime-command-1", turn_id: "runtime-turn-1" },
			turn: {
				delivery: { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1" },
			},
		});
		const turnId = sent.turn_id;
		if (typeof turnId !== "string") throw new Error("missing durable coordinator turn id");
		const persisted = JSON.parse(
			await fs.readFile(path.join(coordinatorNamespace(root), "turns", `${turnId}.json`), "utf8"),
		) as { delivery: Record<string, unknown> };
		expect(persisted.delivery).toMatchObject({
			runtime_command_id: "runtime-command-1",
			runtime_turn_id: "runtime-turn-1",
		});
	});

	it("accepts drive-letter and separator differences through the injected Windows platform seam", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const canonicalWorkspace = "C:\\Workspaces\\Coordinator\\Repo";
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			undefined,
			[
				{
					sessionId: "visible-session",
					locator: {
						cwd: "c:/workspaces/coordinator/repo",
						worktreeRoot: null,
						stateRoot: "c:/workspaces/coordinator/repo/.gjc/state",
					},
					live: true,
					endpointGeneration: 1,
					pid: 101,
					endpointMtimeMs: 1,
				},
			],
			undefined,
			undefined,
			{
				platform: "win32",
				canonicalizePath: async value => path.win32.normalize(value === root ? canonicalWorkspace : value),
			},
		);
		const registered = await registerSdkSession(server, root);
		expect(registered).toMatchObject({ ok: true, session: { cwd: canonicalWorkspace } });
		expect(await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" })).toMatchObject({
			ok: true,
			status: { live: true },
		});
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "case-safe workspace",
				idempotency_key: "windows-case-safe",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true });
	});

	it("fails closed before turn persistence for malformed acknowledgement envelopes and conflicting aliases", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const acknowledgements: Record<string, unknown> = {
			"missing-acceptance": { commandId: "runtime-command-1", turnId: "runtime-turn-1" },
			"malformed-identity": { accepted: true, commandId: "invalid/runtime-command", turnId: "runtime-turn-2" },
			"envelope-without-ok": {
				result: { accepted: true, commandId: "runtime-command-1", turnId: "runtime-turn-1" },
			},
			"envelope-without-result": {
				ok: true,
				accepted: true,
				commandId: "runtime-command-1",
				turnId: "runtime-turn-1",
			},
			"envelope-with-error": {
				ok: true,
				result: { accepted: true, commandId: "runtime-command-1", turnId: "runtime-turn-1" },
				error: { code: "unavailable" },
			},
			"envelope-error-only": { error: { code: "unavailable" } },
			"conflicting-command-aliases": {
				ok: true,
				result: {
					accepted: true,
					commandId: "runtime-command-1",
					command_id: "runtime-command-2",
					turnId: "runtime-turn-1",
				},
			},
			"conflicting-turn-aliases": {
				accepted: true,
				commandId: "runtime-command-1",
				turnId: "runtime-turn-1",
				turn_id: "runtime-turn-2",
			},
			"follow-up-without-turn": { accepted: true, commandId: "runtime-command-1" },
		};
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			controlResult: control => acknowledgements[control.idempotencyKey ?? ""],
		});
		await registerSdkSession(server, root);

		for (const [idempotencyKey, queue] of [
			["missing-acceptance", false],
			["malformed-identity", false],
			["envelope-without-ok", false],
			["envelope-without-result", false],
			["envelope-with-error", false],
			["envelope-error-only", false],
			["conflicting-command-aliases", false],
			["conflicting-turn-aliases", false],
			["follow-up-without-turn", true],
		] as const) {
			expect(
				await server.callTool("gjc_coordinator_send_prompt", {
					session_id: "visible-session",
					prompt: "must not be recorded",
					idempotency_key: idempotencyKey,
					...(queue ? { queue: true } : {}),
					allow_mutation: true,
				}),
			).toMatchObject({ ok: false, error: { code: "unavailable" } });
		}
		expect(controls.filter(control => control.operation === "turn.prompt")).toHaveLength(8);
		expect(controls.filter(control => control.operation === "turn.follow_up")).toHaveLength(1);
		await expect(fs.readdir(path.join(coordinatorNamespace(root), "turns"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" }),
		).resolves.toMatchObject({
			ok: true,
			status: { state: "ready_for_input", ready_for_input: true, current_turn_id: null },
		});
		const repairedSidecar = JSON.parse(
			await fs.readFile(coordinatorSessionStatePath(root, "visible-session"), "utf8"),
		) as Record<string, unknown>;
		expect(repairedSidecar.current_turn_id).toBeNull();
		expect(repairedSidecar.state).toBe("ready_for_input");
	});

	it("restores the prior active turn correlation after a decided abort-and-prompt failure", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			controlResult: control =>
				control.operation === "turn.abort_and_prompt"
					? { accepted: true, commandId: "failed-force-command" }
					: { accepted: true, command_id: "initial-command", turn_id: "initial-runtime-turn" },
		});
		await registerSdkSession(server, root);
		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "keep this turn active",
			idempotency_key: "rollback-initial",
			allow_mutation: true,
		});
		expect(first).toMatchObject({ ok: true, status: "active" });
		const failed = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "this replacement must not be recorded",
			force: true,
			idempotency_key: "rollback-force",
			allow_mutation: true,
		});
		expect(failed).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" })).toMatchObject({
			ok: true,
			session_state: { state: "running", ready_for_input: false, current_turn_id: first.turn_id },
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			canonical: {
				queue: { active_turn_id: string | null };
				turns: Record<string, { status?: string }>;
			};
		};
		const firstTurnId = first.turn_id;
		expect(typeof firstTurnId).toBe("string");
		if (typeof firstTurnId !== "string") throw new Error("missing_first_turn_id");
		expect(transaction.canonical.queue.active_turn_id).toBe(firstTurnId);
		expect(transaction.canonical.turns[firstTurnId]?.status).toBe("active");
		expect(Object.keys(transaction.canonical.turns)).toEqual([firstTurnId]);
	});

	it("surfaces Router request timeout errors without persisting a turn", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const controlOptions: Array<{ idempotencyKey?: string; timeoutMs?: number }> = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			promptAckTimeoutMs: 17,
			controlOptions,
			controlResult: () => {
				throw new SdkClientError("timeout", "SDK request timed out after 17ms");
			},
		});
		await registerSdkSession(server, root);

		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "bounded timeout",
				idempotency_key: "bounded-timeout",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "timeout" } });
		expect(controls.filter(control => control.operation === "turn.prompt")).toEqual([
			{ operation: "turn.prompt", input: { text: "bounded timeout" }, idempotencyKey: "bounded-timeout" },
		]);
		expect(controlOptions).toContainEqual({ idempotencyKey: "bounded-timeout" });
		await expect(fs.readdir(path.join(coordinatorNamespace(root), "turns"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	it("keeps post-send Router ambiguity retryable under the same prompt idempotency key", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let attempts = 0;
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			controlResult: control => {
				if (control.operation === "turn.prompt" && attempts++ === 0)
					throw new SessionRouterError("ambiguous", "response crossed attachment rotation");
				return { accepted: true, command_id: "reconciled-command", turn_id: "reconciled-turn" };
			},
		});
		await registerSdkSession(server, root);
		const args = {
			session_id: "visible-session",
			prompt: "reconcile this prompt",
			idempotency_key: "ambiguous-prompt",
			allow_mutation: true,
		};
		const ambiguous = await server.callTool("gjc_coordinator_send_prompt", args);
		expect(ambiguous).toMatchObject({ ok: false, error: { code: "ambiguous" } });
		const reconciled = await server.callTool("gjc_coordinator_send_prompt", args);
		expect(reconciled).toMatchObject({ ok: true, result: { accepted: true } });
		expect(await server.callTool("gjc_coordinator_send_prompt", args)).toEqual(reconciled);
		expect(controls.filter(control => control.operation === "turn.prompt")).toHaveLength(2);
	});
	it("keeps prompt acknowledgement timing under Router ownership", async () => {
		for (const [configuredTimeoutMs, expectedTimeoutMs] of [
			[undefined, 10_000],
			[300_001, 300_000],
		] as const) {
			const root = await tempRoot();
			const controls: SdkControl[] = [];
			const controlOptions: Array<{ idempotencyKey?: string; timeoutMs?: number }> = [];
			const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
				promptAckTimeoutMs: configuredTimeoutMs,
				controlOptions,
			});
			await registerSdkSession(server, root);
			expect(
				await server.callTool("gjc_coordinator_send_prompt", {
					session_id: "visible-session",
					prompt: "bounded prompt acknowledgement",
					idempotency_key: `prompt-timeout-${expectedTimeoutMs}`,
					allow_mutation: true,
				}),
			).toMatchObject({ ok: true });
			expect(controlOptions).toEqual([{ idempotencyKey: `prompt-timeout-${expectedTimeoutMs}` }]);
		}
	});

	it("derives aggregate liveness from scoped broker records", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [
			{
				sessionId: "live-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
			},
			{
				sessionId: "stale-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: false,
				endpoint: { url: "ws://broker.example.test/endpoint?token=stale-secret", token: "Bearer stale-secret" },
			},
			{
				sessionId: "other-workdir",
				locator: {
					cwd: path.join(root, "other"),
					worktreeRoot: null,
					stateRoot: path.join(root, "other", ".gjc", "state"),
				},
				live: true,
			},
		]);
		const status = await server.callTool("gjc_coordinator_read_status");
		expect(status).toEqual({
			ok: true,
			sessions: [
				{ session_id: "live-session", live: true },
				{ session_id: "stale-session", live: false },
			],
			statuses: [
				{
					session: { session_id: "live-session", live: true },
					status: { authority: "sdk_broker", live: true },
				},
				{
					session: { session_id: "stale-session", live: false },
					status: { authority: "sdk_broker", live: false },
				},
			],
		});
		expect(JSON.stringify(status)).not.toContain("stale-secret");
		expect(controls).toEqual([{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined }]);
	});
	it("drains coordinator session.list continuation pages before returning status", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const pageOne = {
			sessionId: "page-one",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
		};
		const pageTwo = {
			sessionId: "page-two",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: false,
		};
		const server = await createSdkControlServer(root, controls, [], undefined, [pageOne], undefined, undefined, {
			globalResult: (operation, input) => {
				if (operation !== "session.list") return undefined;
				return input.cursor === undefined
					? { ok: true, result: { sessions: [pageOne], continuationCursor: "page-2" } }
					: { ok: true, result: { sessions: [pageTwo] } };
			},
		});

		const status = await server.callTool("gjc_coordinator_read_status");
		expect(status).toMatchObject({
			ok: true,
			sessions: [
				{ session_id: "page-one", live: true },
				{ session_id: "page-two", live: false },
			],
		});
		expect(controls).toEqual([
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
			{ operation: "session.list", input: { cwd: root, cursor: "page-2" }, idempotencyKey: undefined },
		]);
	});

	it("returns coordinator session.list continuation failures without partial status", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const pageOne = {
			sessionId: "page-one",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
		};
		const server = await createSdkControlServer(root, controls, [], undefined, [pageOne], undefined, undefined, {
			globalResult: (operation, input) => {
				if (operation !== "session.list") return undefined;
				return input.cursor === undefined
					? { ok: true, result: { sessions: [pageOne], continuationCursor: "page-2" } }
					: { ok: false, error: { code: "continuation_failed", message: "page two failed" } };
			},
		});

		await expect(server.callTool("gjc_coordinator_read_status")).resolves.toMatchObject({
			ok: false,
			error: { code: "unavailable", message: "Coordinator service is unavailable." },
		});
		expect(controls).toEqual([
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
			{ operation: "session.list", input: { cwd: root, cursor: "page-2" }, idempotencyKey: undefined },
		]);
	});
	it("rejects repeated coordinator session.list cursors without partial status", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const page = {
			sessionId: "page",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
		};
		const server = await createSdkControlServer(root, controls, [], undefined, [page], undefined, undefined, {
			globalResult: operation =>
				operation === "session.list"
					? { ok: true, result: { sessions: [page], continuationCursor: "repeat" } }
					: undefined,
		});

		const status = await server.callTool("gjc_coordinator_read_status");

		expect(status).toMatchObject({
			ok: false,
			error: { code: "protocol_error", message: "Coordinator protocol response is invalid." },
		});
		expect(status).not.toHaveProperty("sessions");
		expect(controls).toEqual([
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
			{ operation: "session.list", input: { cwd: root, cursor: "repeat" }, idempotencyKey: undefined },
		]);
	});
	it("rejects malformed coordinator session.list continuation pages without partial status", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const page = {
			sessionId: "page",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
		};
		const server = await createSdkControlServer(root, controls, [], undefined, [page], undefined, undefined, {
			globalResult: (operation, input) => {
				if (operation !== "session.list") return undefined;
				return input.cursor === undefined
					? { ok: true, result: { sessions: [page], continuationCursor: "page-2" } }
					: { ok: true, result: { sessions: "not-an-array" } };
			},
		});

		const status = await server.callTool("gjc_coordinator_read_status");

		expect(status).toMatchObject({
			ok: false,
			error: { code: "protocol_error", message: "Coordinator protocol response is invalid." },
		});
		expect(status).not.toHaveProperty("sessions");
		expect(controls).toEqual([
			{ operation: "session.list", input: { cwd: root }, idempotencyKey: undefined },
			{ operation: "session.list", input: { cwd: root, cursor: "page-2" }, idempotencyKey: undefined },
		]);
	});
	it("reads bounded tail output through the SDK", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);

		await expect(
			server.callTool("gjc_coordinator_read_tail", { session_id: "visible-session", lines: 1 }),
		).resolves.toEqual({ ok: true, source: "sdk", lines: ["latest assistant line"] });
		expect(queries).toEqual(["session.last_assistant"]);
	});
	it("returns SDK query failures without a terminal fallback", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries, () => ({
			type: "query_response",
			id: "query-1",
			ok: false,
			error: { code: "unavailable", message: "session endpoint unavailable" },
		}));
		await registerSdkSession(server, root);

		await expect(
			server.callTool("gjc_coordinator_read_tail", { session_id: "visible-session" }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "unavailable" },
		});
		expect(queries).toEqual(["session.last_assistant"]);
	});
	it("reads active-turn status through SDK context", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});

		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: sent.turn_id })).resolves.toMatchObject({
			ok: true,
			advisory_status: { authority: "sdk", live: true, is_streaming: true },
		});
		expect(queries).toEqual(["Q12", "context.get"]);
	});
	it("uses the generation-bound broker endpoint when a stale local endpoint file is absent", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});
		await fs.rm(path.join(root, ".gjc", "state", "sdk", "visible-session.json"));

		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: sent.turn_id })).resolves.toMatchObject({
			ok: true,
			advisory_status: { authority: "sdk", live: null, reason: "endpoint_stale" },
		});
		expect(queries).toEqual([]);
	});

	it("passes a resolved mpreset into the SDK lifecycle create request and persists it with the session", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			mpreset: "codex-eco",
			idempotency_key: "preset-start",
			allow_mutation: true,
		});
		expect(started).toMatchObject({ ok: true, session: { session_id: "created-session-1", mpreset: "codex-eco" } });
		expect(lifecycleControls(controls)).toEqual([
			{
				operation: "session.create",
				input: {
					cwd: root,
					target: { path: root },
					modelPreset: "codex-eco",
					coordinatorStateDir: coordinatorNamespace(root),
					coordinatorSidecarSigningKey: expect.any(String),
					coordinatorSidecarKeyId: expect.stringMatching(/^[0-9a-f]{64}$/),
				},
				idempotencyKey: expect.stringMatching(/^remote_[a-f0-9]{64}$/),
			},
		]);
		const durableSession = JSON.parse(
			await fs.readFile(path.join(coordinatorNamespace(root), "sessions", "created-session-1.json"), "utf8"),
		) as Record<string, unknown>;
		const lifecycleKeyId = (lifecycleControls(controls)[0]!.input as Record<string, unknown>).coordinatorSidecarKeyId;
		expect(lifecycleKeyId).toBe((durableSession.sidecar_verifier as { key_id: string }).key_id);
		expect(lifecycleKeyId).toMatch(/^[0-9a-f]{64}$/);
		expect(durableSession.mpreset).toBe("codex-eco");
	});
	const pinnedModel = (provider: string, id: string): Model =>
		({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;
	const pinnedModelResolver = (models: Model[]) => {
		const registry = (() => ({ getAll: () => models })) as unknown as SdkHostModelRegistryLoader;
		return (raw: unknown) => resolveSdkHostModel(raw, registry);
	};

	it("passes a resolved explicit model pin into the SDK lifecycle create request and persists it with the session", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			modelResolver: pinnedModelResolver([
				pinnedModel("cursor", "claude-fable-5-xhigh"),
				pinnedModel("cursor", "composer-2.5"),
			]),
		});
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			model: "cursor/claude-fable-5-xhigh",
			idempotency_key: "model-start",
			allow_mutation: true,
		});
		expect(started).toMatchObject({
			ok: true,
			session: { session_id: "created-session-1", model: "cursor/claude-fable-5-xhigh" },
		});
		expect(lifecycleControls(controls)).toEqual([
			{
				operation: "session.create",
				input: {
					cwd: root,
					target: { path: root },
					modelId: "cursor/claude-fable-5-xhigh",
					coordinatorStateDir: coordinatorNamespace(root),
					coordinatorSidecarSigningKey: expect.any(String),
					coordinatorSidecarKeyId: expect.stringMatching(/^[0-9a-f]{64}$/),
				},
				idempotencyKey: expect.stringMatching(/^remote_[a-f0-9]{64}$/),
			},
		]);
		await expect(
			fs.readFile(path.join(coordinatorNamespace(root), "sessions", "created-session-1.json"), "utf8"),
		).resolves.toContain('"model": "cursor/claude-fable-5-xhigh"');
	});

	it("keeps both mpreset and an explicit model pin, with the model winning in the child", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			modelResolver: pinnedModelResolver([pinnedModel("cursor", "default")]),
		});
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			mpreset: "codex-eco",
			model: "cursor/default",
			idempotency_key: "preset-and-model",
			allow_mutation: true,
		});
		expect(started).toMatchObject({ ok: true, session: { mpreset: "codex-eco", model: "cursor/default" } });
		expect(lifecycleControls(controls)).toEqual([
			{
				operation: "session.create",
				input: {
					cwd: root,
					target: { path: root },
					modelPreset: "codex-eco",
					modelId: "cursor/default",
					coordinatorStateDir: coordinatorNamespace(root),
					coordinatorSidecarSigningKey: expect.any(String),
					coordinatorSidecarKeyId: expect.stringMatching(/^[0-9a-f]{64}$/),
				},
				idempotencyKey: expect.stringMatching(/^remote_[a-f0-9]{64}$/),
			},
		]);
	});

	it("rejects an unknown model pin before any session creation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			modelResolver: pinnedModelResolver([pinnedModel("cursor", "claude-fable-5-xhigh")]),
		});
		const rejected = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			model: "cursor:fable5-xhigh",
			idempotency_key: "unknown-model-start",
			allow_mutation: true,
		});
		expect(rejected).toMatchObject({
			ok: false,
			reason: "unknown_model",
			model: "cursor:fable5-xhigh",
		});
		const error = (rejected as { error?: { message?: string } }).error?.message ?? "";
		expect(error).toContain("not found");
		expect(error).toContain("--list-models");
		expect(lifecycleControls(controls)).toEqual([]);
	});

	it("resolves a delegate model pin into the lifecycle create request and prompt", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			modelResolver: pinnedModelResolver([pinnedModel("cursor", "composer-2.5")]),
		});
		const delegated = await server.callTool("gjc_delegate_plan", {
			cwd: root,
			task: "plan the thing",
			model: "cursor/composer-2.5",
			idempotency_key: "delegate-model",
			allow_mutation: true,
		});
		expect(delegated).toMatchObject({
			ok: true,
			session: { model: "cursor/composer-2.5" },
		});
		expect(controls.filter(control => control.operation === "session.create").map(control => control.input)).toEqual([
			{
				cwd: root,
				target: { path: root },
				modelId: "cursor/composer-2.5",
				coordinatorStateDir: coordinatorNamespace(root),
				coordinatorSidecarSigningKey: expect.any(String),
				coordinatorSidecarKeyId: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		]);
	});
	it("fences lifecycle creation with remote_started registry and replays without duplication", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const deferred = Promise.withResolvers<unknown>();
		let lifecycleInput: Record<string, unknown> | undefined;
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			globalResult: (operation, input, brokerSessions) => {
				if (operation !== "session.create") return undefined;
				lifecycleInput = input;
				return deferred.promise.then(async result => {
					const endpointPath = path.join(root, ".gjc", "state", "sdk", "created-session-1.json");
					await fs.mkdir(path.dirname(endpointPath), { recursive: true });
					await Bun.write(
						endpointPath,
						JSON.stringify({
							sessionId: "created-session-1",
							pid: process.pid,
							url: "ws://sdk.example.test",
							token: "test-token",
						}),
					);
					brokerSessions.push({
						sessionId: "created-session-1",
						locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
						live: true,
						endpointGeneration: 1,
						pid: process.pid,
						endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
					});
					return {
						...(result as Record<string, unknown>),
						result: {
							...(result as { result: Record<string, unknown> }).result,
							coordinatorSidecarKeyId: input.coordinatorSidecarKeyId,
						},
					};
				});
			},
		});
		const startedPromise = server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "deferred-create-fence",
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		let creation: Record<string, unknown> | undefined;
		for (let attempt = 0; attempt < 200 && (!creation || !lifecycleInput); attempt++) {
			try {
				const registry = JSON.parse(await fs.readFile(paths.registry, "utf8")) as Record<string, unknown>;
				const creations = registry.creations as Record<string, Record<string, unknown>> | undefined;
				const candidate = creations ? Object.values(creations)[0] : undefined;
				creation = candidate?.phase === "remote_started" ? candidate : undefined;
			} catch {
				// The registry may not exist until the initial claim transaction completes.
			}
			if (!creation || !lifecycleInput) await Bun.sleep(10);
		}
		expect(creation).toMatchObject({ phase: "remote_started" });
		expect((creation?.sidecar_verifier as Record<string, unknown>)?.key_id).toBe(
			lifecycleInput?.coordinatorSidecarKeyId,
		);
		deferred.resolve({
			ok: true,
			result: {
				sessionId: "created-session-1",
				endpoint: { url: "ws://broker.example.test", token: "test-token" },
			},
		});
		await expect(startedPromise).resolves.toMatchObject({ ok: true, session: { session_id: "created-session-1" } });
		expect(controls.filter(control => control.operation === "session.create")).toHaveLength(1);
	});

	it("routes the default model pin through the SDK broker host boundary", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			globalResult: operation =>
				operation === "model.resolve" ? { ok: true, result: { ok: true, model: "cursor/default" } } : undefined,
		});

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			model: "cursor/default",
			idempotency_key: "broker-model-pin",
			allow_mutation: true,
		});

		expect(started).toMatchObject({ ok: true, session: { model: "cursor/default" } });
		expect(lifecycleControls(controls).map(control => control.operation)).toEqual([
			"model.resolve",
			"session.create",
		]);
		expect(controls.find(control => control.operation === "model.resolve")?.input).toMatchObject({ cwd: root });
	});

	it("passes the planned worktree target to model pin resolution", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			undefined,
			undefined,
			"gjc --worktree",
			undefined,
			{
				globalResult: (operation, input) => {
					if (operation === "model.resolve") {
						expect(input.target).toMatchObject({ path: root, worktree: { enabled: true } });
						return { ok: true, result: { ok: true, model: "cursor/default" } };
					}
					return undefined;
				},
			},
		);

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			model: "cursor/default",
			idempotency_key: "broker-model-pin-worktree",
			allow_mutation: true,
		});

		expect(started).toMatchObject({ ok: true, session: { model: "cursor/default" } });
	});
	it("keeps lifecycle endpoint credentials out of start_session results", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "credential-free-start",
			allow_mutation: true,
		});

		expect(started).toMatchObject({ ok: true, session: { session_id: "created-session-1" } });
		expect(started.result).toBeUndefined();
		for (const secret of ["created-endpoint-secret", "nested-created-endpoint-secret", "Bearer"]) {
			expect(JSON.stringify(started)).not.toContain(secret);
		}
		expect(started.lifecycle).toEqual({ session_id: "created-session-1" });
	});

	it("translates the documented GJC worktree command into a typed SDK lifecycle target", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			"gjc --worktree hermes",
		);

		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "worktree-start",
			allow_mutation: true,
		});
		expect(started).toMatchObject({
			ok: true,
			session: { cwd: path.join(root, "hermes-worktree") },
			lifecycle: {
				session_id: "created-session-1",
				worktree: {
					enabled: true,
					cwd: path.join(root, "hermes-worktree"),
					created: true,
					reused: false,
				},
			},
		});
		expect(controls).toContainEqual({
			operation: "session.create",
			input: {
				cwd: root,
				target: { path: root, worktree: { enabled: true, name: "hermes" } },
				coordinatorStateDir: coordinatorNamespace(root),
				coordinatorSidecarSigningKey: expect.any(String),
				coordinatorSidecarKeyId: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
			idempotencyKey: expect.stringMatching(/^remote_[a-f0-9]{64}$/),
		});
	});

	it("rejects unsupported session-command flags rather than silently ignoring them", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			"gjc --worktree --model provider/model",
		);

		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: "invalid-worktree-command",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		expect(controls).toEqual([]);
	});
	it("rejects wrapper session commands instead of executing a coordinator-owned launcher", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			"wrapper gjc --worktree",
		);

		await expect(
			server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: "wrapper-command",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
		expect(controls).toEqual([]);
	});
	it("durably replays sequential prompt retries and rejects caller-key request conflicts", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "retry-safe prompt",
			idempotency_key: "same-prompt-key",
			allow_mutation: true,
		});
		const replay = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "retry-safe prompt",
			idempotency_key: "same-prompt-key",
			allow_mutation: true,
		});
		expect(replay).toEqual(first);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
		await expect(
			server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "different prompt",
				idempotency_key: "same-prompt-key",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	});
	it("serializes concurrent same-key retries into one durable turn", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const receiptPersisted = Promise.withResolvers<void>();
		const releaseFinalization = Promise.withResolvers<void>();
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				afterPromptReceiptPersisted: async () => {
					receiptPersisted.resolve();
					await releaseFinalization.promise;
				},
			},
		);
		await registerSdkSession(server, root);
		const request = {
			session_id: "visible-session",
			prompt: "concurrent retry",
			idempotency_key: "concurrent-prompt-key",
			allow_mutation: true,
		};
		const firstPromise = server.callTool("gjc_coordinator_send_prompt", request);
		await receiptPersisted.promise;
		const replayPromise = server.callTool("gjc_coordinator_send_prompt", request);
		await Bun.sleep(2_100);
		releaseFinalization.resolve();
		const [first, replay] = await Promise.all([firstPromise, replayPromise]);
		expect(replay).toEqual(first);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	}, 10_000);
	it("rejects an in-flight same-key conflict without joining the owned turn", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const receiptPersisted = Promise.withResolvers<void>();
		const releaseFinalization = Promise.withResolvers<void>();
		const server = await createSdkControlServer(
			root,
			controls,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				afterPromptReceiptPersisted: async () => {
					receiptPersisted.resolve();
					await releaseFinalization.promise;
				},
			},
		);
		await registerSdkSession(server, root);
		const firstPromise = server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "owned prompt",
			idempotency_key: "in-flight-conflict-key",
			allow_mutation: true,
		});
		await receiptPersisted.promise;
		const conflict = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "conflicting prompt",
			idempotency_key: "in-flight-conflict-key",
			allow_mutation: true,
		});
		expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		releaseFinalization.resolve();
		await expect(firstPromise).resolves.toMatchObject({ ok: true, operation: "turn.prompt" });
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	});
	it("keeps different idempotency keys isolated", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const first = await server.callTool("gjc_coordinator_report_status", {
			status: "blocked",
			summary: "first isolated report",
			idempotency_key: "first-isolated-key",
			allow_mutation: true,
		});
		const second = await server.callTool("gjc_coordinator_report_status", {
			status: "blocked",
			summary: "second isolated report",
			idempotency_key: "second-isolated-key",
			allow_mutation: true,
		});
		expect(first).toMatchObject({ ok: true, report: { summary: "first isolated report" } });
		expect(second).toMatchObject({ ok: true, report: { summary: "second isolated report" } });
		expect(second.report).not.toEqual(first.report);
	});
	it("recovers a committed report after the outer idempotency receipt is left in progress", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "recover report",
			idempotency_key: "recover-report-prompt",
			allow_mutation: true,
		});
		const request = {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			status: "completed",
			summary: "recoverable completion",
			idempotency_key: "recover-report",
			allow_mutation: true,
		};
		const first = await server.callTool("gjc_coordinator_report_status", request);
		const receiptPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(request.idempotency_key).digest("hex")}.json`,
		);
		const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
		const { response: _response, ...crashLeft } = receipt;
		await fs.writeFile(receiptPath, JSON.stringify({ ...crashLeft, state: "in_progress" }));
		const recovered = await server.callTool("gjc_coordinator_report_status", request);
		const firstSessionState = first.session_state as Record<string, unknown>;
		const recoveredSessionState = recovered.session_state as Record<string, unknown>;
		expect(recovered).toEqual(first);
		expect(recovered).toMatchObject({
			ok: true,
			report: first.report,
			turn: first.turn,
			session_state: {
				session_id: firstSessionState.session_id,
				state: "completed",
				ready_for_input: false,
				current_turn_id: firstSessionState.current_turn_id,
				last_turn_id: firstSessionState.last_turn_id,
			},
		});
		expect(recovered.report).toEqual(first.report);
		expect(recovered.turn).toEqual(first.turn);
		for (const field of ["updated_at", "ended_at"]) {
			const original = firstSessionState[field];
			const repaired = recoveredSessionState[field];
			expect(typeof original).toBe("string");
			expect(typeof repaired).toBe("string");
			expect(Number.isFinite(Date.parse(original as string))).toBe(true);
			expect(Number.isFinite(Date.parse(repaired as string))).toBe(true);
		}

		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			canonical: {
				reports: Record<string, Record<string, unknown>>;
				turns: Record<string, Record<string, unknown>>;
			};
		};
		expect(Object.keys(transaction.canonical.reports)).toHaveLength(1);
		expect(Object.values(transaction.canonical.reports)[0]).toMatchObject({
			operation_id: "report:recover-report",
			session_id: "visible-session",
			turn_id: sent.turn_id,
			status: "completed",
			summary: "recoverable completion",
		});
		expect(transaction.canonical.turns[String(sent.turn_id)]).toMatchObject({
			status: "completed",
			terminal_fence: { status: "completed" },
		});
		const journal = (
			await fs.readFile(path.join(coordinatorNamespace(root), "events", "event-journal.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(journal.filter(event => event.kind === "report.written")).toHaveLength(1);
		expect(journal.filter(event => event.kind === "turn.completed" && event.turn_id === sent.turn_id)).toHaveLength(
			1,
		);
		await expect(server.callTool("gjc_coordinator_read_coordination_status")).resolves.toMatchObject({
			summary: { reports: 1 },
		});
	});

	it("re-appends the stable report.written event when a namespace-only report recovers from its projection", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const idempotencyKey = "namespace-report-torn-append";
		const reportId = `report-${createHash("sha256").update(`report\\0${idempotencyKey}`).digest("hex")}`;
		// Crash window under repair: the projection write is durable, the journal
		// append never landed, and no outer idempotency receipt exists yet.
		const reportsDir = path.join(coordinatorNamespace(root), "reports");
		await fs.mkdir(reportsDir, { recursive: true });
		await Bun.write(
			path.join(reportsDir, `${reportId}.json`),
			JSON.stringify({
				status: "blocked",
				summary: "torn namespace report",
				created_at: new Date().toISOString(),
			}),
		);

		const request = {
			status: "blocked",
			summary: "torn namespace report",
			idempotency_key: idempotencyKey,
			allow_mutation: true,
		};
		await expect(server.callTool("gjc_coordinator_report_status", request)).resolves.toMatchObject({
			ok: true,
			report: { summary: "torn namespace report" },
		});

		const journalPath = path.join(coordinatorNamespace(root), "events", "event-journal.jsonl");
		const readWrittenEvents = async (): Promise<Record<string, unknown>[]> => {
			try {
				const rows = (await fs.readFile(journalPath, "utf8"))
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line) as Record<string, unknown>);
				return rows.filter(event => event.kind === "report.written");
			} catch {
				return [];
			}
		};
		const written = await readWrittenEvents();
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({ id: `report-written:${reportId}`, report_id: reportId });

		await expect(server.callTool("gjc_coordinator_report_status", request)).resolves.toMatchObject({ ok: true });
		expect(await readWrittenEvents()).toHaveLength(1);
	});
	it("returns the canonical safe response exactly after a crash before outer report completion", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let persistedSafeResponse: Record<string, unknown> | null = null;
		let interrupted = true;
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			afterCanonicalReportSafeResponse: async (sessionId, response) => {
				if (!interrupted) return;
				interrupted = false;
				persistedSafeResponse = response;
				const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
				const transaction = JSON.parse(await fs.readFile(transactionPath(paths, sessionId), "utf8")) as {
					requests: { operations: Record<string, Record<string, unknown>> };
				};
				const operation = Object.values(transaction.requests.operations).find(
					candidate => candidate.tool === "gjc_coordinator_report_status",
				);
				expect(operation).toMatchObject({ phase: "completed", safe_response: response });
				throw new Error("simulated_report_safe_response_crash");
			},
		});
		await registerSdkSession(server, root);
		const request = {
			session_id: "visible-session",
			status: "blocked",
			summary: "safe response barrier",
			idempotency_key: "safe-response-barrier",
			allow_mutation: true,
		};
		await expect(server.callTool("gjc_coordinator_report_status", request)).resolves.toMatchObject({ ok: false });
		if (!persistedSafeResponse) throw new Error("canonical safe response was not persisted");
		const receiptPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(request.idempotency_key).digest("hex")}.json`,
		);
		const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
		const { response: _response, ...crashLeft } = receipt;
		await fs.writeFile(receiptPath, JSON.stringify({ ...crashLeft, state: "in_progress" }));
		const recovered = await server.callTool("gjc_coordinator_report_status", request);
		expect(recovered).toEqual(persistedSafeResponse);
		expect(JSON.stringify(recovered)).toBe(JSON.stringify(persistedSafeResponse));
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			canonical: { reports: Record<string, Record<string, unknown>> };
			requests: { operations: Record<string, Record<string, unknown>> };
		};
		const operation = Object.values(transaction.requests.operations).find(
			candidate => candidate.tool === "gjc_coordinator_report_status",
		);
		expect(operation).toMatchObject({ phase: "completed", safe_response: persistedSafeResponse });
		const reportId = Object.keys(transaction.canonical.reports)[0];
		if (!reportId) throw new Error("missing canonical report");
		await expect(
			fs.readFile(path.join(coordinatorNamespace(root), "reports", `${reportId}.json`), "utf8"),
		).resolves.toContain("safe response barrier");
	});

	it("repairs every projection before sealing a report recovered after the canonical commit barrier", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let interrupted = true;
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			afterCanonicalReportCommit: async () => {
				if (interrupted) {
					interrupted = false;
					throw new Error("simulated_report_crash");
				}
			},
		});
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "canonical report barrier",
			idempotency_key: "barrier-report-prompt",
			allow_mutation: true,
		});
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "queued after report",
			queue: true,
			idempotency_key: "barrier-report-queued",
			allow_mutation: true,
		});
		const request = {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			status: "completed",
			summary: "barrier completion",
			idempotency_key: "barrier-report",
			allow_mutation: true,
		};
		await expect(server.callTool("gjc_coordinator_report_status", request)).resolves.toMatchObject({ ok: false });
		const receiptPath = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(request.idempotency_key).digest("hex")}.json`,
		);
		const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
		const { response: _response, ...crashLeft } = receipt;
		await fs.writeFile(receiptPath, JSON.stringify({ ...crashLeft, state: "in_progress" }));
		const recovered = await server.callTool("gjc_coordinator_report_status", request);
		expect(recovered).toMatchObject({ ok: true, report: { summary: "barrier completion" } });
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			canonical: {
				turns: Record<string, Record<string, unknown>>;
				queue: Record<string, unknown>;
				reports: Record<string, Record<string, unknown>>;
			};
		};
		const queuedTurnId = String(queued.turn_id);
		const reportId = Object.keys(transaction.canonical.reports)[0];
		if (!reportId) throw new Error("missing recovered report");
		const projectionRoot = coordinatorNamespace(root);
		expect(transaction.canonical.queue).toMatchObject({ active_turn_id: queuedTurnId });
		expect(transaction.canonical.turns[String(sent.turn_id)]).toMatchObject({ status: "completed" });
		const activeProjection = JSON.parse(
			await fs.readFile(path.join(projectionRoot, "active-turns", "visible-session.json"), "utf8"),
		) as Record<string, unknown>;
		expect(activeProjection).toMatchObject({ turn_id: queuedTurnId, status: "active" });
		const sessionState = JSON.parse(
			await fs.readFile(path.join(projectionRoot, "session-states", "visible-session.json"), "utf8"),
		) as Record<string, unknown>;
		expect(sessionState).toMatchObject({ state: "running", current_turn_id: queuedTurnId });
		expect(await fs.readFile(path.join(projectionRoot, "reports", `${reportId}.json`), "utf8")).toContain(
			"barrier completion",
		);
		const journal = (await fs.readFile(path.join(projectionRoot, "events", "event-journal.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(journal.filter(event => event.kind === "report.written")).toHaveLength(1);
		expect(journal.filter(event => event.kind === "turn.completed")).toHaveLength(1);
	});

	it("replays a committed report without revalidating deleted evidence", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const evidencePath = path.join(root, "evidence.txt");
		await fs.writeFile(evidencePath, "durable evidence");
		const request = {
			session_id: "visible-session",
			status: "blocked",
			summary: "evidence replay",
			evidence_paths: [evidencePath],
			idempotency_key: "evidence-replay",
			allow_mutation: true,
		};
		const first = await server.callTool("gjc_coordinator_report_status", request);
		await fs.rm(evidencePath);
		await expect(server.callTool("gjc_coordinator_report_status", request)).resolves.toEqual(first);
	});

	it("keeps advertised answer text bounds aligned with runtime Unicode and whitespace rules", () => {
		const codec: PrivateAskGateCodecV1 = {
			schema_version: 1,
			labels: ["Continue"],
			recommended_index: null,
			multi: false,
			allow_empty: true,
			other_allowed: true,
			clarification_allowed: true,
		};
		const schema = buildCoordinatorAskAnswerSchema(["opt_0"], false, true) as {
			oneOf: Array<{ properties?: Record<string, Record<string, unknown>> }>;
		};
		const customSchema = schema.oneOf[1]!.properties!.custom!;
		const questionSchema = schema.oneOf[2]!.properties!.question!;
		expect(customSchema).toMatchObject({
			minLength: 1,
			maxLength: 4096,
			pattern: "\\S",
			"x-maxUtf8Bytes": 4096,
		});
		expect(questionSchema).toMatchObject({
			minLength: 1,
			maxLength: 4096,
			pattern: "\\S",
			"x-maxUtf8Bytes": 4096,
		});
		const values = [
			" \t\n ",
			"😀".repeat(1024),
			"😀".repeat(1025),
			"a".repeat(4096),
			"a".repeat(4097),
			`${" ".repeat(4092)}😀`,
		];
		for (const value of values) {
			const schemaAccepts =
				Array.from(value).length >= Number(customSchema.minLength) &&
				Array.from(value).length <= Number(customSchema.maxLength) &&
				Buffer.byteLength(value) <= Number(customSchema["x-maxUtf8Bytes"]) &&
				new RegExp(String(customSchema.pattern), "u").test(value);
			const runtimeAccepts =
				validateCoordinatorAskAnswer(codec, { selected: [], other: true, custom: value }) !== null;
			const runtimeClarificationAccepts =
				validateCoordinatorAskAnswer(codec, { action: "clarify", question: value }) !== null;
			expect(runtimeAccepts).toBe(schemaAccepts);
			expect(runtimeClarificationAccepts).toBe(schemaAccepts);
		}
	});

	it("accepts the advertised explicit other:false answer form", () => {
		const codec: PrivateAskGateCodecV1 = {
			schema_version: 1,
			labels: ["Continue"],
			recommended_index: null,
			multi: false,
			allow_empty: true,
			other_allowed: true,
			clarification_allowed: true,
		};
		expect(validateCoordinatorAskAnswer(codec, { selected: ["opt_0"], other: false })).toEqual({
			selected: ["opt_0"],
			other: false,
		});
	});

	it("replays composite start and report mutations without allocating another turn or report", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const startArgs = {
			cwd: root,
			prompt: "start once",
			idempotency_key: "composite-start",
			allow_mutation: true,
		};
		const started = await server.callTool("gjc_coordinator_start_session", startArgs);
		const replayedStart = await server.callTool("gjc_coordinator_start_session", startArgs);
		expect(replayedStart).toEqual(started);
		expect(lifecycleControls(controls).filter(control => control.operation === "session.create")).toHaveLength(1);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(1);
		const delegateArgs = {
			cwd: root,
			task: "delegate once",
			idempotency_key: "composite-delegate",
			allow_mutation: true,
		};
		const delegated = await server.callTool("gjc_delegate_execute", delegateArgs);
		const replayedDelegate = await server.callTool("gjc_delegate_execute", delegateArgs);
		expect(replayedDelegate).toEqual(delegated);
		expect(lifecycleControls(controls).filter(control => control.operation === "session.create")).toHaveLength(2);
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(2);

		const reportArgs = {
			status: "running",
			summary: "one report",
			idempotency_key: "composite-report",
			allow_mutation: true,
		};
		const report = await server.callTool("gjc_coordinator_report_status", reportArgs);
		const replayedReport = await server.callTool("gjc_coordinator_report_status", reportArgs);
		expect(replayedReport).toEqual(report);
		await expect(server.callTool("gjc_coordinator_read_coordination_status")).resolves.toMatchObject({
			summary: { reports: 1 },
		});
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect(
			(events.events as Array<Record<string, unknown>>).filter(event => event.kind === "report.written"),
		).toHaveLength(1);
	});
	it("fails closed when a same-generation successor has a different endpoint incarnation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		await registerSdkSession(server, root);
		const recordPath = path.join(coordinatorNamespace(root), "sessions", "visible-session.json");
		const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
		await Bun.write(
			recordPath,
			JSON.stringify({ ...record, ephemeral: true, created_at: new Date(Date.now() - 31 * 60_000).toISOString() }),
		);
		const successor = await prepareExactSessionAuthority({
			agentDir: path.join(root, "agent-global"),
			cwd: root,
			sessionId: "visible-session",
			url: "ws://sdk-successor.example.test",
			token: "successor-token",
			endpointGeneration: 1,
		});
		const endpointPath = path.join(root, ".gjc", "state", "sdk", "visible-session.json");
		await fs.utimes(endpointPath, 0.002, 0.002);
		sessions[0] = {
			...sessions[0]!,
			pid: successor.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		};

		await expect(
			server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "stale successor",
				idempotency_key: "stale-incarnation-prompt",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		await expect(
			server.callTool("gjc_coordinator_stop_session", {
				session_id: "visible-session",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, reason: "endpoint_stale", closed: false });
		expect(
			controls.filter(control => control.operation === "turn.prompt" || control.operation === "session.close"),
		).toEqual([]);
	});
	it("fails closed when a same-generation successor moves to a different broker workspace", async () => {
		const root = await tempRoot();
		const otherWorkspace = path.join(root, "successor-workspace");
		await fs.mkdir(otherWorkspace);
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		await registerSdkSession(server, root);
		const successor = await prepareExactSessionAuthority({
			agentDir: path.join(root, "agent-global"),
			cwd: otherWorkspace,
			sessionId: "visible-session",
			url: "ws://sdk-successor.example.test",
			token: "successor-token",
			endpointGeneration: 1,
		});
		const endpointPath = path.join(otherWorkspace, ".gjc", "state", "sdk", "visible-session.json");
		await fs.utimes(endpointPath, 0.003, 0.003);
		sessions[0] = {
			...sessions[0]!,
			locator: { cwd: otherWorkspace, worktreeRoot: null, stateRoot: path.join(otherWorkspace, ".gjc", "state") },
			pid: successor.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		};
		await expect(
			server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "must not reach successor workspace",
				idempotency_key: "stale-workspace-prompt",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		expect(controls.filter(control => control.operation === "turn.prompt")).toEqual([]);
	});
	it("rejects a stale same-generation attachment before dispatch", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		await registerSdkSession(server, root);
		await server.router.start();
		const staleAttachment = server.router.attachment("visible-session", 1);
		if (!staleAttachment) throw new Error("missing initial session attachment");
		const endpointPath = path.join(root, ".gjc", "state", "sdk", "visible-session.json");
		await Bun.write(endpointPath, JSON.stringify({ url: "ws://successor.test", token: "successor-endpoint-secret" }));
		await fs.utimes(endpointPath, 0.002, 0.002);
		sessions[0]!.endpointMtimeMs = 2;
		await server.router.reconcile();
		await expect(
			server.router.request(
				"visible-session",
				{ type: "control_request", operation: "turn.prompt", input: { text: "must not dispatch" } },
				1,
				staleAttachment,
			),
		).rejects.toThrow();
		expect(controls.filter(control => control.operation === "turn.prompt")).toEqual([]);
	});
	it("fails closed on corrupt or crash-left coordinator idempotency records", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const corruptKey = "corrupt-report";
		const corruptFile = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(corruptKey).digest("hex")}.json`,
		);
		await fs.mkdir(path.dirname(corruptFile), { recursive: true });
		await Bun.write(corruptFile, "{not-json");
		await expect(
			server.callTool("gjc_coordinator_report_status", {
				status: "running",
				summary: "must not write",
				idempotency_key: corruptKey,
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(await fs.readdir(path.join(coordinatorNamespace(root), "reports")).catch(() => [])).toEqual([]);

		await registerSdkSession(server, root);
		const registerFile = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update("register-1").digest("hex")}.json`,
		);
		const completed = JSON.parse(await fs.readFile(registerFile, "utf8"));
		await Bun.write(registerFile, JSON.stringify({ ...completed, state: "in_progress" }));
		await expect(registerSdkSession(server, root)).resolves.toMatchObject({ ok: true, registered: true });
	});
	it("fails closed on workspace and endpoint-generation binding changes", async () => {
		const root = await tempRoot();
		const otherWorkspace = path.join(root, "other-workspace");
		await fs.mkdir(otherWorkspace);
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		await registerSdkSession(server, root);
		sessions.push({
			sessionId: "foreign-session",
			locator: { cwd: otherWorkspace, worktreeRoot: null, stateRoot: path.join(otherWorkspace, ".gjc", "state") },
			live: true,
			endpointGeneration: 1,
			pid: 102,
			endpointMtimeMs: 2,
		});
		await expect(
			server.callTool("gjc_coordinator_register_session", {
				session_id: "foreign-session",
				cwd: root,
				idempotency_key: "foreign-workspace",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
		sessions[0]!.endpointGeneration = 2;
		await expect(
			server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "stale generation",
				idempotency_key: "stale-generation",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		expect(lifecycleControls(controls).filter(control => control.operation === "turn.prompt")).toHaveLength(0);
		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: otherWorkspace,
				session_id: "visible-session",
				task: "wrong workspace",
				idempotency_key: "wrong-workspace",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "workspace_mismatch" } });
	});
	it("uses an incarnation-bound close key for each reaped session incarnation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const sessions = [
			{
				sessionId: "visible-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
		const recordPath = path.join(coordinatorNamespace(root), "sessions", "visible-session.json");
		for (const [registrationKey, endpointMtimeMs] of [
			["reap-first-registration", 1],
			["reap-second-registration", 2],
		] as const) {
			if (sessions.length === 0)
				sessions.push({
					sessionId: "visible-session",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
					endpointGeneration: 1,
					pid: 101,
					endpointMtimeMs,
				});
			else {
				sessions[0]!.endpointMtimeMs = endpointMtimeMs;
				sessions[0]!.endpointGeneration = endpointMtimeMs;
			}
			const authorityRecord = (
				(await Bun.file(recordPath).exists())
					? JSON.parse(await fs.readFile(recordPath, "utf8"))
					: {
							session_id: "visible-session",
							cwd: root,
							broker_workspace: root,
							sidecar_verifier: server.mintSidecarSigningAuthorityForTest(),
						}
			) as Record<string, unknown>;
			authorityRecord.endpoint_generation = sessions[0]!.endpointGeneration;
			authorityRecord.endpoint_incarnation = createHash("sha256")
				.update(
					`{"endpointGeneration":${sessions[0]!.endpointGeneration},"endpointMtimeMs":${
						sessions[0]!.endpointMtimeMs
					},"pid":${sessions[0]!.pid},"sessionId":"visible-session"}`,
				)
				.digest("hex");
			await Bun.write(recordPath, JSON.stringify(authorityRecord));
			await expect(
				server.callTool("gjc_coordinator_register_session", {
					session_id: "visible-session",
					cwd: root,
					idempotency_key: registrationKey,
					allow_mutation: true,
				}),
			).resolves.toMatchObject({ ok: true });
			const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
			await Bun.write(
				recordPath,
				JSON.stringify({
					...record,
					ephemeral: true,
					created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
				}),
			);
			await expect(
				server.callTool("gjc_coordinator_stop_session", { session_id: "visible-session", allow_mutation: true }),
			).resolves.toMatchObject({ ok: true, closed: true });
		}
		const closes = controls.filter(control => control.operation === "session.close");
		expect(closes).toHaveLength(2);
		expect(closes.map(control => control.idempotencyKey)).toEqual([
			expect.stringMatching(/^coordinator-reap:visible-session:[a-f0-9]{64}$/),
			expect.stringMatching(/^coordinator-reap:visible-session:[a-f0-9]{64}$/),
		]);
		expect(closes[0]!.idempotencyKey).not.toBe(closes[1]!.idempotencyKey);
		expect(closes[0]!.input.endpointIncarnation).not.toBe(closes[1]!.input.endpointIncarnation);
	});
	it("never returns credential-contaminated reused session records", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const recordPath = path.join(coordinatorNamespace(root), "sessions", "visible-session.json");
		const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
		await Bun.write(
			recordPath,
			JSON.stringify({
				...record,
				endpoint: { token: "reused-session-secret" },
				token: "reused-session-secret",
				credentials: { nested: "reused-session-secret" },
			}),
		);
		const delegated = await server.callTool("gjc_delegate_plan", {
			cwd: root,
			session_id: "visible-session",
			task: "sanitize session",
			idempotency_key: "contaminated-reuse",
			allow_mutation: true,
		});
		expect(delegated).toMatchObject({ ok: true, session: { session_id: "visible-session" } });
		expect(JSON.stringify(delegated)).not.toContain("reused-session-secret");
		expect(await fs.readFile(recordPath, "utf8")).not.toContain("reused-session-secret");
	});

	it("routes prompts, follow-ups, abort-and-prompts, and answers through SDK controls with caller keys", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const controlOptions: Array<{ idempotencyKey?: string; timeoutMs?: number }> = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			promptAckTimeoutMs: 17,
			controlOptions,
		});
		await registerSdkSession(server, root);
		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "first",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});
		expect(first).toMatchObject({ ok: true, operation: "turn.prompt", turn: { status: "active" } });
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "follow up",
			queue: true,
			idempotency_key: "prompt-2",
			allow_mutation: true,
		});
		expect(queued).toMatchObject({
			ok: true,
			operation: "turn.follow_up",
			result: { accepted: true, command_id: expect.any(String), turn_id: expect.any(String) },
			turn: {
				status: "queued",
				delivery: { runtime_command_id: expect.any(String), runtime_turn_id: expect.any(String) },
			},
		});
		const queuedTurnId = queued.turn_id;
		if (typeof queuedTurnId !== "string") throw new Error("missing queued coordinator turn id");
		const queuedAcknowledgement = queued.result as { command_id?: unknown; turn_id?: unknown };
		const persistedQueuedTurn = JSON.parse(
			await fs.readFile(path.join(coordinatorNamespace(root), "turns", `${queuedTurnId}.json`), "utf8"),
		) as { delivery: Record<string, unknown> };
		expect(persistedQueuedTurn.delivery).toMatchObject({
			runtime_command_id: queuedAcknowledgement.command_id,
			runtime_turn_id: queuedAcknowledgement.turn_id,
		});
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "replace",
				force: true,
				idempotency_key: "prompt-3",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, operation: "turn.abort_and_prompt", turn: { status: "active" } });
		expect(lifecycleControls(controls)).toEqual([
			{ operation: "turn.prompt", input: { text: "first" }, idempotencyKey: "prompt-1" },
			{ operation: "turn.follow_up", input: { text: "follow up" }, idempotencyKey: "prompt-2" },
			{ operation: "turn.abort_and_prompt", input: { text: "replace" }, idempotencyKey: "prompt-3" },
		]);
		expect(controlOptions).toEqual([
			{ idempotencyKey: "prompt-1" },
			{ idempotencyKey: "prompt-2" },
			{ idempotencyKey: "prompt-3" },
		]);
	});

	it("materializes a legal two-page Q12 snapshot on one connection and submits its bound shared-producer answer", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const q12Calls: Array<string | undefined> = [];
		let runtimeTurnId = "unbound";
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			(query, cursor) => {
				if (query !== "Q12") return { ok: true, page: { items: [], complete: true, revision: "context" } };
				q12Calls.push(cursor);
				return cursor
					? {
							ok: true,
							page: {
								items: [sharedAskGate("gate-q12", runtimeTurnId, "ralplan", "approval")],
								complete: true,
								revision: "q12-r1",
							},
						}
					: {
							ok: true,
							page: {
								items: [],
								complete: false,
								preview: true,
								continuationCursor: "page-2",
								revision: "q12-r1",
							},
						};
			},
			undefined,
			undefined,
			undefined,
			{
				controlResult: control =>
					control.operation === "workflow.gate_answer"
						? {
								ok: true,
								result: { status: "accepted", resolved_at: "2026-07-17T00:01:00.000Z" },
							}
						: undefined,
			},
		);
		const discovery = await server.handleJsonRpc({ jsonrpc: "2.0", id: "schema", method: "tools/list" });
		const discoveredTools = (discovery.result as { tools: Array<Record<string, unknown>> }).tools;
		const answerTool = discoveredTools.find(tool => tool.name === "gjc_coordinator_submit_question_answer");
		if (!answerTool) throw new Error("missing answer tool");
		const answerInputSchema = answerTool.inputSchema as Record<string, unknown>;
		const answerProperties = answerInputSchema.properties as Record<string, unknown>;
		const discoveredAnswerSchema = answerProperties.answer as {
			type?: unknown;
			oneOf?: unknown;
		};
		expect(discoveredAnswerSchema.type).toBe("object");
		expect(Array.isArray(discoveredAnswerSchema.oneOf)).toBe(true);
		if (!Array.isArray(discoveredAnswerSchema.oneOf)) throw new Error("answer schema oneOf is not an array");
		expect(discoveredAnswerSchema.oneOf).toHaveLength(3);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "open gate",
			idempotency_key: "gate-owner",
			allow_mutation: true,
		});
		const runtimeAcknowledgement = sent.result as { turn_id?: unknown };
		if (typeof runtimeAcknowledgement.turn_id !== "string") throw new Error("missing runtime turn id");
		runtimeTurnId = runtimeAcknowledgement.turn_id;
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(listed).toMatchObject({ ok: true, reconciliation: { complete: true, revision: "q12-r1" } });
		expect(q12Calls).toEqual([undefined, "page-2"]);
		const question = (listed.questions as Array<Record<string, unknown>>)[0]!;
		expect(question).toMatchObject({
			question_id: "gate-q12",
			status: "pending",
			stage: "ralplan",
			kind: "approval",
		});
		const answerSchema = question.answer_schema as { type?: unknown; oneOf?: unknown };
		expect(answerSchema.type).toBe("object");
		expect(Array.isArray(answerSchema.oneOf)).toBe(true);
		if (!Array.isArray(answerSchema.oneOf)) throw new Error("question answer schema oneOf is not an array");
		expect(answerSchema.oneOf).toHaveLength(3);
		expect(answerSchema.oneOf[0]).toMatchObject({ required: ["selected"] });
		expect(answerSchema.oneOf[1]).toMatchObject({ required: ["selected", "other", "custom"] });
		expect(answerSchema.oneOf[2]).toMatchObject({ required: ["action", "question"] });
		expect(JSON.stringify(answerSchema)).toContain('"enum":["opt_0","opt_1"]');
		expect(JSON.stringify(question)).not.toContain("codec");
		if (typeof question.answer_binding !== "string") throw new Error("missing answer binding");
		expect(question.answer_binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(controls.filter(control => control.operation === "workflow.gate_answer")).toEqual([]);

		const answer = await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "gate-q12",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "answer-q12",
			allow_mutation: true,
		});
		expect(answer).toMatchObject({
			ok: true,
			operation: "workflow.gate_answer",
			status: "accepted",
			replayed: false,
		});
		expect(controls.filter(control => control.operation === "workflow.gate_answer")).toEqual([
			expect.objectContaining({
				input: { id: "gate-q12", response: { selected: ["Continue"] }, expectedSessionId: "visible-session" },
			}),
		]);
		const replay = await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "gate-q12",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "answer-q12",
			allow_mutation: true,
		});
		expect(replay).toMatchObject({ ok: true, status: "accepted", replayed: false });
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "visible-session",
				turn_id: sent.turn_id,
				question_id: "gate-q12",
				answer_binding: question.answer_binding,
				answer: { selected: ["opt_1"] },
				idempotency_key: "answer-q12",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
	});

	it("bounds every Q12 snapshot page by the remaining snapshot budget", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const queryOptions: Array<{ timeoutMs?: number } | undefined> = [];
		const server = await createSdkControlServer(
			root,
			controls,
			queries,
			(query, cursor) => {
				if (query !== "Q12") return { ok: true, page: { items: [], complete: true, revision: "context" } };
				return cursor
					? { ok: true, page: { items: [], complete: true, revision: "q12-budget" } }
					: {
							ok: true,
							page: {
								items: [],
								complete: false,
								preview: true,
								continuationCursor: "page-2",
								revision: "q12-budget",
							},
						};
			},
			undefined,
			undefined,
			undefined,
			{ queryOptions },
		);
		await registerSdkSession(server, root);
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(listed).toMatchObject({ ok: true, reconciliation: { complete: true } });

		const q12Budgets = queries
			.map((query, index) => (query === "Q12" ? queryOptions[index]?.timeoutMs : undefined))
			.filter((timeoutMs): timeoutMs is number => timeoutMs !== undefined);
		// The snapshot deadline is only checked between pages, so a page that carried
		// no budget of its own would outlive the whole 5s bound on the Router default.
		expect(q12Budgets).toHaveLength(queries.filter(query => query === "Q12").length);
		for (const timeoutMs of q12Budgets) {
			expect(timeoutMs).toBeGreaterThan(0);
			expect(timeoutMs).toBeLessThanOrEqual(5_000);
		}
		expect(q12Budgets.length).toBeGreaterThanOrEqual(2);
		// Each page gets the remainder, not a fresh 5s: a later page can never be
		// granted more time than an earlier one, which a fixed per-page budget would
		// allow. Pages resolve in the same millisecond here, so equality is legal.
		for (let index = 1; index < q12Budgets.length; index++)
			expect(q12Budgets[index]!).toBeLessThanOrEqual(q12Budgets[index - 1]!);
	});

	it("diagnoses malformed gate rows without misclassifying legal Q12 pagination", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "unbound";
		const gates = () => [
			{ ...sharedAskGate("bad-runtime", runtimeTurnId), runtime_turn_id: "" },
			{ ...sharedAskGate("unsupported", runtimeTurnId, "ultragoal"), kind: "execution" },
		];
		const server = await createSdkControlServer(root, controls, [], query =>
			query === "Q12"
				? { ok: true, page: { items: gates(), complete: true, revision: "q12-bad" } }
				: { ok: true, page: { items: [], complete: true, revision: "context" } },
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "owner",
			idempotency_key: "owner-bad",
			allow_mutation: true,
		});
		const runtimeAcknowledgement = sent.result as { turn_id?: unknown };
		if (typeof runtimeAcknowledgement.turn_id !== "string") throw new Error("missing runtime turn id");
		runtimeTurnId = runtimeAcknowledgement.turn_id;
		const first = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const second = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(first).toMatchObject({
			questions: [],
			diagnostics: expect.arrayContaining([
				expect.objectContaining({ reason: "missing_runtime_turn", gate_id: "bad-runtime" }),
				expect.objectContaining({ reason: "unsupported_gate", gate_id: "unsupported" }),
			]),
			reconciliation: { complete: true, reason: null },
		});
		expect(second).toMatchObject({ questions: [], reconciliation: { complete: true, reason: null } });
	});

	it("does not fabricate stale questions from incomplete or paginated Q12 observations", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries, query => {
			if (query === "Q12") {
				return {
					type: "query_response",
					id: "q12-incomplete",
					ok: true,
					page: { items: [], complete: false, revision: "partial-q12" },
				};
			}
			return {
				type: "query_response",
				id: "context",
				ok: true,
				page: { items: [], complete: true, revision: "context" },
			};
		});
		await registerSdkSession(server, root);
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(listed).toMatchObject({
			ok: true,
			schema_version: 1,
			questions: [],
			reconciliation: { attempted: true, complete: false, revision: "partial-q12" },
		});
		expect(JSON.stringify(listed)).not.toContain("answer_binding");
		const status = await server.callTool("gjc_coordinator_read_coordination_status");
		expect(status).toMatchObject({
			ok: true,
			schema_version: 1,
			questions: [],
			summary: {
				questions_complete: false,
				questions: null,
				open_questions: null,
			},
		});
		const statusRecord = status as Record<string, unknown>;
		const summary = statusRecord.summary as Record<string, unknown>;
		const summaryDiagnostics = summary.question_diagnostics;
		expect(Array.isArray(summaryDiagnostics)).toBe(true);
		if (!Array.isArray(summaryDiagnostics)) throw new Error("status diagnostics are not an array");
		expect(summaryDiagnostics).toHaveLength(1);

		const questionSnapshots = statusRecord.question_snapshots;
		expect(Array.isArray(questionSnapshots)).toBe(true);
		if (!Array.isArray(questionSnapshots)) throw new Error("status question snapshots are not an array");
		expect(questionSnapshots).toHaveLength(1);
		const snapshot = questionSnapshots[0] as Record<string, unknown>;
		expect(snapshot.session_id).toBe("visible-session");
		expect(snapshot.questions).toEqual([]);

		const snapshotDiagnostics = snapshot.diagnostics;
		expect(Array.isArray(snapshotDiagnostics)).toBe(true);
		if (!Array.isArray(snapshotDiagnostics)) throw new Error("question snapshot diagnostics are not an array");
		expect(snapshotDiagnostics).toHaveLength(1);
		expect(snapshotDiagnostics[0]).toMatchObject({
			schema_version: 1,
			session_id: "visible-session",
			turn_id: null,
			gate_id: null,
			reason: "pagination_malformed",
		});
		expect(typeof (snapshotDiagnostics[0] as Record<string, unknown>).observed_at).toBe("string");
		expect(summaryDiagnostics).toEqual(snapshotDiagnostics);

		const reconciliation = snapshot.reconciliation as Record<string, unknown>;
		expect(reconciliation).toMatchObject({
			attempted: true,
			complete: false,
			revision: "partial-q12",
			reason: "pagination_malformed",
		});
		expect(typeof reconciliation.observed_at).toBe("string");
		expect(JSON.stringify(status)).not.toContain("answer_binding");
		expect(queries).toEqual(["Q12", "Q12"]);
	});

	it("delivers every delegation workflow through broker lifecycle and SDK control", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		for (const [tool, key] of [
			["gjc_delegate_plan", "plan"],
			["gjc_delegate_execute", "execute"],
		] as const) {
			const result = await server.callTool(tool, {
				cwd: root,
				task: `${key} task`,
				idempotency_key: key,
				allow_mutation: true,
			});
			expect(result).toMatchObject({ ok: true, delivered: true, workflow: key });
		}
		expect(lifecycleControls(controls)).toEqual(
			expect.arrayContaining([
				{
					operation: "session.create",
					input: {
						cwd: root,
						target: { path: root },
						coordinatorStateDir: coordinatorNamespace(root),
						coordinatorSidecarSigningKey: expect.any(String),
						coordinatorSidecarKeyId: expect.stringMatching(/^[0-9a-f]{64}$/),
					},
					idempotencyKey: expect.stringMatching(/^remote_[a-f0-9]{64}$/),
				},
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:ralplan") },
					idempotencyKey: "plan",
				},
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:ultragoal") },
					idempotencyKey: "execute",
				},
			]),
		);
	});
	it("auto-binds concurrent delegated sessions to the newest host Codex handoff", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		const host = await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "visible-session",
			turnId: "host-turn",
			prompt: "$gjc-mcp-delegate-flow",
		});
		if (!host) throw new Error("host context was not persisted");
		const tokenRoot = path.join(namespace, "codex-tokens");
		await fs.mkdir(tokenRoot, { recursive: true, mode: 0o700 });
		const tokenFile = path.join(tokenRoot, "codex-bridge.token");
		await fs.writeFile(tokenFile, "test-token", { mode: 0o600 });
		await fs.chmod(tokenFile, 0o600);
		const source = await registerCodexHandoff(namespace, {
			work_unit: "visible-session",
			thread_id: "thread-codex-1",
			endpoint: { kind: "unix", path: "/tmp/codex-bridge.sock" },
			token_file: tokenFile,
		});
		const sourceFile = path.join(namespace, "codex-handoffs", "visible-session.json");
		const sourceBefore = await fs.readFile(sourceFile, "utf8");
		const results = await Promise.all(
			["auto-bind-one", "auto-bind-two"].map(idempotency_key =>
				server.callTool("gjc_delegate_execute", {
					cwd: root,
					task: idempotency_key,
					idempotency_key,
					allow_mutation: true,
				}),
			),
		);
		const sessionIds = results.map(result => String(result.session_id));

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ok: true, codex_handoff: { auto_bound: true, thread_id: "thread-codex-1" } }),
			]),
		);
		expect(new Set(sessionIds).size).toBe(2);
		const origins: CodexHandoffOriginV1[] = [];
		for (const [index, sessionId] of sessionIds.entries()) {
			const bound = await readCodexHandoff(namespace, sessionId);
			expect(bound).toMatchObject({
				thread_id: source.thread_id,
				endpoint: source.endpoint,
				token_file: source.token_file,
				origin: {
					// GJC identity: the NEW delegate coordinator session and its accepted GJC turn.
					gjc_session_id: sessionId,
					gjc_turn_id: results[index]?.turn_id,
					// Codex correlation: host thread (must equal source), host session, host turn.
					codex_thread_id: source.thread_id,
					codex_host_session_id: "visible-session",
					codex_turn_id: "host-turn",
					delegation_id: results[index]?.turn_id,
					workflow: "execute",
				},
			});
			if (bound?.origin) origins.push(bound.origin);
		}
		// Two delegates: DISTINCT GJC session + turn identities...
		expect(origins[0]?.gjc_session_id).not.toBe(origins[1]?.gjc_session_id);
		expect(origins[0]?.gjc_turn_id).not.toBe(origins[1]?.gjc_turn_id);
		// ...sharing one Codex thread and the SAME Codex host session/turn correlation.
		expect(origins[0]?.codex_thread_id).toBe(origins[1]?.codex_thread_id);
		expect(origins[0]?.codex_host_session_id).toBe(origins[1]?.codex_host_session_id);
		expect(origins[0]?.codex_turn_id).toBe(origins[1]?.codex_turn_id);
		// GJC ids never masquerade as Codex host ids and vice versa.
		for (const origin of origins) {
			expect(origin.gjc_session_id).not.toBe(origin.codex_host_session_id);
			expect(origin.gjc_turn_id).not.toBe(origin.codex_turn_id);
		}
		expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
	});
	it("binds a delegate session to an explicitly correlated Codex handoff", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await registerCodexHandoff(namespace, {
			work_unit: "codex-host-1",
			thread_id: "thread-explicit-one",
			endpoint: { kind: "unix", path: "/tmp/codex-explicit-one.sock" },
		});

		const result = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "bind explicit Codex handoff",
			idempotency_key: "explicit-codex-handoff",
			allow_mutation: true,
			codex_host_session_id: "codex-host-1",
		});
		const sessionId = String(result.session_id);

		expect(result).toMatchObject({
			ok: true,
			codex_handoff: { auto_bound: true, thread_id: "thread-explicit-one" },
		});
		expect(await readCodexHandoff(namespace, sessionId)).toMatchObject({
			origin: { codex_host_session_id: "codex-host-1" },
		});
	});
	it("explicit correlation overrides ambient host context", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "ambient-codex-host",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await Promise.all([
			registerCodexHandoff(namespace, {
				work_unit: "ambient-codex-host",
				thread_id: "thread-ambient",
				endpoint: { kind: "unix", path: "/tmp/codex-ambient.sock" },
			}),
			registerCodexHandoff(namespace, {
				work_unit: "codex-host-2",
				thread_id: "thread-explicit-two",
				endpoint: { kind: "unix", path: "/tmp/codex-explicit-two.sock" },
			}),
		]);

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "prefer explicit Codex handoff",
				idempotency_key: "explicit-over-ambient",
				allow_mutation: true,
				codex_host_session_id: "codex-host-2",
			}),
		).resolves.toMatchObject({
			ok: true,
			codex_handoff: { auto_bound: true, thread_id: "thread-explicit-two" },
		});
	});
	it("missing explicit correlation skips binding with a durable diagnostic", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "skip missing explicit Codex handoff",
				idempotency_key: "missing-explicit-codex-handoff",
				allow_mutation: true,
				codex_host_session_id: "missing-codex-host",
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_explicit_source_missing",
		);
	});
	it("rejects malformed explicit correlation ids without failing delegation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "reject malformed explicit Codex handoff",
				idempotency_key: "malformed-explicit-codex-handoff",
				allow_mutation: true,
				codex_host_session_id: "../evil",
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_explicit_source_missing",
		);
	});
	it("fails closed for a corrupt explicit handoff registration", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await fs.mkdir(path.join(namespace, "codex-handoffs"), { recursive: true });
		await fs.writeFile(path.join(namespace, "codex-handoffs", "corrupt-codex-host.json"), "{ not json", "utf8");

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "skip corrupt explicit Codex handoff",
				idempotency_key: "corrupt-explicit-codex-handoff",
				allow_mutation: true,
				codex_host_session_id: "corrupt-codex-host",
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "unavailable", message: "Coordinator service is unavailable." },
		});
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_explicit_source_missing",
		);
	});
	it("fails closed when eligible host contexts resolve to different Codex threads", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		for (const [sessionId, threadId] of [
			["host-one", "thread-one"],
			["host-two", "thread-two"],
		] as const) {
			await persistMcpDelegateHostContext({ cwd: root, sessionId, prompt: "$gjc-mcp-delegate-flow" });
			await registerCodexHandoff(namespace, {
				work_unit: sessionId,
				thread_id: threadId,
				endpoint: { kind: "unix", path: `/tmp/${sessionId}.sock` },
			});
		}

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "reject conflicting host contexts",
				idempotency_key: "conflicting-host-contexts",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_context_ambiguous",
		);
	});
	it("binds when eligible host contexts resolve to the same Codex thread", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		for (const sessionId of ["same-thread-one", "same-thread-two"]) {
			await persistMcpDelegateHostContext({ cwd: root, sessionId, prompt: "$gjc-mcp-delegate-flow" });
			await registerCodexHandoff(namespace, {
				work_unit: sessionId,
				thread_id: "thread-shared-context",
				endpoint: { kind: "unix", path: `/tmp/${sessionId}.sock` },
			});
		}

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "bind matching host contexts",
				idempotency_key: "matching-host-contexts",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({
			ok: true,
			codex_handoff: { auto_bound: true, thread_id: "thread-shared-context" },
		});
	});
	it("binds despite rejected traversal and oversized host contexts", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		for (const [directory, sessionId, promptExcerpt] of [
			["_session-traversal", "../evil", "resume"],
			["_session-oversized", "oversized", "x".repeat(1024 * 1024)],
		] as const) {
			const contextPath = path.join(root, ".gjc", directory, "state", "mcp-delegate-host-context.json");
			await fs.mkdir(path.dirname(contextPath), { recursive: true });
			await fs.writeFile(
				contextPath,
				JSON.stringify({
					schema_version: 1,
					activation: "$gjc-mcp-delegate-flow",
					session_id: sessionId,
					thread_id: null,
					turn_id: null,
					cwd: root,
					source: "user_prompt_submit",
					recorded_at: "2026-07-19T00:00:00.000Z",
					prompt_excerpt: promptExcerpt,
				}),
				"utf8",
			);
		}
		await persistMcpDelegateHostContext({ cwd: root, sessionId: "valid-host", prompt: "$gjc-mcp-delegate-flow" });
		await registerCodexHandoff(namespace, {
			work_unit: "valid-host",
			thread_id: "thread-valid-host",
			endpoint: { kind: "unix", path: "/tmp/valid-host.sock" },
		});

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "ignore invalid host evidence",
				idempotency_key: "ignore-invalid-host-evidence",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: true, thread_id: "thread-valid-host" } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_context_unreadable",
		);
	});
	it("records and serializes wakes for auto-bound delegate sessions sharing one Codex thread", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			codexTransportFactory: async () => ({
				request: async (method: string, params: Record<string, unknown>) => {
					requests.push({ method, params });
					return method === "thread/resume" ? { thread: { status: { type: "idle" } } } : {};
				},
				close: async () => {},
			}),
		});
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "visible-session",
			turnId: "host-turn",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await registerCodexHandoff(namespace, {
			work_unit: "visible-session",
			thread_id: "thread-wake-shared",
			endpoint: { kind: "unix", path: "/tmp/codex-wake-shared.sock" },
		});
		const results = await Promise.all(
			["wake-bind-one", "wake-bind-two"].map(idempotency_key =>
				server.callTool("gjc_delegate_execute", {
					cwd: root,
					task: idempotency_key,
					idempotency_key,
					allow_mutation: true,
				}),
			),
		);
		const sessionIds = results.map(result => String(result.session_id));
		expect(new Set(sessionIds).size).toBe(2);
		const events = await Promise.all(
			sessionIds.map(sessionId =>
				appendCoordinatorEventForTest(namespace, {
					kind: "turn.completed",
					sessionId,
					summary: `delegate ${sessionId} done`,
				}),
			),
		);
		await awaitCodexWakePublishesForTest(namespace);
		const starts = requests.filter(request => request.method === "turn/start");
		const startIds = starts.map(request => String(request.params.clientUserMessageId));
		expect(new Set(startIds).size).toBe(startIds.length);
		for (const [index, sessionId] of sessionIds.entries())
			expect(startIds).toContain(`gjc-wake-${sessionId}:${events[index]?.seq}`);
		for (let index = 0; index < requests.length; index++)
			if (requests[index]?.method === "turn/start") expect(requests[index - 1]?.method).toBe("thread/resume");
	});
	it("skips ambiguous Codex auto-binding without failing delegation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "host-without-handoff",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await Promise.all([
			registerCodexHandoff(namespace, {
				work_unit: "source-one",
				thread_id: "thread-one",
				endpoint: { kind: "unix", path: "/tmp/codex-one.sock" },
			}),
			registerCodexHandoff(namespace, {
				work_unit: "source-two",
				thread_id: "thread-two",
				endpoint: { kind: "unix", path: "/tmp/codex-two.sock" },
			}),
		]);

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "ambiguous handoff",
				idempotency_key: "ambiguous-handoff",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_source_ambiguous",
		);
	});
	it("uses an unbound host handoff instead of a delegate-bound fallback source", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "host-context",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await registerCodexHandoff(namespace, {
			work_unit: "delegate-source",
			thread_id: "thread-shared",
			endpoint: { kind: "unix", path: "/tmp/delegate-source.sock" },
			origin: {
				gjc_session_id: "delegate-source",
				gjc_turn_id: null,
				codex_host_session_id: "host-context",
				codex_thread_id: "thread-shared",
				codex_turn_id: null,
				delegation_id: "prior-delegation",
				workflow: "execute",
				bound_at: new Date().toISOString(),
			},
		});
		await registerCodexHandoff(namespace, {
			work_unit: "host-source",
			thread_id: "thread-shared",
			endpoint: { kind: "unix", path: "/tmp/host-source.sock" },
		});

		const result = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "select host fallback",
			idempotency_key: "select-host-fallback",
			allow_mutation: true,
		});
		const sessionId = String(result.session_id);

		expect(result).toMatchObject({ ok: true, codex_handoff: { auto_bound: true, thread_id: "thread-shared" } });
		expect(await readCodexHandoff(namespace, sessionId)).toMatchObject({
			endpoint: { kind: "unix", path: "/tmp/host-source.sock" },
		});
	});
	it("skips stale Codex auto-binding sources with a durable diagnostic", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "host-context",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await registerCodexHandoff(namespace, {
			work_unit: "stale-host",
			thread_id: "thread-stale",
			endpoint: { kind: "unix", path: "/tmp/stale-host.sock" },
		});
		const sourceFile = path.join(namespace, "codex-handoffs", "stale-host.json");
		const stale = JSON.parse(await fs.readFile(sourceFile, "utf8")) as Record<string, unknown>;
		stale.updated_at = "2026-07-01T00:00:00.000Z";
		await fs.writeFile(sourceFile, JSON.stringify(stale), "utf8");

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "reject stale source",
				idempotency_key: "reject-stale-source",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_source_stale",
		);
	});
	it("prefers a fresh fallback source over stale records on the same or other threads", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "host-context-mixed",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await registerCodexHandoff(namespace, {
			work_unit: "a-stale-same-thread",
			thread_id: "thread-fresh",
			endpoint: { kind: "unix", path: "/tmp/stale-same.sock" },
		});
		await registerCodexHandoff(namespace, {
			work_unit: "b-stale-other-thread",
			thread_id: "thread-old",
			endpoint: { kind: "unix", path: "/tmp/stale-other.sock" },
		});
		for (const workUnit of ["a-stale-same-thread", "b-stale-other-thread"]) {
			const file = path.join(namespace, "codex-handoffs", `${workUnit}.json`);
			const record = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
			record.updated_at = "2026-07-01T00:00:00.000Z";
			await fs.writeFile(file, JSON.stringify(record), "utf8");
		}
		await registerCodexHandoff(namespace, {
			work_unit: "z-fresh-host",
			thread_id: "thread-fresh",
			endpoint: { kind: "unix", path: "/tmp/fresh-host.sock" },
		});

		const delegated = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "bind to the fresh source",
			idempotency_key: "mixed-stale-fresh",
			allow_mutation: true,
		});
		expect(delegated).toMatchObject({ ok: true, codex_handoff: { auto_bound: true, thread_id: "thread-fresh" } });
		expect(await readCodexHandoff(namespace, String(delegated.session_id))).toMatchObject({
			thread_id: "thread-fresh",
			endpoint: { kind: "unix", path: "/tmp/fresh-host.sock" },
		});
	});
	it("reports stale rather than ambiguous when every fallback thread is stale", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "host-context-all-stale",
			prompt: "$gjc-mcp-delegate-flow",
		});
		for (const [workUnit, thread] of [
			["stale-one", "thread-one"],
			["stale-two", "thread-two"],
		] as const) {
			await registerCodexHandoff(namespace, {
				work_unit: workUnit,
				thread_id: thread,
				endpoint: { kind: "unix", path: `/tmp/${workUnit}.sock` },
			});
			const file = path.join(namespace, "codex-handoffs", `${workUnit}.json`);
			const record = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
			record.updated_at = "2026-07-01T00:00:00.000Z";
			await fs.writeFile(file, JSON.stringify(record), "utf8");
		}

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "all sources stale",
				idempotency_key: "all-stale-threads",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
		const log = await fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8");
		expect(log).toContain("codex_handoff_source_stale");
		expect(log).not.toContain("codex_handoff_source_ambiguous");
	});
	it("keeps a direct host session handoff authoritative over other fallback threads", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "direct-host",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await registerCodexHandoff(namespace, {
			work_unit: "direct-host",
			thread_id: "thread-direct",
			endpoint: { kind: "unix", path: "/tmp/direct-host.sock" },
		});
		await registerCodexHandoff(namespace, {
			work_unit: "other-host",
			thread_id: "thread-other",
			endpoint: { kind: "unix", path: "/tmp/other-host.sock" },
		});

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "direct source wins",
				idempotency_key: "direct-source-wins",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: true, thread_id: "thread-direct" } });
	});
	it("records unreadable host context evidence before binding from an older valid context", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		await persistMcpDelegateHostContext({
			cwd: root,
			sessionId: "valid-host",
			prompt: "$gjc-mcp-delegate-flow",
		});
		await fs.mkdir(path.join(root, ".gjc", "_session-corrupt-host", "state"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "_session-corrupt-host", "state", "mcp-delegate-host-context.json"),
			"{",
			"utf8",
		);
		await registerCodexHandoff(namespace, {
			work_unit: "valid-host",
			thread_id: "thread-valid",
			endpoint: { kind: "unix", path: "/tmp/valid-host.sock" },
		});

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "record corrupt context",
				idempotency_key: "record-corrupt-context",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: true, thread_id: "thread-valid" } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_context_unreadable",
		);
	});
	it("records unreadable host context evidence when no valid context remains", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const namespace = coordinatorNamespace(root);
		const contextPath = path.join(root, ".gjc", "_session-corrupt-host", "state", "mcp-delegate-host-context.json");
		await fs.mkdir(path.dirname(contextPath), { recursive: true });
		await fs.writeFile(contextPath, "{", "utf8");

		await expect(
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				task: "reject unreadable-only context",
				idempotency_key: "reject-unreadable-only-context",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
			"codex_handoff_context_unreadable",
		);
	});
	it("serializes concurrent delegations that reuse one live session", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);

		const results = await Promise.all([
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				session_id: "visible-session",
				task: "first delegated task",
				idempotency_key: "delegate-first",
				allow_mutation: true,
			}),
			server.callTool("gjc_delegate_execute", {
				cwd: root,
				session_id: "visible-session",
				task: "second delegated task",
				idempotency_key: "delegate-second",
				allow_mutation: true,
			}),
		]);

		expect(results.filter(result => result.ok === true && result.status === "active")).toHaveLength(1);
		expect(
			results.filter(
				result =>
					result.ok === false && (result.error as { code?: string } | undefined)?.code === "active_turn_exists",
			),
		).toHaveLength(1);
		expect(controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	});

	describe("delegate admission and completion", () => {
		function receiptPath(root: string, key: string): string {
			return path.join(
				coordinatorNamespace(root),
				"idempotency",
				`${createHash("sha256").update(key).digest("hex")}.json`,
			);
		}

		async function fixture(
			reused: boolean,
			options: SdkControlServerOptions = {},
			queryResult?: Parameters<typeof createSdkControlServer>[3],
		) {
			const root = await tempRoot();
			const controls: SdkControl[] = [];
			const queries: string[] = [];
			const sessions: Array<Record<string, unknown>> = reused
				? [
						{
							sessionId: "visible-session",
							locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
							live: true,
							endpointGeneration: 1,
							pid: 101,
							endpointMtimeMs: 1,
						},
					]
				: [];
			let authorityPrepared = false;
			const open = async (hooks: SdkControlServerOptions = {}) => {
				const server = await createSdkControlServer(
					root,
					controls,
					queries,
					queryResult,
					sessions,
					undefined,
					undefined,
					{
						ensureBroker: async () => testBrokerDiscovery(),
						preserveEndpointAuthority: authorityPrepared,
						...hooks,
					},
				);
				authorityPrepared = true;
				return server;
			};
			const server = await open(options);
			if (reused) expect(await registerSdkSession(server, root)).toMatchObject({ ok: true });
			const request = {
				cwd: root,
				...(reused ? { session_id: "visible-session" } : {}),
				task: "durable delegated task",
				idempotency_key: "delegate-regression",
				allow_mutation: true,
				await_completion: true,
				timeout_ms: 10,
				poll_interval_ms: 10,
			};
			return { root, controls, queries, server, open, request };
		}

		for (const mode of ["force", "queue"] as const) {
			for (const awaitCompletion of [true, false]) {
				it(`dispatches ${mode} before releasing the await=${awaitCompletion} observation barrier`, async () => {
					const entered = Promise.withResolvers<void>();
					const release = Promise.withResolvers<void>();
					let held = false;
					const f = await fixture(true, {}, async query => {
						if (awaitCompletion && query === "context.get" && !held) {
							held = true;
							entered.resolve();
							await release.promise;
						}
						return {
							ok: true,
							page: {
								items: query === "context.get" ? [{ isStreaming: true }] : [],
								complete: true,
								revision: "barrier",
							},
						};
					});
					await f.server.router.start();
					expect(f.server.router.attachment("visible-session", 1)).not.toBeNull();
					const delegated = f.server.callTool("gjc_delegate_execute", {
						...f.request,
						await_completion: awaitCompletion,
					});
					let sent: Promise<Record<string, unknown>> | undefined;
					try {
						if (awaitCompletion)
							await Promise.race([
								entered.promise,
								delegated.then(response => {
									throw new Error(`Delegate skipped observation: ${JSON.stringify(response)}`);
								}),
							]);
						else expect(await delegated).toMatchObject({ ok: true, delivered: true });
						if (awaitCompletion) {
							const outer = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
							expect(outer).toMatchObject({ state: "in_progress", admission: { kind: "delegate_admission" } });
							expect(outer.response).toBeUndefined();
						}
						sent = f.server.callTool("gjc_delegate_execute", {
							cwd: f.root,
							session_id: "visible-session",
							task: "interrupt delegated observation",
							[mode]: true,
							idempotency_key: `interrupt-${mode}`,
							allow_mutation: true,
							await_completion: false,
						});
						// Await the actual dispatch response with the observation barrier still held.
						expect(await sent).toMatchObject({ ok: true, workflow: "execute" });
						const operation = mode === "force" ? "turn.abort_and_prompt" : "turn.follow_up";
						expect(f.controls.filter(control => control.operation === operation)).toHaveLength(1);
						expect(f.controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
					} finally {
						release.resolve();
						await Promise.allSettled([delegated, ...(sent ? [sent] : [])]);
					}
					expect(await delegated).toMatchObject({ ok: true });
				}, 15000);
			}
		}

		for (const reused of [false, true]) {
			for (const workflow of ["plan", "execute"] as const) {
				for (const outcome of ["timeout", "completed", "waiting_for_answer"] as const) {
					it(`replays the committed ${workflow}/${reused ? "reused" : "new"}/${outcome} snapshot`, async () => {
						let ready = false;
						let runtimeTurnId = "";
						const f = await fixture(
							reused,
							{
								afterDelegateAdmission: async sessionId => {
									if (outcome === "timeout") return;
									const outer = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
									const turnId = outer.admission.turn_id;
									runtimeTurnId = outer.admission.response.result.turn_id;
									await patchSessionState(f.server, f.root, sessionId, {
										state: outcome === "completed" ? "completed" : "needs_user_input",
										current_turn_id: turnId,
										last_turn_id: turnId,
										ready_for_input: false,
										source: "agent_session_event",
										live: outcome !== "completed",
										updated_at: new Date().toISOString(),
										...(outcome === "completed"
											? {
													final_response: {
														text: "committed terminal answer",
														format: "markdown",
														source: "runtime",
														artifact_path: null,
														truncated: false,
													},
												}
											: { activity: { seq: 1, phase: "waiting", active_tool_count: 0, active_tools: [] } }),
									});
									ready = true;
								},
							},
							query => ({
								ok: true,
								page: {
									items:
										query === "context.get"
											? [{ isStreaming: true }]
											: query === "Q12" && ready && outcome === "waiting_for_answer"
												? [sharedAskGate("delegate-gate", runtimeTurnId)]
												: [],
									complete: true,
									revision: "delegate-outcome",
								},
							}),
						);
						const tool = workflow === "plan" ? "gjc_delegate_plan" : "gjc_delegate_execute";
						const first = await f.server.callTool(tool, f.request);
						expect(first).toMatchObject({
							ok: true,
							completion:
								outcome === "timeout"
									? { ok: false, reason: "timeout" }
									: { ok: true, turn: { status: outcome } },
						});
						const committed = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
						expect(committed).toMatchObject({ state: "completed", response: first });
						if (!reused) {
							const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
							const creations = await withNamespaceRegistry(paths, async registry =>
								Object.values(registry.creations),
							);
							expect(creations).toHaveLength(1);
							expect(creations[0]).toMatchObject({
								phase: "completed",
								safe_response: { session_id: first.session_id, turn_id: first.turn_id },
							});
							expect(creations[0]?.safe_response?.completion).toBeUndefined();
						}
						// The timeout snapshot belongs to this key even if newer terminal evidence arrives.
						if (outcome === "timeout")
							await patchSessionState(f.server, f.root, String(first.session_id), {
								state: "completed",
								current_turn_id: first.turn_id,
								last_turn_id: first.turn_id,
								source: "agent_session_event",
								live: false,
								ready_for_input: false,
								updated_at: new Date().toISOString(),
								final_response: {
									text: "newer answer",
									format: "markdown",
									source: "runtime",
									artifact_path: null,
									truncated: false,
								},
							});
						const queryCount = f.queries.length;
						expect(await f.server.callTool(tool, f.request)).toEqual(first);
						const fresh = await f.open();
						expect(await fresh.callTool(tool, f.request)).toEqual(first);
						expect(f.queries).toHaveLength(queryCount);
						expect(f.controls.filter(control => control.operation === "session.create")).toHaveLength(
							reused ? 0 : 1,
						);
						expect(f.controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
					}, 15000);
				}
			}
		}

		for (const reused of [false, true]) {
			for (const stage of ["accepted", "canonical", "projected", "admission"] as const) {
				it(`recovers ${reused ? "reused" : "new"} ${stage}-only crash without outer.response`, async () => {
					let interrupt = true;
					const crash = () => {
						if (interrupt) throw new Error("injected delegate crash");
					};
					const f = await fixture(reused, {
						...(stage === "accepted" ? { afterPromptReceiptPersisted: crash } : {}),
						...(stage === "canonical" ? { afterCanonicalTurnCommit: crash } : {}),
						...(["projected", "admission"].includes(stage)
							? {
									afterDelegateAdmission: async () => {
										if (stage === "projected" && interrupt) {
											const file = receiptPath(f.root, f.request.idempotency_key);
											const outer = await Bun.file(file).json();
											delete outer.admission;
											await Bun.write(file, JSON.stringify(outer));
										}
										crash();
									},
								}
							: {}),
					});
					expect(await f.server.callTool("gjc_delegate_execute", f.request)).toMatchObject({ ok: false });
					const outer = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
					expect(outer.state).toBe("in_progress");
					expect(outer.response).toBeUndefined();
					if (stage === "admission") expect(outer.admission).toMatchObject({ kind: "delegate_admission" });
					else expect(outer.admission).toBeUndefined();
					interrupt = false;
					const restarted = await f.open();
					const recovered = await restarted.callTool("gjc_delegate_execute", f.request);
					expect(recovered).toMatchObject({ ok: true, completion: { ok: false, reason: "timeout" } });
					const final = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
					expect(final).toMatchObject({ state: "completed", response: recovered });
					const fresh = await f.open();
					expect(await fresh.callTool("gjc_delegate_execute", f.request)).toEqual(recovered);
					expect(f.controls.filter(control => control.operation === "session.create")).toHaveLength(
						reused ? 0 : 1,
					);
					expect(f.controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
				}, 15000);
			}
		}

		for (const stage of ["accepted", "canonical"] as const) {
			for (const mode of ["prompt", "force", "queue"] as const) {
				for (const hasSuccessor of [false, true]) {
					for (const archivedWithoutPin of [false, true]) {
						it(`R1 compaction ${stage}/${mode}/successor=${hasSuccessor}/archived=${archivedWithoutPin}`, async () => {
							let interrupted = true;
							const crash = () => {
								if (interrupted) throw new Error("R1 pre-admission crash");
							};
							const f = await fixture(
								true,
								stage === "accepted"
									? { afterPromptReceiptPersisted: crash }
									: { afterCanonicalTurnCommit: crash },
							);
							const request = { ...f.request, ...(mode === "prompt" ? {} : { [mode]: true }) };
							expect(await f.server.callTool("gjc_delegate_execute", request)).toMatchObject({ ok: false });
							const file = receiptPath(f.root, request.idempotency_key);
							const outer = await Bun.file(file).json();
							expect(outer.state).toBe("in_progress");
							expect(outer.response).toBeUndefined();
							expect(outer.admission).toBeUndefined();
							const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
							const sessionId = "visible-session";
							const operation =
								mode === "prompt"
									? "turn.prompt"
									: mode === "force"
										? "turn.abort_and_prompt"
										: "turn.follow_up";
							const promptKey = createHash("sha256")
								.update(`${request.idempotency_key}\0${operation}`)
								.digest("hex");
							const accepted = await readSessionTransaction(paths, sessionId);
							const prompt = accepted?.requests.prompts[promptKey];
							if (!prompt?.coordinator_turn_id || !prompt.runtime_receipt)
								throw new Error("R1 missing accepted receipt");
							const turnId = prompt.coordinator_turn_id;
							expect(prompt).toMatchObject({
								phase: stage === "accepted" ? "accepted" : "completed",
								delegate_response_pending: true,
							});
							// Runtime-terminal-equivalent WAL post-image: link the accepted identity
							// and terminal fence without report_status, report-operation pins, or promotion.
							await withSessionTransaction(paths, sessionId, async transaction => {
								const turn = transaction.canonical.turns[turnId]!;
								const receipt = transaction.requests.prompts[promptKey]!;
								turn.delivery = {
									...turn.delivery,
									delivered: true,
									prompt_acknowledged: true,
									state: "acknowledged",
									runtime_command_id: prompt.runtime_receipt!.command_id,
									runtime_turn_id: prompt.runtime_receipt!.turn_id,
								};
								turn.status = "completed";
								// Exercise age retention as well as pressure, with a coherent old turn.
								turn.created_at = "2019-12-31T00:00:00.000Z";
								turn.started_at = turn.created_at;
								turn.prompt.created_at = turn.created_at;
								turn.updated_at = "2020-01-01T00:00:00.000Z";
								turn.completed_at = turn.updated_at;
								turn.final_response = {
									text: "R1 runtime terminal answer",
									format: "markdown",
									source: "runtime",
									artifact_path: null,
									truncated: false,
								};
								turn.terminal_fence = {
									epoch: transaction.revision + 1,
									status: "completed",
									reason: null,
									at: turn.updated_at,
								};
								receipt.phase = "completed";
								receipt.created_at = turn.created_at;
								receipt.updated_at = turn.updated_at;
								transaction.canonical.queue = {
									active_turn_id: null,
									ordered_turn_ids: [],
									selected_promotion: null,
								};
								transaction.canonical.desired_session_state = "completed";
								expect(transaction.requests.operations).toEqual({});
								expect(transaction.canonical.reports).toEqual({});
							});
							await patchSessionState(f.server, f.root, sessionId, {
								state: "completed",
								current_turn_id: turnId,
								last_turn_id: turnId,
								ready_for_input: false,
								source: "agent_session_event",
								live: false,
								updated_at: new Date().toISOString(),
								final_response: {
									text: "R1 runtime terminal answer",
									format: "markdown",
									source: "runtime",
									artifact_path: null,
									truncated: false,
								},
							});
							expect(
								await f.server.callTool("gjc_coordinator_read_turn", {
									session_id: sessionId,
									turn_id: turnId,
								}),
							).toMatchObject({ ok: true, turn: { turn_id: turnId, status: "completed" } });
							interrupted = false;
							const successor = hasSuccessor
								? await f.server.callTool("gjc_coordinator_send_prompt", {
										session_id: sessionId,
										prompt: "R1 successor",
										idempotency_key: "R1-successor",
										allow_mutation: true,
									})
								: null;
							if (successor) expect(successor).toMatchObject({ ok: true });
							const before = await readSessionTransaction(paths, sessionId);
							const fence = before?.canonical.turns[turnId]?.terminal_fence;
							const source = before?.canonical.turns[turnId];
							if (!source) throw new Error("R1 missing pinned source turn");
							const fillerIds = [
								"turn-00000000-0000-4000-8000-000000000001",
								"turn-00000000-0000-4000-8000-000000000002",
							];
							const pressure = async (removePin: boolean) =>
								await withSessionTransaction(paths, sessionId, async transaction => {
									if (removePin) delete transaction.requests.prompts[promptKey]!.delegate_response_pending;
									for (const id of fillerIds)
										transaction.canonical.turns[id] = {
											...structuredClone(source),
											turn_id: id,
											runtime_provenance: null,
											question_ids: [],
											updated_at: "2021-01-01T00:00:00.000Z",
											prompt: { ...source.prompt, text: "x".repeat(600 * 1024) },
										};
									// withSessionTransaction invokes the real size compactor and history
									// archive writer on exit; no test-side deletion of the source records.
									expect(Buffer.byteLength(JSON.stringify(transaction))).toBeGreaterThan(1024 * 1024);
								});
							await pressure(archivedWithoutPin);
							const compacted = await readSessionTransaction(paths, sessionId);
							const incarnation = before?.endpoint?.incarnation;
							if (!incarnation) throw new Error("R1 missing endpoint incarnation");
							const historyPath = path.join(
								path.dirname(transactionPath(paths, sessionId)),
								`history.${incarnation.replace(/[^A-Za-z0-9._-]/g, "_")}.v1.json`,
							);
							const history = await Bun.file(historyPath).json();
							expect(history).toMatchObject({ session_id: sessionId, endpoint_incarnation: incarnation });
							expect(fillerIds.some(id => history.turns[id] && !compacted?.canonical.turns[id])).toBe(true);
							if (archivedWithoutPin) {
								expect(compacted?.canonical.turns[turnId]).toBeUndefined();
								expect(compacted?.requests.prompts[promptKey]).toBeUndefined();
								expect(history.turns[turnId]).toMatchObject({ turn_id: turnId, terminal_fence: fence });
								expect(history.prompts[promptKey]).toMatchObject({
									request_digest: prompt.request_digest,
									runtime_receipt: prompt.runtime_receipt,
								});
							} else {
								expect(compacted?.canonical.turns[turnId]).toMatchObject({ terminal_fence: fence });
								expect(compacted?.requests.prompts[promptKey]).toMatchObject({
									delegate_response_pending: true,
									runtime_receipt: prompt.runtime_receipt,
								});
								expect(history.turns[turnId]).toBeUndefined();
							}
							const dispatches = f.controls.filter(control => control.operation.startsWith("turn.")).length;
							const restarted = await f.open();
							const recovered = await restarted.callTool("gjc_delegate_execute", request);
							if (archivedWithoutPin) {
								expect(recovered).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
								const unsealed = await Bun.file(file).json();
								expect(unsealed.state).toBe("in_progress");
								expect(unsealed.response).toBeUndefined();
							} else {
								expect(recovered).toMatchObject({
									ok: true,
									turn_id: turnId,
									completion: {
										ok: true,
										turn: {
											turn_id: turnId,
											status: "completed",
											final_response: { text: "R1 runtime terminal answer" },
										},
									},
								});
								expect(await Bun.file(file).json()).toMatchObject({ state: "completed", response: recovered });
								const finalized = await readSessionTransaction(paths, sessionId);
								expect(finalized?.requests.prompts[promptKey]?.delegate_response_pending).not.toBe(true);
								// Once the final snapshot is durable, real compaction may archive
								// its source; replay must still return exactly that committed snapshot.
								await pressure(false);
								expect((await Bun.file(historyPath).json()).turns[turnId]).toMatchObject({
									terminal_fence: fence,
								});
							}
							expect(await restarted.callTool("gjc_delegate_execute", request)).toEqual(recovered);
							const after = await readSessionTransaction(paths, sessionId);
							expect(after?.canonical.queue).toEqual(before?.canonical.queue);
							if (successor)
								expect(after?.canonical.turns[String(successor.turn_id)]).toMatchObject({
									turn_id: successor.turn_id,
									status: "active",
									terminal_fence: before?.canonical.turns[String(successor.turn_id)]?.terminal_fence,
									delivery: {
										runtime_command_id:
											before?.canonical.turns[String(successor.turn_id)]?.delivery.runtime_command_id,
										runtime_turn_id:
											before?.canonical.turns[String(successor.turn_id)]?.delivery.runtime_turn_id,
									},
								});
							expect(f.controls.filter(control => control.operation.startsWith("turn."))).toHaveLength(
								dispatches,
							);
							expect(f.controls.filter(control => control.operation === "session.create")).toHaveLength(0);
						}, 15000);
					}
				}
			}
		}

		for (const mode of ["prompt", "force", "queue"] as const) {
			for (const recovery of ["accepted", "projected", "admission"] as const) {
				it(`preserves a successor during ${mode}/${recovery} recovery`, async () => {
					let savedAdmission: Record<string, unknown> | undefined;
					const f = await fixture(true, {
						afterDelegateAdmission: async () => {
							savedAdmission = (await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json()).admission;
						},
					});
					const request = { ...f.request, ...(mode === "prompt" ? {} : { [mode]: true }) };
					const first = await f.server.callTool("gjc_delegate_execute", request);
					expect(first).toMatchObject({ ok: true });
					expect(
						await f.server.callTool("gjc_coordinator_report_status", {
							session_id: first.session_id,
							turn_id: first.turn_id,
							status: "completed",
							summary: "original turn finished",
							idempotency_key: "finish-original",
							allow_mutation: true,
						}),
					).toMatchObject({ ok: true });
					const successor = await f.server.callTool("gjc_coordinator_send_prompt", {
						session_id: first.session_id,
						prompt: "successor must survive",
						idempotency_key: "successor",
						allow_mutation: true,
					});
					expect(successor).toMatchObject({ ok: true });
					const successorTurnId = successor.turn_id;
					if (typeof successorTurnId !== "string") throw new Error("missing successor turn id");
					const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
					const sessionId = String(first.session_id);
					const before = await withSessionTransaction(paths, sessionId, async transaction => {
						const prompt = Object.values(transaction.requests.prompts).find(
							candidate => candidate.coordinator_turn_id === first.turn_id,
						);
						if (!prompt) throw new Error("missing original prompt receipt");
						const turn = transaction.canonical.turns[String(first.turn_id)];
						expect(turn?.terminal_fence).not.toBeNull();
						if (recovery === "accepted") prompt.phase = "accepted";
						return {
							successor: transaction.canonical.turns[String(successor.turn_id)],
							queue: transaction.canonical.queue,
						};
					});
					const file = receiptPath(f.root, f.request.idempotency_key);
					const outer = await Bun.file(file).json();
					delete outer.response;
					delete outer.completed_at;
					delete outer.admission;
					if (recovery === "admission") outer.admission = savedAdmission;
					outer.state = "in_progress";
					await Bun.write(file, JSON.stringify(outer));
					// The fixture records session.list discovery alongside mutation controls.
					// Recovery may revalidate the endpoint, but must not add any lifecycle
					// dispatch or change its original payload/idempotency identity.
					const dispatched = structuredClone(lifecycleControls(f.controls));
					const recovered = await f.server.callTool("gjc_delegate_execute", request);
					expect(recovered).toMatchObject({
						ok: true,
						turn_id: first.turn_id,
						completion: { ok: true, turn: { turn_id: first.turn_id, status: "completed" } },
					});
					const after = await withSessionTransaction(paths, sessionId, async transaction => ({
						successor: transaction.canonical.turns[String(successor.turn_id)],
						queue: transaction.canonical.queue,
					}));
					expect(after).toMatchObject({
						successor: {
							turn_id: successor.turn_id,
							status: "active",
							terminal_fence: null,
							delivery: {
								runtime_command_id: before.successor?.delivery.runtime_command_id,
								runtime_turn_id: before.successor?.delivery.runtime_turn_id,
							},
						},
						queue: before.queue,
					});
					expect(after.queue.active_turn_id).toBe(successorTurnId);
					expect(lifecycleControls(f.controls)).toEqual(dispatched);
					expect(await f.server.callTool("gjc_delegate_execute", request)).toEqual(recovered);
					expect(lifecycleControls(f.controls)).toEqual(dispatched);
				}, 15000);
			}
		}

		for (const reused of [false, true]) {
			it(`recovers a real ${reused ? "reused" : "new"} outer receipt write failure`, async () => {
				let obstruct = true;
				const f = await fixture(reused, {
					beforeDelegateResponseCommit: async () => {
						if (!obstruct) return;
						const file = receiptPath(f.root, f.request.idempotency_key);
						await fs.rename(file, `${file}.saved`);
						await fs.mkdir(file);
					},
				});
				const file = receiptPath(f.root, f.request.idempotency_key);
				try {
					expect(await f.server.callTool("gjc_delegate_execute", f.request)).toMatchObject({ ok: false });
					expect(await Bun.file(`${file}.saved`).json()).toMatchObject({
						state: "in_progress",
						admission: { kind: "delegate_admission" },
					});
				} finally {
					obstruct = false;
					await fs.rmdir(file);
					await fs.rename(`${file}.saved`, file);
				}
				const fresh = await f.open();
				const recovered = await fresh.callTool("gjc_delegate_execute", f.request);
				expect(recovered).toMatchObject({ ok: true, completion: { reason: "timeout" } });
				expect(await fresh.callTool("gjc_delegate_execute", f.request)).toEqual(recovered);
				expect(f.controls.filter(control => control.operation === "session.create")).toHaveLength(reused ? 0 : 1);
				expect(f.controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
			}, 15000);
		}

		it("releases a committed delegate pin after restart even when mutation authorization is revoked", async () => {
			let interrupt = true;
			const f = await fixture(true, {
				afterDelegateResponseCommit: () => {
					if (interrupt) throw new Error("injected post-commit crash");
				},
			});
			const first = await f.server.callTool("gjc_delegate_execute", f.request);
			expect(first).toMatchObject({ ok: false });
			const outer = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
			const promptKey = String(outer.delegate_response_pin.prompt_key_digest);
			expect(outer).toMatchObject({
				state: "completed",
				delegate_response_pin: {
					session_id: "visible-session",
					coordinator_turn_id: expect.any(String),
					prompt_key_digest: expect.any(String),
					runtime_command_id: expect.any(String),
					runtime_turn_id: expect.any(String),
				},
			});
			const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
			const interruptedTransaction = await readSessionTransaction(paths, "visible-session");
			expect(Object.keys(interruptedTransaction?.requests.prompts ?? {})).toContain(promptKey);
			expect(interruptedTransaction?.requests.prompts[promptKey]).toMatchObject({
				delegate_response_pending: true,
			});
			interrupt = false;
			const restarted = await f.open({ mutations: "questions,reports" });
			expect(restarted.config.mutationClasses.has("sessions")).toBe(false);
			expect(await restarted.callTool("gjc_coordinator_read_coordination_status")).toMatchObject({ ok: true });
			expect(
				(await readSessionTransaction(paths, "visible-session"))?.requests.prompts[promptKey]
					?.delegate_response_pending,
			).not.toBe(true);
			expect(await restarted.callTool("gjc_delegate_execute", f.request)).toMatchObject({
				ok: false,
				error: { code: "unavailable" },
			});
		}, 15000);

		it("releases a delegate pin from internal identity when the public response is truncated", async () => {
			const f = await fixture(true);
			const first = await f.server.callTool("gjc_delegate_execute", f.request);
			expect(first).toMatchObject({ ok: true });
			const file = receiptPath(f.root, f.request.idempotency_key);
			const outer = await Bun.file(file).json();
			const pin = outer.delegate_response_pin as Record<string, unknown>;
			const promptKey = String(pin.prompt_key_digest);
			const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
			await withSessionTransaction(paths, "visible-session", async transaction => {
				transaction.requests.prompts[promptKey]!.delegate_response_pending = true;
			});
			outer.response.result = "[truncated]";
			await Bun.write(file, `${JSON.stringify(outer)}\n`);
			const restarted = await f.open();
			expect(await restarted.callTool("gjc_coordinator_read_coordination_status")).toMatchObject({ ok: true });
			expect(
				(await readSessionTransaction(paths, "visible-session"))?.requests.prompts[promptKey]
					?.delegate_response_pending,
			).not.toBe(true);
		}, 15000);

		it("leaves the delegate response unsealed when its admission pin disappears before commit", async () => {
			let tamper = true;
			const f = await fixture(true, {
				beforeDelegateResponseCommit: async () => {
					if (!tamper) return;
					const file = receiptPath(f.root, f.request.idempotency_key);
					const outer = await Bun.file(file).json();
					delete outer.delegate_response_pin;
					await Bun.write(file, `${JSON.stringify(outer)}\n`);
				},
			});
			expect(await f.server.callTool("gjc_delegate_execute", f.request)).toMatchObject({ ok: false });
			const outer = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
			expect(outer).toMatchObject({ state: "in_progress", admission: { kind: "delegate_admission" } });
			expect(outer.response).toBeUndefined();
			expect(outer.completed_at).toBeUndefined();
			tamper = false;
		}, 15000);

		it("continues past one corrupt pin receipt and retries it on the next call", async () => {
			const f = await fixture(true);
			const first = await f.server.callTool("gjc_delegate_execute", f.request);
			expect(first).toMatchObject({ ok: true });
			const secondRequest = {
				...f.request,
				task: "second durable delegated task",
				idempotency_key: "delegate-recovery-second",
				force: true,
				await_completion: false,
			};
			const second = await f.server.callTool("gjc_delegate_execute", secondRequest);
			expect(second).toMatchObject({ ok: true });
			const firstFile = receiptPath(f.root, f.request.idempotency_key);
			const secondFile = receiptPath(f.root, secondRequest.idempotency_key);
			const firstOuter = await Bun.file(firstFile).json();
			const secondOuter = await Bun.file(secondFile).json();
			const firstPromptKey = String(firstOuter.delegate_response_pin.prompt_key_digest);
			const secondPromptKey = String(secondOuter.delegate_response_pin.prompt_key_digest);
			const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
			await withSessionTransaction(paths, "visible-session", async transaction => {
				transaction.requests.prompts[firstPromptKey]!.delegate_response_pending = true;
				transaction.requests.prompts[secondPromptKey]!.delegate_response_pending = true;
			});
			await Bun.write(firstFile, "{");
			const restarted = await f.open();
			expect(await restarted.callTool("gjc_coordinator_read_coordination_status")).toMatchObject({ ok: true });
			const afterPartialRecovery = await readSessionTransaction(paths, "visible-session");
			expect(afterPartialRecovery?.requests.prompts[firstPromptKey]?.delegate_response_pending).toBe(true);
			expect(afterPartialRecovery?.requests.prompts[secondPromptKey]?.delegate_response_pending).not.toBe(true);
			await Bun.write(firstFile, `${JSON.stringify(firstOuter)}\n`);
			expect(await restarted.callTool("gjc_coordinator_read_coordination_status")).toMatchObject({ ok: true });
			expect(
				(await readSessionTransaction(paths, "visible-session"))?.requests.prompts[firstPromptKey]
					?.delegate_response_pending,
			).not.toBe(true);
		}, 15000);

		it("retries a same-process pin cleanup failure on the next unrelated read", async () => {
			let failRecovery = false;
			let transactionSource = "";
			const f = await fixture(true, {
				beforeDelegatePinRecovery: () => {
					if (failRecovery) throw new Error("injected pin recovery failure");
				},
				afterDelegateResponseCommit: async () => {
					failRecovery = true;
					const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
					transactionSource = await Bun.file(transactionPath(paths, "visible-session")).text();
					await Bun.write(transactionPath(paths, "visible-session"), "{");
				},
			});
			const first = await f.server.callTool("gjc_delegate_execute", f.request);
			expect(first).toMatchObject({ ok: true });
			const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
			const outer = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
			const promptKey = String(outer.delegate_response_pin.prompt_key_digest);
			const corrupted = await Bun.file(transactionPath(paths, "visible-session")).text();
			expect(corrupted).toBe("{");
			await Bun.write(transactionPath(paths, "visible-session"), transactionSource);
			expect(await f.server.callTool("gjc_coordinator_read_coordination_status")).toMatchObject({ ok: true });
			expect(
				(await readSessionTransaction(paths, "visible-session"))?.requests.prompts[promptKey]
					?.delegate_response_pending,
			).toBe(true);
			failRecovery = false;
			expect(await f.server.callTool("gjc_coordinator_read_coordination_status")).toMatchObject({ ok: true });
			expect(
				(await readSessionTransaction(paths, "visible-session"))?.requests.prompts[promptKey]
					?.delegate_response_pending,
			).not.toBe(true);
		}, 15000);

		for (const reused of [false, true]) {
			it(`singleflights ${reused ? "reused" : "new"} observation and rejects conflicting requests`, async () => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let held = false;
				const f = await fixture(reused, {}, async query => {
					if (query === "context.get" && !held) {
						held = true;
						entered.resolve();
						await release.promise;
					}
					return {
						ok: true,
						page: {
							items: query === "context.get" ? [{ isStreaming: true }] : [],
							complete: true,
							revision: "singleflight",
						},
					};
				});
				const first = f.server.callTool("gjc_delegate_execute", f.request);
				let joined: Promise<Record<string, unknown>> | undefined;
				try {
					await Promise.race([
						entered.promise,
						first.then(() => {
							throw new Error("missing observation barrier");
						}),
					]);
					joined = f.server.callTool("gjc_delegate_execute", f.request);
					expect(
						await f.server.callTool("gjc_delegate_execute", { ...f.request, task: "conflict" }),
					).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
				} finally {
					release.resolve();
					await Promise.allSettled([first, ...(joined ? [joined] : [])]);
				}
				expect(await joined).toEqual(await first);
				expect(await first).toMatchObject({ ok: true, completion: { reason: "timeout" } });
				expect(f.controls.filter(control => control.operation === "session.create")).toHaveLength(reused ? 0 : 1);
				expect(f.controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
			}, 15000);
		}

		for (const reused of [false, true]) {
			for (const stage of ["before", "after"] as const) {
				it(`recovers ${reused ? "reused" : "new"} response loss ${stage} final commit`, async () => {
					let interrupt = true;
					const fail = () => {
						if (interrupt) throw new Error("injected final persistence boundary failure");
					};
					const f = await fixture(
						reused,
						stage === "before" ? { beforeDelegateResponseCommit: fail } : { afterDelegateResponseCommit: fail },
					);
					expect(await f.server.callTool("gjc_delegate_execute", f.request)).toMatchObject({ ok: false });
					const outer = await Bun.file(receiptPath(f.root, f.request.idempotency_key)).json();
					expect(outer.state).toBe(stage === "before" ? "in_progress" : "completed");
					if (stage === "before") {
						expect(outer.response).toBeUndefined();
						expect(outer.admission).toMatchObject({ kind: "delegate_admission" });
					} else expect(outer.response).toMatchObject({ completion: { reason: "timeout" } });
					const sessionId = String((outer.admission?.response ?? outer.response).session_id);
					const paths = coordinatorStatePaths(f.server.config.stateRoot, f.server.config.namespace.identity);
					const pinned = await readSessionTransaction(paths, sessionId);
					expect(
						Object.values(pinned!.requests.prompts).find(
							candidate => candidate.sdk_idempotency_key === f.request.idempotency_key,
						),
					).toMatchObject({ delegate_response_pending: true });
					interrupt = false;
					const fresh = await f.open();
					const replay = await fresh.callTool("gjc_delegate_execute", f.request);
					expect(replay).toMatchObject({ ok: true, completion: { reason: "timeout" } });
					if (stage === "after") expect(replay).toEqual(outer.response);
					const cleaned = await readSessionTransaction(paths, sessionId);
					expect(
						Object.values(cleaned!.requests.prompts).find(
							candidate => candidate.sdk_idempotency_key === f.request.idempotency_key,
						)?.delegate_response_pending,
					).not.toBe(true);
					expect(await fresh.callTool("gjc_delegate_execute", f.request)).toEqual(replay);
					expect(f.controls.filter(control => control.operation === "session.create")).toHaveLength(
						reused ? 0 : 1,
					);
					expect(f.controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
				}, 15000);
			}
		}
	});

	it("returns immediately by default and exposes bounded delegation completion when requested", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const immediate = await server.callTool("gjc_delegate_plan", {
			cwd: root,
			task: "immediate",
			idempotency_key: "immediate",
			allow_mutation: true,
		});
		expect(immediate).toMatchObject({ ok: true, delivered: true, turn: { status: "active" } });
		expect(immediate.completion).toBeUndefined();
		const awaited = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "timeout",
			idempotency_key: "timeout",
			allow_mutation: true,
			await_completion: true,
			timeout_ms: 10,
			poll_interval_ms: 10,
			lines: 3,
		});
		expect(awaited).toMatchObject({
			ok: true,
			completion: { ok: false, reason: "timeout", turn: { status: "active" } },
		});
	});

	it("rejects missing caller idempotency keys without invoking the SDK", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "work",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "visible-session",
				question_id: "ask-1",
				answer: "yes",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(lifecycleControls(controls)).toEqual([]);
	});

	it("returns SDK failures rather than falling back outside SDK control", async () => {
		const root = await tempRoot();
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		await registerSdkSession(server, root);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "work",
				idempotency_key: "key-1",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	it("keeps coordinator metadata reports and event journals available without turning them into control authority", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const creationPaths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const creationTransaction = await withSessionTransaction(
			creationPaths,
			"visible-session",
			async transaction => transaction,
		);
		expect(Object.values(creationTransaction.outbox)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "session.registered", entity_id: "visible-session" }),
			]),
		);
		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			status: "blocked",
			summary: "Awaiting SDK turn completion.",
			idempotency_key: "report-1",
			allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, report: { status: "blocked", session_id: "visible-session" } });
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as Array<{ kind: string }>).map(event => event.kind)).toEqual([
			"session.state_changed",
			"session.registered",
			"report.written",
		]);
		expect(lifecycleControls(controls)).toEqual([]);
	});
	it("delivers the same journal row to the opt-in webhook and over MCP with the same id", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const posts: Array<{ body: string; token: string | null }> = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			eventWebhookEnv: { GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test/hook" },
			eventWebhookDelivery: {
				post: async (body, options) => {
					posts.push({ body, token: options.token });
					return { ok: true, status: 200, error: null };
				},
				sleep: async () => {},
				now: () => Date.now(),
			},
		});
		await registerSdkSession(server, root);
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			status: "blocked",
			summary: "Awaiting SDK turn completion.",
			idempotency_key: "report-webhook-1",
			allow_mutation: true,
		});
		const namespace = coordinatorNamespace(root);
		await awaitEventWebhookDeliveriesForTest(namespace);
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		const journalRows = events.events as Array<Record<string, unknown>>;
		expect(journalRows.map(row => row.kind)).toEqual([
			"session.state_changed",
			"session.registered",
			"report.written",
		]);
		const delivered = posts.map(post => JSON.parse(post.body) as Record<string, unknown>);
		expect(delivered.map(row => row.id)).toEqual(journalRows.map(row => row.id));
		expect(delivered.map(row => row.seq)).toEqual(journalRows.map(row => row.seq));
		// One POST per row, same logical body, no token by default.
		expect(posts).toHaveLength(3);
		expect(posts.every(post => post.token === null)).toBe(true);
	});
	it("replays committed journal rows after restart and repairs an interrupted outbox publication", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const firstPosts: string[] = [];
		const webhookEnv = { GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "https://sink.example.test/hook" };
		const firstServer = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			eventWebhookEnv: webhookEnv,
			eventWebhookDelivery: {
				post: async body => {
					firstPosts.push(body);
					return { ok: true, status: 200, error: null };
				},
				sleep: async () => {},
				now: () => Date.now(),
			},
		});
		await registerSdkSession(firstServer, root);
		await firstServer.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			status: "blocked",
			summary: "Committed before restart.",
			idempotency_key: "report-webhook-restart-1",
			allow_mutation: true,
		});
		const namespace = coordinatorNamespace(root);
		await awaitEventWebhookDeliveriesForTest(namespace);
		const journalRows = (await firstServer.callTool("gjc_coordinator_watch_events", { after_seq: 0 }))
			.events as Array<Record<string, unknown>>;
		const outboxDir = path.join(namespace, "webhook-outbox");
		const firstEventId = String(journalRows[0]!.id);
		const firstOutboxPath = path.join(outboxDir, `${createHash("sha256").update(firstEventId).digest("hex")}.json`);
		await fs.rm(outboxDir, { recursive: true, force: true });
		await fs.mkdir(outboxDir, { recursive: true });
		await fs.writeFile(firstOutboxPath, '{"schema_version":1', "utf8");

		const replayedPosts: string[] = [];
		await createSdkControlServer(root, [], [], undefined, undefined, undefined, undefined, {
			eventWebhookEnv: webhookEnv,
			eventWebhookDelivery: {
				post: async body => {
					replayedPosts.push(body);
					return { ok: true, status: 200, error: null };
				},
				sleep: async () => {},
				now: () => Date.now(),
			},
		});
		await awaitEventWebhookDeliveriesForTest(namespace);

		expect(replayedPosts.map(body => JSON.parse(body).id)).toEqual(journalRows.map(row => row.id));
		expect(JSON.parse(await fs.readFile(firstOutboxPath, "utf8"))).toMatchObject({
			event_id: firstEventId,
			status: "delivered",
		});
	});
	it("posts nothing to any webhook when no webhook is configured", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const posts: string[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			eventWebhookDelivery: {
				post: async body => {
					posts.push(body);
					return { ok: true, status: 200, error: null };
				},
				sleep: async () => {},
				now: () => Date.now(),
			},
		});
		await registerSdkSession(server, root);
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			status: "blocked",
			summary: "No webhook configured.",
			idempotency_key: "report-no-webhook-1",
			allow_mutation: true,
		});
		const namespace = coordinatorNamespace(root);
		await awaitEventWebhookDeliveriesForTest(namespace);
		expect(posts).toEqual([]);
		await expect(fs.readdir(path.join(namespace, "webhook-outbox"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as unknown[]).length).toBeGreaterThan(0);
	});
	it("disables webhook delivery instead of crashing when webhook config is invalid", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const posts: string[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			eventWebhookEnv: { GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL: "http://169.254.169.254/latest/meta-data" },
			eventWebhookDelivery: {
				post: async body => {
					posts.push(body);
					return { ok: true, status: 200, error: null };
				},
				sleep: async () => {},
				now: () => Date.now(),
			},
		});
		await registerSdkSession(server, root);
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as unknown[]).length).toBeGreaterThan(0);
		const namespace = coordinatorNamespace(root);
		await awaitEventWebhookDeliveriesForTest(namespace);
		expect(posts).toEqual([]);
		const diagnostic = await fs.readFile(path.join(namespace, "event-webhook-errors.log"), "utf8");
		expect(diagnostic).toContain("coordinator_event_webhook_url_not_allowed");
	});
	it("closes an idle ephemeral coordinator session through incarnation-bound broker lifecycle authority", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sessionFile = path.join(coordinatorNamespace(root), "sessions", "visible-session.json");
		const record = JSON.parse(await fs.readFile(sessionFile, "utf8"));
		await Bun.write(
			sessionFile,
			JSON.stringify({ ...record, ephemeral: true, created_at: new Date(Date.now() - 31 * 60_000).toISOString() }),
		);

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "visible-session",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, closed: true, session_id: "visible-session" });
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "visible-session",
					endpointGeneration: 1,
					endpointIncarnation: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
				idempotencyKey: expect.stringMatching(/^coordinator-reap:visible-session:[a-f0-9]{64}$/),
			}),
		]);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		const cleanupRegistry = JSON.parse(
			await fs.readFile(
				coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity).registry,
				"utf8",
			),
		) as {
			deletions: Record<string, { cleanup?: { turn_ids?: string[]; report_ids?: string[] } }>;
		};
		const cleanupEntry = Object.values(cleanupRegistry.deletions).find(entry => entry.cleanup !== undefined);
		expect(cleanupEntry?.cleanup?.turn_ids).toEqual(expect.any(Array));
		expect(cleanupEntry?.cleanup?.report_ids).toEqual(expect.any(Array));
	});

	it("recovers deletion after a crash between WAL unlink and cleanup progress", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sessionFile = path.join(coordinatorNamespace(root), "sessions", "visible-session.json");
		const session = JSON.parse(await fs.readFile(sessionFile, "utf8")) as Record<string, unknown>;
		await Bun.write(sessionFile, JSON.stringify({ ...session, ephemeral: true }));
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			endpoint?: { incarnation?: unknown };
			canonical: { turns: Record<string, unknown>; reports: Record<string, unknown> };
		};
		const endpointIncarnation = String(transaction.endpoint?.incarnation ?? "");
		if (!endpointIncarnation) throw new Error("missing endpoint incarnation");
		// The close admission requires no retained public delivery. Mark the
		// already-exported creation edge acknowledged, then simulate the exact
		// crash point by unlinking only the canonical WAL.
		await withSessionTransaction(paths, "visible-session", async current => {
			for (const event of Object.values(current.outbox)) {
				event.emitted = true;
				event.public_delivery.state = "acknowledged";
				event.public_delivery.journal_seq = 1;
				event.public_delivery.acknowledged_at = new Date().toISOString();
			}
		});
		const deletionId = `delete:visible-session:${endpointIncarnation}`;
		const deletionKey = createHash("sha256").update(deletionId).digest("hex");
		await admitSessionClose(paths, {
			deletion_id: deletionId,
			session_id: "visible-session",
			endpoint_incarnation: endpointIncarnation,
			operation_id: deletionId,
			key_digest: deletionKey,
			request_digest: deletionKey,
			close_key: deletionId,
			phase: "intent",
			cleanup: { wal: false, turns: false, reports: false, session: false, events: false },
			authority_digest: deletionKey,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		await advanceDeletion(paths, deletionId, "broker_closed", {
			turn_ids: Object.keys(transaction.canonical.turns),
			report_ids: Object.keys(transaction.canonical.reports),
		});
		// Simulate the crash window after the WAL unlink but before the registry
		// cleanup checkpoint. The deletion manifest is the remaining authority.
		await fs.rm(transactionPath(paths, "visible-session"));

		await expect(
			server.callTool("gjc_coordinator_stop_session", {
				session_id: "visible-session",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true, closed: true });
		const registry = JSON.parse(await fs.readFile(paths.registry, "utf8")) as {
			deletions: Record<string, { phase?: string; cleanup?: { wal?: boolean } }>;
			roster?: Record<string, unknown>;
			retained_sessions?: Record<string, unknown>;
		};
		expect(registry.deletions[deletionId]).toMatchObject({ phase: "completed", cleanup: { wal: true } });
		expect(registry.roster?.["visible-session"]).toBeUndefined();
		expect(registry.retained_sessions?.["visible-session"]).toBeUndefined();
	});

	it("completes deletion cleanup from projection ids captured before broker close", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let failNextPostCloseList = false;
		let registryPath: string | null = null;
		let manifestAtClose: { turn_ids?: string[]; report_ids?: string[] } | null = null;
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			undefined,
			[
				{
					sessionId: "visible-session",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
					endpointGeneration: 1,
					pid: 101,
					endpointMtimeMs: 1,
				},
			],
			undefined,
			undefined,
			{
				globalResult: operation => {
					if (operation === "session.close") {
						// Resolve the remote close only after the on-disk deletion manifest
						// has been snapshotted. The projection ids must already be durable
						// before the close fires so any post-close recovery sees the full
						// cleanup target list.
						return {
							// biome-ignore lint/suspicious/noThenProperty: the fixture intentionally models a thenable SDK response.
							then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
								void (async () => {
									const snapshot = JSON.parse(await fs.readFile(registryPath ?? "", "utf8")) as {
										deletions: Record<
											string,
											{ session_id?: string; cleanup?: { turn_ids?: string[]; report_ids?: string[] } }
										>;
									};
									const entry = Object.values(snapshot.deletions).find(
										candidate => candidate.session_id === "visible-session",
									);
									manifestAtClose = entry?.cleanup ?? null;
								})().then(
									() => {
										failNextPostCloseList = true;
										return onFulfilled({ ok: true, result: { sessionId: "visible-session" } });
									},
									error => {
										failNextPostCloseList = true;
										if (onRejected) return onRejected(error);
										throw error;
									},
								);
							},
						};
					}
					if (operation === "session.list" && failNextPostCloseList)
						return { ok: false, error: { code: "unavailable", message: "listing unavailable" } };
					return undefined;
				},
			},
		);
		await registerSdkSession(server, root);
		await expect(
			server.callTool("gjc_coordinator_report_status", {
				session_id: "visible-session",
				status: "blocked",
				summary: "manifest durability probe",
				idempotency_key: "reap-manifest-report",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true });
		const sessionFile = path.join(coordinatorNamespace(root), "sessions", "visible-session.json");
		const session = JSON.parse(await fs.readFile(sessionFile, "utf8")) as Record<string, unknown>;
		await Bun.write(sessionFile, JSON.stringify({ ...session, ephemeral: true }));
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		registryPath = paths.registry;
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			endpoint?: { incarnation?: unknown };
			canonical: { reports: Record<string, unknown> };
		};
		const endpointIncarnation = String(transaction.endpoint?.incarnation ?? "");
		if (!endpointIncarnation) throw new Error("missing endpoint incarnation");
		const reportIds = Object.keys(transaction.canonical.reports);
		expect(reportIds).toHaveLength(1);
		const deletionId = `delete:visible-session:${endpointIncarnation}`;

		// Crash window under repair: the broker close is checkpointed as
		// broker_closed and the process dies before any post-close checkpoint, so
		// only the manifest captured at admission can drive recovery.
		await expect(
			server.callTool("gjc_coordinator_stop_session", { session_id: "visible-session", allow_mutation: true }),
		).resolves.toMatchObject({ ok: false, reason: "close_failed" });
		expect(manifestAtClose).not.toBeNull();
		expect(manifestAtClose).toMatchObject({ turn_ids: [], report_ids: reportIds });
		const tornRegistry = JSON.parse(await fs.readFile(paths.registry, "utf8")) as {
			deletions: Record<string, { phase?: string; cleanup?: { turn_ids?: string[]; report_ids?: string[] } }>;
		};
		expect(tornRegistry.deletions[deletionId]).toMatchObject({
			phase: "broker_closed",
			cleanup: { turn_ids: [], report_ids: reportIds },
		});

		failNextPostCloseList = false;
		await expect(
			server.callTool("gjc_coordinator_stop_session", { session_id: "visible-session", allow_mutation: true }),
		).resolves.toMatchObject({ ok: true, closed: true });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(1);
		await expect(
			Bun.file(path.join(coordinatorNamespace(root), "reports", `${reportIds[0]}.json`)).exists(),
		).resolves.toBe(false);
		await expect(Bun.file(sessionFile).exists()).resolves.toBe(false);
		const registry = JSON.parse(await fs.readFile(paths.registry, "utf8")) as {
			deletions: Record<string, { phase?: string; cleanup?: { turn_ids?: string[]; report_ids?: string[] } }>;
		};
		expect(registry.deletions[deletionId]).toMatchObject({
			phase: "completed",
			cleanup: { wal: true, turns: true, reports: true, session: true, events: true, report_ids: reportIds },
		});
	});
	it("does not repeat broker close after post-close verification becomes uncertain", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let failNextPostCloseList = false;
		const server = await createSdkControlServer(root, controls, [], undefined, [], undefined, undefined, {
			globalResult: operation => {
				if (operation === "session.close") {
					failNextPostCloseList = true;
					return undefined;
				}
				if (operation === "session.list" && failNextPostCloseList) {
					failNextPostCloseList = false;
					return { ok: true, result: { sessions: "malformed" } };
				}
				return undefined;
			},
		});
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			idempotency_key: "reap-recovery-start",
			allow_mutation: true,
		});
		expect(started).toMatchObject({ ok: true, session: { session_id: "created-session-1" } });
		const sessionFile = path.join(coordinatorNamespace(root), "sessions", "created-session-1.json");
		const sessionRecord = JSON.parse(await fs.readFile(sessionFile, "utf8"));
		await Bun.write(sessionFile, JSON.stringify({ ...sessionRecord, ephemeral: true }));

		const first = await server.callTool("gjc_coordinator_stop_session", {
			session_id: "created-session-1",
			allow_mutation: true,
		});
		expect(first).toMatchObject({ ok: false, reason: "close_failed" });
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		const second = await server.callTool("gjc_coordinator_stop_session", {
			session_id: "created-session-1",
			allow_mutation: true,
		});
		expect(second).toMatchObject({ ok: true, closed: true });
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(1);
	});

	it("idle reaping selects only stale ephemeral coordinator records and uses incarnation-bound session.close", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const brokerSessions = [
			{
				sessionId: "idle-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
				pid: 202,
				endpointMtimeMs: 2,
			},
		];
		const server = await createSdkControlServer(root, controls, undefined, undefined, brokerSessions);
		await expect(
			server.callTool("gjc_coordinator_register_session", {
				session_id: "idle-session",
				cwd: root,
				idempotency_key: "register-idle",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true });
		const sessionsDir = path.join(coordinatorNamespace(root), "sessions");
		const idleFile = path.join(sessionsDir, "idle-session.json");
		const staleAt = new Date(Date.now() - 31 * 60_000).toISOString();
		const idle = JSON.parse(await fs.readFile(idleFile, "utf8"));
		await Bun.write(idleFile, JSON.stringify({ ...idle, ephemeral: true, created_at: staleAt }));
		const idlePaths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		await withSessionTransaction(idlePaths, "idle-session", async transaction => {
			const nextRevision = transaction.revision + 1;
			transaction.canonical.session.ephemeral = true;
			transaction.canonical.session.created_at = staleAt;
			transaction.canonical.session.updated_at = staleAt;
			transaction.projection.applied_turns_revision = nextRevision;
			transaction.projection.applied_reports_revision = nextRevision;
			transaction.projection.applied_session_revision = nextRevision;
			transaction.projection.applied_active_revision = nextRevision;
			transaction.projection.applied_events_revision = nextRevision;
		});
		await fs.rm(path.join(coordinatorNamespace(root), "session-states", "idle-session.json"));
		await Bun.write(
			path.join(sessionsDir, "registered-session.json"),
			JSON.stringify({
				session_id: "registered-session",
				cwd: root,
				created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
			}),
		);

		expect(await server.sessionReaper.sweepOnce()).toBe(1);
		expect(controls.filter(control => control.operation === "session.close")).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({
					sessionId: "idle-session",
					endpointGeneration: 1,
					endpointIncarnation: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
				idempotencyKey: expect.stringMatching(/^coordinator-reap:idle-session:[a-f0-9]{64}$/),
			}),
		]);
		expect(await Bun.file(idleFile).exists()).toBe(false);
		expect(await Bun.file(path.join(sessionsDir, "registered-session.json")).exists()).toBe(true);
	});
	describe("Coordinator MCP real broker lifecycle", () => {
		for (const discoveryState of [
			"no discovery",
			"dead discovery",
			"stale discovery",
			"process incarnation mismatch",
			"malformed JSON",
			"canonical-shape-invalid readable discovery",
		] as const) {
			it(`boots and lists sessions with ${discoveryState}`, async () => {
				const root = await managedFixtureRoot();
				const agentDir = path.join(root, "agent-global");
				const cleanup = createFixtureRootCleanup(root, agentDir, ownerLease(agentDir));
				try {
					if (discoveryState === "malformed JSON") {
						await fs.mkdir(path.dirname(brokerDiscoveryPath(agentDir)), { recursive: true });
						await Bun.write(brokerDiscoveryPath(agentDir), "{not-json");
					} else if (discoveryState === "canonical-shape-invalid readable discovery") {
						await fs.mkdir(path.dirname(brokerDiscoveryPath(agentDir)), { recursive: true });
						await Bun.write(
							brokerDiscoveryPath(agentDir),
							JSON.stringify({ version: 1, protocolVersion: 3, host: "127.0.0.1", pid: process.pid }),
						);
					} else if (discoveryState !== "no discovery") {
						const actualIncarnation = brokerProcessIncarnation(process.pid);
						if (!actualIncarnation) throw new Error("Test process incarnation is unavailable.");
						await writeBrokerDiscovery(agentDir, {
							version: 1,
							protocolVersion: 3,
							packageGeneration: "test",
							ownerId: "stale-owner",
							pid: discoveryState === "dead discovery" ? 2_147_483_647 : process.pid,
							incarnation:
								discoveryState === "process incarnation mismatch"
									? "mismatched-incarnation"
									: actualIncarnation,
							host: "127.0.0.1",
							port: 1,
							url: "ws://127.0.0.1:1",
							token: "stale-token",
							startedAt: Date.now() - 60_000,
							heartbeatAt: discoveryState === "stale discovery" ? Date.now() - 60_000 : Date.now(),
						});
					}

					const result = await createRealBrokerServer(root, agentDir).callTool(
						"gjc_coordinator_list_sessions",
						{},
					);
					expect(result).toMatchObject({ ok: true, sessions: [] });
					const discovery = await readBrokerDiscovery(agentDir);
					expect(discovery).not.toBeNull();
					if (!discovery) throw new Error("Broker discovery was not published after bootstrap.");
					if (discoveryState !== "no discovery") expect(discovery.token).not.toBe("stale-token");
					expect(brokerOwnerForTest(agentDir)).toBeDefined();
				} finally {
					await cleanupFixtureRoot(cleanup);
					expect(brokerOwnerForTest(agentDir)).toBeUndefined();
				}
			}, 15_000);
		}

		it("reuses a live broker discovery without replacing its identity", async () => {
			const root = await managedFixtureRoot();
			const agentDir = path.join(root, "agent-global");
			const cleanup = createFixtureRootCleanup(root, agentDir, ownerLease(agentDir));
			try {
				const started = await startFixtureBrokerWithLeaseForTest({
					agentDir,
					env: createFixtureBrokerEnvironment(root, agentDir),
				});
				cleanup.lease = started.lease;
				const owner = brokerOwnerForTest(agentDir);
				expect(owner).toBeDefined();
				const result = await createRealBrokerServer(root, agentDir).callTool("gjc_coordinator_list_sessions", {});
				expect(result).toMatchObject({ ok: true, sessions: [] });
				const reused = await readBrokerDiscovery(agentDir);
				expect(reused).toMatchObject({
					pid: started.discovery.pid,
					incarnation: started.discovery.incarnation,
					ownerId: started.discovery.ownerId,
					token: started.discovery.token,
				});
				expect(brokerOwnerForTest(agentDir)).toBe(owner);
			} finally {
				await cleanupFixtureRoot(cleanup);
				expect(brokerOwnerForTest(agentDir)).toBeUndefined();
			}
		}, 15_000);

		it("routes concurrent first calls through one canonical broker owner", async () => {
			const root = await managedFixtureRoot();
			const agentDir = path.join(root, "agent-global");
			const cleanup = createFixtureRootCleanup(root, agentDir, ownerLease(agentDir));
			try {
				const server = createRealBrokerServer(root, agentDir);
				const results = await Promise.all([
					server.callTool("gjc_coordinator_list_sessions", {}),
					server.callTool("gjc_coordinator_list_sessions", {}),
				]);
				expect(results).toEqual([
					{ ok: true, sessions: [] },
					{ ok: true, sessions: [] },
				]);
				const owner = brokerOwnerForTest(agentDir);
				expect(owner).toBeDefined();
				const discovery = await readBrokerDiscovery(agentDir);
				expect(discovery).not.toBeNull();
				await expect(server.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
					ok: true,
					sessions: [],
				});
				expect(brokerOwnerForTest(agentDir)).toBe(owner);
			} finally {
				await cleanupFixtureRoot(cleanup);
				expect(brokerOwnerForTest(agentDir)).toBeUndefined();
			}
		}, 15_000);
	});

	it("ensures before re-reading broker discovery", async () => {
		const root = await tempRoot();
		const phases: string[] = [];
		const server = createBrokerTestServer(root, {
			ensureBroker: async settings => {
				phases.push(`ensure:${settings.agentDir}`);
				return testBrokerDiscovery();
			},
			readSdkBrokerDiscovery: async agentDir => {
				phases.push(`read:${agentDir}`);
				return testBrokerDiscovery();
			},
			connectBroker: async () => {
				phases.push("connect");
				return {
					global: async () => ({ ok: true, result: { sessions: [] } }),
					close: async () => {},
				} as unknown as SdkClient;
			},
		});
		await expect(server.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
			ok: true,
			sessions: [],
		});
		expect(phases).toEqual([
			`ensure:${path.join(root, "agent-global")}`,
			`read:${path.join(root, "agent-global")}`,
			"connect",
		]);
	});

	it("routes concurrent broker operations through the canonical ensure seam", async () => {
		const root = await tempRoot();
		let starts = 0;
		let inFlight: Promise<BrokerDiscovery> | undefined;
		const server = createBrokerTestServer(root, {
			ensureBroker: async () => {
				inFlight ??= Promise.resolve().then(() => {
					starts += 1;
					return testBrokerDiscovery();
				});
				return await inFlight;
			},
			readSdkBrokerDiscovery: async () => testBrokerDiscovery(),
			connectBroker: async () =>
				({
					global: async () => ({ ok: true, result: { sessions: [] } }),
					close: async () => {},
				}) as unknown as SdkClient,
		});
		await expect(
			Promise.all([
				server.callTool("gjc_coordinator_list_sessions", {}),
				server.callTool("gjc_coordinator_list_sessions", {}),
			]),
		).resolves.toEqual([
			{ ok: true, sessions: [] },
			{ ok: true, sessions: [] },
		]);
		expect(starts).toBe(1);
	});

	it("maps injected broker failures by the explicit operational phase", async () => {
		const root = await tempRoot();
		const cases: Array<{
			stage: "ensure" | "read" | "connect" | "request";
			error: Error;
			code: string;
			message?: string;
		}> = [
			{ stage: "ensure", error: new AggregateError([new Error("token-secret")]), code: "broker_cleanup_unverified" },
			{
				stage: "ensure",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_discovery_unsupported",
			},
			{
				stage: "ensure",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_discovery_access_denied",
			},
			{
				stage: "ensure",
				error: Object.assign(new Error("secret"), { code: "EPERM" }),
				code: "broker_discovery_access_denied",
			},
			{ stage: "ensure", error: new Error("token-secret"), code: "broker_bootstrap_failed" },
			{
				stage: "read",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_discovery_unsupported",
			},
			{
				stage: "read",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_discovery_access_denied",
			},
			{
				stage: "read",
				error: Object.assign(new Error("secret"), { code: "EPERM" }),
				code: "broker_discovery_access_denied",
			},
			{
				stage: "read",
				error: new AggregateError([new Error("token-secret")]),
				code: "broker_discovery_unavailable",
			},
			{ stage: "read", error: new Error("token-secret"), code: "broker_discovery_unavailable" },
			{
				stage: "connect",
				error: new AggregateError([new Error("token-secret")]),
				code: "broker_transport_unavailable",
			},
			{
				stage: "connect",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_transport_unavailable",
			},
			{
				stage: "connect",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_transport_unavailable",
			},
			{
				stage: "connect",
				error: new SdkClientError("transport_secret", "token-secret"),
				code: "broker_transport_unavailable",
			},
			{
				stage: "request",
				error: new AggregateError([new Error("token-secret")]),
				code: "broker_request_unavailable",
			},
			{
				stage: "request",
				error: new UnsupportedStateVersionError("/secret/path", 2),
				code: "broker_request_unavailable",
			},
			{
				stage: "request",
				error: Object.assign(new Error("secret"), { code: "EACCES" }),
				code: "broker_request_unavailable",
			},
			{ stage: "request", error: new Error("token-secret"), code: "broker_request_unavailable" },
			{
				stage: "request",
				error: new SdkClientError("transport_secret", "request public message"),
				code: "unavailable",
				message: "Coordinator service is unavailable.",
			},
		];
		for (const testCase of cases) {
			const client = {
				global: async () => {
					if (testCase.stage === "request") throw testCase.error;
					return { ok: true, result: { sessions: [] } };
				},
				close: async () => {},
			} as unknown as SdkClient;
			const server = createBrokerTestServer(root, {
				ensureBroker: async () => {
					if (testCase.stage === "ensure") throw testCase.error;
					return testBrokerDiscovery();
				},
				readSdkBrokerDiscovery: async () => {
					if (testCase.stage === "read") throw testCase.error;
					return testBrokerDiscovery();
				},
				connectBroker: async () => {
					if (testCase.stage === "connect") throw testCase.error;
					return client;
				},
			});
			const result = await server.callTool("gjc_coordinator_list_sessions", {});
			expect(result).toMatchObject({ ok: false, error: { code: testCase.code } });
			if (testCase.message) expect(result).toMatchObject({ error: { message: testCase.message } });
			expect(JSON.stringify(result)).not.toContain("token-secret");
			expect(JSON.stringify(result)).not.toContain("/secret/path");
		}
		const nullServer = createBrokerTestServer(root, {
			ensureBroker: async () => testBrokerDiscovery(),
			readSdkBrokerDiscovery: async () => null,
			connectBroker: async () =>
				({ global: async () => ({ ok: true }), close: async () => {} }) as unknown as SdkClient,
		});
		await expect(nullServer.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
			ok: false,
			error: { code: "broker_unavailable", message: "SDK broker is unavailable." },
		});
	});

	it("attempts close once and preserves the primary request failure", async () => {
		const root = await tempRoot();
		for (const requestError of [
			new SdkClientError("request_failed", "request public message"),
			new Error("request-secret"),
		]) {
			let closeCalls = 0;
			const server = createBrokerTestServer(root, {
				ensureBroker: async () => testBrokerDiscovery(),
				readSdkBrokerDiscovery: async () => testBrokerDiscovery(),
				connectBroker: async () =>
					({
						global: async () => {
							throw requestError;
						},
						close: async () => {
							closeCalls += 1;
							throw new Error("close-secret");
						},
					}) as unknown as SdkClient,
			});
			const result = await server.callTool("gjc_coordinator_list_sessions", {});
			expect(result).toMatchObject({
				ok: false,
				error: {
					code: requestError instanceof SdkClientError ? "unavailable" : "broker_request_unavailable",
					message: expect.any(String),
				},
			});
			expect(closeCalls).toBe(1);
		}
		let closeCalls = 0;
		const closeFailureServer = createBrokerTestServer(root, {
			ensureBroker: async () => testBrokerDiscovery(),
			readSdkBrokerDiscovery: async () => testBrokerDiscovery(),
			connectBroker: async () =>
				({
					global: async () => ({ ok: true, result: { sessions: [] } }),
					close: async () => {
						closeCalls += 1;
						throw new SdkClientError("close_secret", "close-secret");
					},
				}) as unknown as SdkClient,
		});
		await expect(closeFailureServer.callTool("gjc_coordinator_list_sessions", {})).resolves.toMatchObject({
			ok: false,
			error: { code: "broker_transport_unavailable", message: "SDK broker transport is unavailable." },
		});
		expect(closeCalls).toBe(1);
	});
});

it("repairs one terminal session without deleting another session's projections", async () => {
	const root = await tempRoot();
	const controls: SdkControl[] = [];
	const sessions = [
		{
			sessionId: "visible-session",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
			endpointGeneration: 1,
			pid: 101,
			endpointMtimeMs: 1,
		},
		{
			sessionId: "other-session",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
			endpointGeneration: 1,
			pid: 102,
			endpointMtimeMs: 1,
		},
	];
	const server = await createSdkControlServer(root, controls, undefined, undefined, sessions);
	await registerSdkSession(server, root);
	await expect(
		server.callTool("gjc_coordinator_register_session", {
			session_id: "other-session",
			cwd: root,
			idempotency_key: "register-other",
			allow_mutation: true,
		}),
	).resolves.toMatchObject({ ok: true });
	const first = await server.callTool("gjc_coordinator_send_prompt", {
		session_id: "visible-session",
		prompt: "first",
		idempotency_key: "prompt-first-session",
		allow_mutation: true,
	});
	const second = await server.callTool("gjc_coordinator_send_prompt", {
		session_id: "other-session",
		prompt: "second",
		idempotency_key: "prompt-second-session",
		allow_mutation: true,
	});
	await expect(
		server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: first.turn_id,
			status: "completed",
			summary: "done",
			idempotency_key: "complete-first-session",
			allow_mutation: true,
		}),
	).resolves.toMatchObject({ ok: true });
	const secondTurnPath = path.join(coordinatorNamespace(root), "turns", `${String(second.turn_id)}.json`);
	await expect(fs.readFile(secondTurnPath, "utf8")).resolves.toContain("other-session");
});

function coordinatorSessionStateFile(root: string): string {
	return path.join(coordinatorNamespace(root), "session-states", "visible-session.json");
}

async function writeCoordinatorSessionState(root: string, state: string): Promise<void> {
	await Bun.write(
		coordinatorSessionStateFile(root),
		JSON.stringify({
			schema_version: 1,
			session_id: "visible-session",
			state,
			ready_for_input: state === "ready_for_input",
			current_turn_id: null,
			last_turn_id: null,
			updated_at: "2026-08-04T00:00:00.000Z",
			source: "coordinator",
			live: state === "ready_for_input" ? true : null,
			reason: null,
		}),
	);
}

async function readCoordinatorSessionState(root: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(coordinatorSessionStateFile(root), "utf8")) as Record<string, unknown>;
}

async function createActivationHarness(sessionFrameResult?: (frame: Record<string, unknown>) => unknown) {
	const root = await tempRoot();
	const controls: SdkControl[] = [];
	const frames: Array<Record<string, unknown>> = [];
	const brokerSessions: Array<Record<string, unknown>> = [
		{
			sessionId: "visible-session",
			locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
			live: true,
			endpointGeneration: 1,
			pid: 101,
			endpointMtimeMs: 1,
		},
	];
	const server = await createSdkControlServer(root, controls, [], undefined, brokerSessions, undefined, undefined, {
		sessionFrames: frames,
		...(sessionFrameResult ? { sessionFrameResult } : {}),
	});
	await expect(registerSdkSession(server, root)).resolves.toMatchObject({
		ok: true,
		session_state: { state: "ready_for_input" },
	});
	controls.length = 0;
	return { server, root, controls, frames, brokerSessions };
}

async function callActivate(
	server: { callTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> },
	idempotencyKey: string,
): Promise<Record<string, unknown>> {
	return await server.callTool("gjc_coordinator_activate_session", {
		session_id: "visible-session",
		idempotency_key: idempotencyKey,
		allow_mutation: true,
	});
}

describe("Coordinator MCP prepared session activation", () => {
	it("activates a prepared session against its exact endpoint generation", async () => {
		const { server, root, frames } = await createActivationHarness();
		await writeCoordinatorSessionState(root, "prepared");

		const response = await callActivate(server, "activate-prepared-1");

		expect(response).toMatchObject({
			ok: true,
			session_id: "visible-session",
			status: "activated",
			state: "ready_for_input",
			endpoint_generation: 1,
		});
		expect(frames).toEqual([{ type: "session_activate", sessionId: "visible-session", endpointGeneration: 1 }]);
		await expect(readCoordinatorSessionState(root)).resolves.toMatchObject({
			state: "ready_for_input",
			live: true,
		});
	});

	it("refuses a prepared session whose durable state went stale and sends no activation frame", async () => {
		const { server, root, frames } = await createActivationHarness();
		await writeCoordinatorSessionState(root, "prepared");
		await writeCoordinatorSessionState(root, "stale");

		const response = await callActivate(server, "activate-stale-1");

		expect(response).toMatchObject({
			ok: false,
			session_id: "visible-session",
			state: "stale",
			error: { code: "session_not_activatable" },
			session_state: { state: "stale" },
		});
		expect(response.status).toBeUndefined();
		expect(frames).toEqual([]);
		await expect(readCoordinatorSessionState(root)).resolves.toMatchObject({ state: "stale" });
	});

	for (const state of ["booting", "running", "needs_user_input", "completed", "errored", "unknown"]) {
		it(`never reports durable state ${state} as already activated`, async () => {
			const { server, root, frames } = await createActivationHarness();
			await writeCoordinatorSessionState(root, state);

			const response = await callActivate(server, `activate-${state}-1`);

			expect(response).toMatchObject({
				ok: false,
				session_id: "visible-session",
				state,
				error: { code: "session_not_activatable" },
			});
			expect(response.status).toBeUndefined();
			expect(frames).toEqual([]);
			await expect(readCoordinatorSessionState(root)).resolves.toMatchObject({ state });
		});
	}

	it("refuses activation when the session has no durable state at all", async () => {
		const { server, root, frames } = await createActivationHarness();
		await fs.rm(coordinatorSessionStateFile(root), { force: true });

		const response = await callActivate(server, "activate-absent-1");

		expect(response).toMatchObject({
			ok: false,
			session_id: "visible-session",
			state: "unknown",
			session_state: null,
			error: { code: "session_not_activatable" },
		});
		expect(response.status).toBeUndefined();
		expect(frames).toEqual([]);
	});

	it("answers already for a ready session only from a corroborated host response", async () => {
		const { server, root, frames } = await createActivationHarness(frame => ({
			type: "session_activate_result",
			id: "activate-ready",
			ok: true,
			status: "already",
			sessionId: frame.sessionId,
			generation: frame.endpointGeneration,
		}));
		const before = await readCoordinatorSessionState(root);

		const response = await callActivate(server, "activate-ready-1");

		expect(response).toMatchObject({
			ok: true,
			session_id: "visible-session",
			status: "already",
			state: "ready_for_input",
			endpoint_generation: 1,
		});
		expect(frames).toEqual([{ type: "session_activate", sessionId: "visible-session", endpointGeneration: 1 }]);
		// A corroborated `already` transitions nothing, so durable state is untouched.
		await expect(readCoordinatorSessionState(root)).resolves.toEqual(before);
	});

	it("fails a ready session whose broker authority is stale instead of answering already", async () => {
		const { server, brokerSessions, frames } = await createActivationHarness();
		brokerSessions[0]!.endpointGeneration = 2;

		const response = await callActivate(server, "activate-rolled-1");

		expect(response).toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		expect(response.status).toBeUndefined();
		expect(frames).toEqual([]);
	});

	it("keeps an unobserved activation retryable under the same key", async () => {
		let answer: (frame: Record<string, unknown>) => unknown = () => {
			throw new SdkClientError("unavailable", "SDK request failed");
		};
		const { server, root, frames } = await createActivationHarness(frame => answer(frame));
		await writeCoordinatorSessionState(root, "prepared");

		const unobserved = await callActivate(server, "activate-retry-1");
		expect(unobserved).toMatchObject({ ok: false, error: { code: "activation_outcome_unknown" } });
		await expect(readCoordinatorSessionState(root)).resolves.toMatchObject({ state: "prepared" });

		answer = frame => ({
			type: "session_activate_result",
			id: "activate-retry",
			ok: true,
			status: "already",
			sessionId: frame.sessionId,
			generation: frame.endpointGeneration,
		});
		const settled = await callActivate(server, "activate-retry-1");

		expect(settled).toMatchObject({ ok: true, status: "already", state: "ready_for_input" });
		expect(frames).toHaveLength(2);
		await expect(readCoordinatorSessionState(root)).resolves.toMatchObject({ state: "ready_for_input" });
	});

	it("leaves a session prepared when its own activation gate refuses", async () => {
		const { server, root, frames } = await createActivationHarness(() => {
			throw new SdkClientError("not_authorized", "The session has no binding at this generation.");
		});
		await writeCoordinatorSessionState(root, "prepared");

		const response = await callActivate(server, "activate-refused-1");

		expect(response).toMatchObject({ ok: false, state: "prepared", error: { code: "not_bound" } });
		expect(frames).toHaveLength(1);
		await expect(readCoordinatorSessionState(root)).resolves.toMatchObject({ state: "prepared" });
	});

	it("replays an exact activation key without a second activation frame", async () => {
		const { server, root, frames } = await createActivationHarness();
		await writeCoordinatorSessionState(root, "prepared");

		const first = await callActivate(server, "activate-replay-1");
		const replay = await callActivate(server, "activate-replay-1");

		expect(first).toMatchObject({ ok: true, status: "activated", state: "ready_for_input" });
		expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
		expect(frames).toHaveLength(1);
	});
	it("emits one bounded question.opened event and records its Codex wake", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "unbound";
		const server = await createSdkControlServer(root, controls, [], query =>
			query === "Q12"
				? {
						ok: true,
						page: { items: [sharedAskGate("gate-opened", runtimeTurnId)], complete: true, revision: "opened-r1" },
					}
				: { ok: true, page: { items: [], complete: true, revision: "context" } },
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "gate prompt text must not enter the event",
			idempotency_key: "opened-prompt",
			allow_mutation: true,
		});
		const runtimeAcknowledgement = sent.result as { turn_id?: unknown };
		if (typeof runtimeAcknowledgement.turn_id !== "string") throw new Error("missing runtime turn id");
		runtimeTurnId = runtimeAcknowledgement.turn_id;
		await expect(
			server.callTool("gjc_coordinator_register_codex_handoff", {
				session_id: "visible-session",
				thread_id: "thread-opened",
				endpoint: { kind: "unix", path: "/tmp/question-opened.sock" },
				idempotency_key: "opened-handoff",
				allow_mutation: true,
			}),
		).resolves.toMatchObject({ ok: true });

		const first = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const question = (first.questions as Array<Record<string, unknown>>)[0]!;
		const journal = path.join(coordinatorNamespace(root), "events", "event-journal.jsonl");
		const opened = (await fs.readFile(journal, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.filter(event => event.kind === "question.opened" && event.question_id === "gate-opened");
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatchObject({
			session_id: "visible-session",
			turn_id: question.turn_id,
			question_id: "gate-opened",
		});
		expect(String(opened[0]?.summary)).not.toContain("gate prompt text must not enter the event");
		await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const openedAfterReplay = (await fs.readFile(journal, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.filter(event => event.kind === "question.opened" && event.question_id === "gate-opened");
		expect(openedAfterReplay).toHaveLength(1);
		expect(
			JSON.parse(
				await fs.readFile(
					path.join(coordinatorNamespace(root), "codex-wake-events", `visible-session__${opened[0]?.seq}.json`),
					"utf8",
				),
			),
		).toMatchObject({ event_kind: "question.opened", question_id: "gate-opened" });
	});
});

it("keeps parallel pending questions isolated when one answer is submitted", async () => {
	const rootA = await tempRoot();
	const rootB = await tempRoot();
	const controlsA: SdkControl[] = [];
	const controlsB: SdkControl[] = [];
	let runtimeTurnA = "unbound";
	let runtimeTurnB = "unbound";
	const serverA = await createSdkControlServer(
		rootA,
		controlsA,
		[],
		query =>
			query === "Q12"
				? {
						ok: true,
						page: { items: [sharedAskGate("gate-isolated-a", runtimeTurnA)], complete: true, revision: "a-r1" },
					}
				: { ok: true, page: { items: [], complete: true, revision: "context" } },
		undefined,
		undefined,
		undefined,
		{ controlResult: control => (control.operation === "workflow.gate_answer" ? { status: "accepted" } : undefined) },
	);
	const serverB = await createSdkControlServer(rootB, controlsB, [], query =>
		query === "Q12"
			? {
					ok: true,
					page: { items: [sharedAskGate("gate-isolated-b", runtimeTurnB)], complete: true, revision: "b-r1" },
				}
			: { ok: true, page: { items: [], complete: true, revision: "context" } },
	);
	await Promise.all([registerSdkSession(serverA, rootA), registerSdkSession(serverB, rootB)]);
	const [sentA, sentB] = await Promise.all([
		serverA.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "open A",
			idempotency_key: "isolation-prompt-a",
			allow_mutation: true,
		}),
		serverB.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "open B",
			idempotency_key: "isolation-prompt-b",
			allow_mutation: true,
		}),
	]);
	const acknowledgementA = sentA.result as { turn_id?: unknown };
	const acknowledgementB = sentB.result as { turn_id?: unknown };
	if (typeof acknowledgementA.turn_id !== "string" || typeof acknowledgementB.turn_id !== "string")
		throw new Error("missing runtime turn id");
	runtimeTurnA = acknowledgementA.turn_id;
	runtimeTurnB = acknowledgementB.turn_id;
	const [listedA, listedB] = await Promise.all([
		serverA.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" }),
		serverB.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" }),
	]);
	const questionA = (listedA.questions as Array<Record<string, unknown>>)[0]!;
	const questionBBefore = (listedB.questions as Array<Record<string, unknown>>)[0]!;
	expect(questionA.answer_binding).not.toBe(questionBBefore.answer_binding);
	await expect(
		serverA.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session",
			turn_id: sentA.turn_id,
			question_id: "gate-isolated-a",
			answer_binding: questionA.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "isolation-answer-a",
			allow_mutation: true,
		}),
	).resolves.toMatchObject({ ok: true, status: "accepted" });
	const listedBAfter = await serverB.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
	const questionBAfter = (listedBAfter.questions as Array<Record<string, unknown>>)[0]!;
	expect(questionBAfter).toMatchObject({
		question_id: "gate-isolated-b",
		status: "pending",
		updated_at: questionBBefore.updated_at,
		answer_binding: questionBBefore.answer_binding,
	});
	const journalB = await fs.readFile(path.join(coordinatorNamespace(rootB), "events", "event-journal.jsonl"), "utf8");
	expect(journalB).not.toContain("question.answered");
	await expect(fs.access(path.join(coordinatorNamespace(rootB), "codex-wake-events"))).rejects.toThrow();
});

it("issue-4351: completed coordinator session reports ready_for_input false and ended_at", async () => {
	const root = await tempRoot();
	const controls: SdkControl[] = [];
	const server = await createSdkControlServer(root, controls);
	await registerSdkSession(server, root);
	const sent = await server.callTool("gjc_coordinator_send_prompt", {
		session_id: "visible-session",
		prompt: "terminal transition for issue-4351",
		idempotency_key: "issue-4351-completed",
		allow_mutation: true,
	});
	const turnId = (sent as { turn_id?: unknown }).turn_id;
	if (typeof turnId !== "string") throw new Error("expected turn id");
	await server.callTool("gjc_coordinator_report_status", {
		session_id: "visible-session",
		turn_id: turnId,
		status: "completed",
		summary: "completed session must not be ready_for_input",
		idempotency_key: "issue-4351-terminal",
		allow_mutation: true,
	});
	const statePath = path.join(coordinatorNamespace(root), "session-states", "visible-session.json");
	const durable = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
	expect(durable.state).toBe("completed");
	expect(durable.ready_for_input).toBe(false);
	expect(typeof durable.ended_at).toBe("string");
	expect(Number.isFinite(Date.parse(durable.ended_at as string))).toBe(true);

	const status = await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" });
	expect(status).toMatchObject({
		session_state: {
			state: "completed",
			ready_for_input: false,
		},
	});
	const publicState = (status as { session_state?: Record<string, unknown> }).session_state;
	expect(typeof publicState?.ended_at).toBe("string");
});

describe("Coordinator MCP retained-delivery ordering", () => {
	it("bounds deterministic public IDs for legal long session identifiers", () => {
		const sessionId = `s${"a".repeat(127)}`;
		const eventId = deterministicOutboxId(sessionId, 1, "session.registered", "session", sessionId);
		expect(eventId.length).toBeGreaterThan(128);
		expect(eventId.length).toBeLessThanOrEqual(512);
	});

	it("advances the discovery cursor across an empty bounded sweep", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [
			{
				sessionId: "alpha-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
			{
				sessionId: "beta-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
			{
				sessionId: "gamma-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
		]);
		for (const [sessionId, key] of [
			["alpha-session", "register-empty-alpha"],
			["beta-session", "register-empty-beta"],
			["gamma-session", "register-empty-gamma"],
		] as const)
			await server.callTool("gjc_coordinator_register_session", {
				session_id: sessionId,
				cwd: root,
				idempotency_key: key,
				allow_mutation: true,
			});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		for (const sessionId of ["alpha-session", "beta-session", "gamma-session"] as const)
			await withSessionTransaction(paths, sessionId, async transaction => {
				for (const event of Object.values(transaction.outbox)) {
					event.emitted = true;
					event.public_delivery.state = "acknowledged";
					event.public_delivery.journal_seq = 1;
					event.public_delivery.acknowledged_at = new Date().toISOString();
				}
			});
		await injectPendingDeliveryForTest(server, "gamma-session", "event-gamma-empty", 1);
		const empty = await enumeratePublicDeliveries(paths, "@session:", 1);
		expect(empty.claims).toHaveLength(0);
		expect(empty.next_cursor).toBe("@session:beta-session");
		if (!empty.next_cursor) throw new Error("missing empty-sweep cursor");
		await advanceDeliveryDiscoveryCursor(paths, empty.next_cursor);
		expect(await readDeliveryDiscoveryCursor(paths)).toBe(empty.next_cursor);
	});

	it("rediscovers a new pending event in an earlier session after later-session delivery", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [
			{
				sessionId: "alpha-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
			{
				sessionId: "zeta-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
		]);
		for (const [sessionId, key] of [
			["alpha-session", "register-alpha-ordering"],
			["zeta-session", "register-zeta-ordering"],
		] as const)
			await expect(
				server.callTool("gjc_coordinator_register_session", {
					session_id: sessionId,
					cwd: root,
					idempotency_key: key,
					allow_mutation: true,
				}),
			).resolves.toMatchObject({ ok: true });
		await injectPendingDeliveryForTest(server, "zeta-session", "event-zeta-1", 1);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const first = await enumeratePublicDeliveries(paths, "", 10);
		const zetaClaim = first.claims.find(claim => claim.session_id === "zeta-session");
		expect(zetaClaim).toBeDefined();
		if (!zetaClaim) throw new Error("missing zeta delivery claim");
		await acknowledgePublicDelivery(paths, "zeta-session", {
			public_event_id: zetaClaim.event.public_event_id,
			claim_fence: zetaClaim.claim_fence,
			journal_seq: 1,
		});
		await injectPendingDeliveryForTest(server, "alpha-session", "event-alpha-2", 2);
		const second = await enumeratePublicDeliveries(paths, "", 10);
		expect(second.claims.map(claim => claim.session_id)).toContain("alpha-session");
	});

	it("orders unpadded transaction revisions numerically so revision 9 precedes 10", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		await withSessionTransaction(paths, "visible-session", async transaction => {
			for (const event of Object.values(transaction.outbox)) {
				event.emitted = true;
				event.public_delivery.state = "acknowledged";
				event.public_delivery.journal_seq = 1;
				event.public_delivery.acknowledged_at = new Date().toISOString();
			}
		});
		await injectPendingDeliveryForTest(server, "visible-session", "event-revision-9", 9);
		await injectPendingDeliveryForTest(server, "visible-session", "event-revision-10", 10);
		const first = await enumeratePublicDeliveries(paths, "", 1);
		expect(first.claims.map(claim => claim.event.transaction_revision)).toEqual([9]);
		if (!first.next_cursor) throw new Error("missing continuation cursor");
		const second = await enumeratePublicDeliveries(paths, first.next_cursor, 1);
		expect(second.claims.map(claim => claim.event.transaction_revision)).toEqual([10]);
	});

	it("does not lease events beyond the aggregate delivery page", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [
			{
				sessionId: "alpha-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
			{
				sessionId: "beta-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
		]);
		for (const [sessionId, key] of [
			["alpha-session", "register-aggregate-alpha"],
			["beta-session", "register-aggregate-beta"],
		] as const)
			await server.callTool("gjc_coordinator_register_session", {
				session_id: sessionId,
				cwd: root,
				idempotency_key: key,
				allow_mutation: true,
			});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		for (const sessionId of ["alpha-session", "beta-session"] as const)
			await withSessionTransaction(paths, sessionId, async transaction => {
				for (const event of Object.values(transaction.outbox)) {
					event.emitted = true;
					event.public_delivery.state = "acknowledged";
					event.public_delivery.journal_seq = 1;
					event.public_delivery.acknowledged_at = new Date().toISOString();
				}
			});
		await injectPendingDeliveryForTest(server, "alpha-session", "aggregate-alpha", 1);
		for (const [index, eventId] of [
			"aggregate-beta-1",
			"aggregate-beta-2",
			"aggregate-beta-3",
			"aggregate-beta-4",
		].entries())
			await injectPendingDeliveryForTest(server, "beta-session", eventId, index + 1);
		const page = await enumeratePublicDeliveries(paths, "", 2);
		expect(page.claims.map(claim => claim.event.public_event_id)).toEqual(["aggregate-alpha", "aggregate-beta-1"]);
		const beta = await withSessionTransaction(paths, "beta-session", async transaction =>
			Object.values(transaction.outbox).filter(event => event.public_event_id.startsWith("aggregate-beta")),
		);
		expect(beta.filter(event => event.public_delivery.state === "claimed")).toHaveLength(1);
		expect(beta.filter(event => event.public_delivery.state === "pending")).toHaveLength(3);
	});

	it("reconciles newly opened session-scoped questions after a filesystem wake", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let gateAvailable = false;
		let runtimeTurnId = "unbound";
		const server = await createSdkControlServer(root, controls, [], query => {
			if (query !== "Q12") return { ok: true, page: { items: [], complete: true, revision: "context" } };
			if (!gateAvailable) return { ok: true, page: { items: [], complete: true, revision: "q12-empty" } };
			return {
				ok: true,
				page: {
					items: [sharedAskGate("wake-gate", runtimeTurnId)],
					complete: true,
					revision: "q12-open",
				},
			};
		});
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "wait for gate",
			idempotency_key: "wake-gate-prompt",
			allow_mutation: true,
		});
		runtimeTurnId = String(
			(sent.turn as Record<string, unknown>).delivery &&
				((sent.turn as Record<string, unknown>).delivery as Record<string, unknown>).runtime_turn_id,
		);
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			ready_for_input: false,
			live: true,
			source: "agent_session_event",
			current_turn_id: String(sent.turn_id),
			activity: {
				seq: 1,
				phase: "waiting",
				active_tool_count: 0,
				active_tools: [],
			},
		});
		const initial = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		const cursor = Number(initial.next_after_seq);
		gateAvailable = true;
		const pending = server.callTool("gjc_coordinator_watch_events", {
			session_id: "visible-session",
			after_seq: cursor,
			timeout_ms: 500,
		});
		await appendCoordinatorEventForTest(coordinatorNamespace(root), {
			kind: "session.state_changed",
			sessionId: "visible-session",
			summary: "wake",
		});
		const result = await pending;
		expect(result).toMatchObject({
			ok: true,
			events: expect.arrayContaining([
				expect.objectContaining({ kind: "question.opened", question_id: "wake-gate" }),
			]),
		});
	});

	it("imports a pre-WAL active Q12 turn into canonical admission, listing, and answer handling", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "unbound";
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			query =>
				query === "Q12"
					? {
							ok: true,
							page: {
								items: [sharedAskGate("legacy-q12", runtimeTurnId)],
								complete: true,
								revision: "legacy-q12",
							},
						}
					: { ok: true, page: { items: [], complete: true, revision: "context" } },
			undefined,
			undefined,
			undefined,
			{
				controlResult: control =>
					control.operation === "workflow.gate_answer" ? { status: "accepted" } : undefined,
			},
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "legacy waiting gate",
			idempotency_key: "legacy-q12-prompt",
			allow_mutation: true,
		});
		runtimeTurnId = String((sent.result as Record<string, unknown>).turn_id);
		await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "queued legacy follow-up",
			queue: true,
			idempotency_key: "legacy-q12-follow-up",
			allow_mutation: true,
		});
		expect(queued).toMatchObject({ ok: true, queued: true });
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			ready_for_input: false,
			live: true,
			source: "agent_session_event",
			current_turn_id: sent.turn_id,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		await materializeLegacyProjectionFixture(root, server.config.namespace.identity, "visible-session");
		await fs.rm(transactionPath(paths, "visible-session"));

		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const question = (listed.questions as Array<Record<string, unknown>>)[0]!;
		expect(listed).toMatchObject({
			ok: true,
			questions: [expect.objectContaining({ question_id: "legacy-q12", status: "pending" })],
		});
		const imported = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			canonical: {
				queue: { active_turn_id: string | null; ordered_turn_ids: string[] };
				turns: Record<string, { status: string }>;
			};
		};
		const sentTurnId = sent.turn_id;
		expect(typeof sentTurnId).toBe("string");
		if (typeof sentTurnId !== "string") throw new Error("missing_legacy_turn_id");
		expect(imported.canonical.queue.active_turn_id).toBe(sentTurnId);
		const queuedTurnId = String(queued.turn_id);
		expect(imported.canonical.queue.ordered_turn_ids).toEqual([queuedTurnId]);
		expect(imported.canonical.turns[queuedTurnId]).toMatchObject({ status: "queued" });
		expect(imported.canonical.turns[sentTurnId]).toMatchObject({
			status: "waiting_for_answer",
			question_ids: ["legacy-q12"],
			runtime_provenance: expect.objectContaining({
				coordinator_turn_id: sentTurnId,
				runtime_turn_id: runtimeTurnId,
			}),
		});
		const answer = await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "legacy-q12",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "legacy-q12-answer",
			allow_mutation: true,
		});
		expect(answer).toMatchObject({ ok: true, operation: "workflow.gate_answer", status: "accepted" });
		const replay = await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "legacy-q12",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "legacy-q12-answer",
			allow_mutation: true,
		});
		expect(replay).toEqual(answer);
		expect(controls.filter(control => control.operation === "workflow.gate_answer")).toHaveLength(1);
	});

	it("quarantines inconsistent pre-WAL active projections without creating canonical state", async () => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "inconsistent legacy projection",
			idempotency_key: "inconsistent-legacy-prompt",
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const legacy = await materializeLegacyProjectionFixture(
			root,
			server.config.namespace.identity,
			"visible-session",
		);
		const activePath = path.join(legacy, "active-turns", "visible-session.json");
		const active = JSON.parse(await fs.readFile(activePath, "utf8")) as Record<string, unknown>;
		const hostileActive = JSON.stringify({ ...active, turn_id: "missing-legacy-turn" });
		await fs.writeFile(activePath, hostileActive);
		await fs.rm(transactionPath(paths, "visible-session"));

		const result = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
		await expect(fs.access(transactionPath(paths, "visible-session"))).rejects.toThrow();
		expect(await fs.readFile(activePath, "utf8")).toBe(hostileActive);
		expect(sent).toMatchObject({ ok: true });
	});

	it("quarantines hostile nested legacy terminal and report fields before creating a WAL", async () => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "terminal legacy validation",
			idempotency_key: "terminal-legacy-validation",
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			status: "completed",
			summary: "done",
			idempotency_key: "terminal-legacy-report",
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const legacy = await materializeLegacyProjectionFixture(
			root,
			server.config.namespace.identity,
			"visible-session",
		);
		const turnPath = path.join(legacy, "turns", `${sent.turn_id}.json`);
		const turn = JSON.parse(await fs.readFile(turnPath, "utf8")) as Record<string, unknown>;
		const hostileTurn = JSON.stringify({
			...turn,
			delivery: {
				...(turn.delivery as Record<string, unknown>),
				attempts: [{ delivered: "yes", created_at: "never", reason: 7 }],
			},
			final_response: { text: 7 },
			evidence: ["not-a-record"],
			error: { code: 1, message: null, recoverable: "no" },
			liveness: { checked_at: "never", live: "yes", reason: 4 },
			runtime_provenance: { namespace_id: "wrong" },
			terminal_fence: { epoch: 0, status: "active", reason: 7, at: "never" },
		});
		await fs.writeFile(turnPath, hostileTurn);
		const [reportName] = (await fs.readdir(path.join(legacy, "reports"))).filter(name => name.endsWith(".json"));
		if (!reportName) throw new Error("missing_legacy_report");
		const reportPath = path.join(legacy, "reports", reportName);
		const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as Record<string, unknown>;
		const hostileReport = JSON.stringify({ ...report, evidence_paths: [7], created_at: "never" });
		await fs.writeFile(reportPath, hostileReport);
		await fs.rm(transactionPath(paths, "visible-session"));

		const result = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
		await expect(fs.access(transactionPath(paths, "visible-session"))).rejects.toThrow();
		expect(await fs.readFile(turnPath, "utf8")).toBe(hostileTurn);
		expect(await fs.readFile(reportPath, "utf8")).toBe(hostileReport);
	});

	const unavailableEnvelope = {
		ok: false,
		error: { code: "unavailable", message: "Coordinator service is unavailable." },
	};
	it.each([
		"null",
		"false",
		"0",
		'""',
	])("quarantines present scalar WAL root %s without changing its bytes", async hostile => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "scalar root corruption",
			idempotency_key: `scalar-root-${hostile}`,
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const file = transactionPath(paths, "visible-session");
		await fs.writeFile(file, hostile);

		expect(await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" })).toEqual(
			unavailableEnvelope,
		);
		expect(await fs.readFile(file, "utf8")).toBe(hostile);
	});

	const walCorruptions: ReadonlyArray<readonly [string, (value: Record<string, unknown>) => void]> = [
		[
			"questions",
			(value: Record<string, unknown>) => ((value.canonical as Record<string, unknown>).questions = null),
		],
		[
			"gate authorities",
			(value: Record<string, unknown>) => ((value.canonical as Record<string, unknown>).gate_authorities = null),
		],
		[
			"answer requests",
			(value: Record<string, unknown>) => ((value.requests as Record<string, unknown>).answers = null),
		],
		[
			"operation requests",
			(value: Record<string, unknown>) => ((value.requests as Record<string, unknown>).operations = null),
		],
		["outbox delivery", (value: Record<string, unknown>) => (value.outbox = null)],
		["endpoint", (value: Record<string, unknown>) => (value.endpoint = { incarnation: 7, observed_at: "never" })],
		["projection", (value: Record<string, unknown>) => (value.projection = null)],
		[
			"recovery",
			(value: Record<string, unknown>) =>
				(value.recovery = { prompt_watermark_at: "never", last_repaired_at: null }),
		],
		["revision", (value: Record<string, unknown>) => (value.revision = 0)],
		[
			"queue membership",
			(value: Record<string, unknown>) =>
				(((value.canonical as Record<string, unknown>).queue as Record<string, unknown>).ordered_turn_ids = [
					"missing-turn",
				]),
		],
		[
			"outbox delivery identity",
			(value: Record<string, unknown>) => {
				const event = Object.values(value.outbox as Record<string, Record<string, unknown>>)[0]!;
				(event.public_delivery as Record<string, unknown>).public_event_id = "wrong-public-event";
			},
		],
		[
			"prompt turn receipt",
			(value: Record<string, unknown>) => {
				const request = Object.values(
					(value.requests as Record<string, Record<string, Record<string, unknown>>>).prompts,
				)[0]!;
				request.runtime_receipt = { accepted: true, command_id: "wrong-command", turn_id: "wrong-runtime-turn" };
			},
		],
	];
	it.each(walCorruptions)("rejects corrupt existing WAL %s without changing its bytes", async (_field, corrupt) => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "canonical corruption",
			idempotency_key: `canonical-${_field.replaceAll(" ", "-")}`,
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const file = transactionPath(paths, "visible-session");
		const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		corrupt(value);
		const hostile = JSON.stringify(value);
		await fs.writeFile(file, hostile);
		const result = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(result).toEqual(unavailableEnvelope);
		expect(await fs.readFile(file, "utf8")).toBe(hostile);
	});

	it.each([
		[
			"admitted authority-question linkage",
			(value: Record<string, unknown>) => {
				const authorities = (value.canonical as Record<string, unknown>).gate_authorities as Record<
					string,
					Record<string, unknown>
				>;
				(Object.values(authorities)[0]!.outcome as Record<string, unknown>).question_id = "wrong-question";
			},
		],
		[
			"question-answer fence linkage",
			(value: Record<string, unknown>) => {
				const question = Object.values(
					(value.canonical as Record<string, unknown>).questions as Record<string, Record<string, unknown>>,
				)[0]!;
				question.claim_fence_epoch = Number(question.claim_fence_epoch) + 1;
			},
		],
	] as const)("quarantines corrupt existing WAL %s without changing its bytes", async (_field, corrupt) => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "";
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			query =>
				query === "Q12"
					? {
							ok: true,
							page: {
								items: [sharedAskGate("cross-record-corruption", runtimeTurnId)],
								complete: true,
								revision: "cross-record-corruption",
							},
						}
					: { ok: true, page: { items: [], complete: true, revision: "context" } },
			undefined,
			undefined,
			undefined,
			{
				controlResult: control =>
					control.operation === "workflow.gate_answer"
						? { ok: true, result: { status: "accepted", resolved_at: "2026-08-20T00:00:00.000Z" } }
						: undefined,
			},
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "cross-record corruption",
			idempotency_key: `cross-record-${_field.replaceAll(" ", "-")}`,
			allow_mutation: true,
		});
		runtimeTurnId = String((sent.turn as Record<string, Record<string, unknown>>).delivery.runtime_turn_id);
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const question = (listed.questions as Array<Record<string, unknown>>)[0]!;
		if (_field === "question-answer fence linkage")
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "visible-session",
				turn_id: sent.turn_id,
				question_id: "cross-record-corruption",
				answer_binding: question.answer_binding,
				answer: { selected: ["opt_0"] },
				idempotency_key: "cross-record-answer-fence",
				allow_mutation: true,
			});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const file = transactionPath(paths, "visible-session");
		const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		corrupt(value);
		const hostile = JSON.stringify(value);
		await fs.writeFile(file, hostile);

		expect(await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" })).toEqual(
			unavailableEnvelope,
		);
		expect(await fs.readFile(file, "utf8")).toBe(hostile);
	});

	it("accepts a valid unlinked deferred gate authority", async () => {
		const root = await tempRoot();
		const server = await createSdkControlServer(root, []);
		await registerSdkSession(server, root);
		await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "deferred authority",
			idempotency_key: "deferred-authority-prompt",
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const file = transactionPath(paths, "visible-session");
		const transaction = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		const canonical = transaction.canonical as Record<string, unknown>;
		const session = canonical.session as Record<string, unknown>;
		const broker = session.broker as Record<string, unknown>;
		const firstTurn = Object.values(canonical.turns as Record<string, Record<string, unknown>>)[0]!;
		const runtimeTurnId = (firstTurn.delivery as Record<string, unknown>).runtime_turn_id;
		if (typeof runtimeTurnId !== "string") throw new Error("missing_runtime_turn");
		const now = new Date().toISOString();
		(canonical.gate_authorities as Record<string, unknown>)["deferred-authority"] = {
			authority: {
				namespace_id: server.config.namespace.identity,
				session_id: "visible-session",
				endpoint_incarnation: broker.endpoint_incarnation,
				gate_id: "deferred-gate",
			},
			observation: {
				kind: "valid",
				first_provenance: {
					namespace_id: server.config.namespace.identity,
					session_id: "visible-session",
					endpoint_incarnation: broker.endpoint_incarnation,
					coordinator_turn_id: "",
					runtime_turn_id: runtimeTurnId,
					gate_created_at: now,
					schema_hash: "deferred-schema",
					stage: "plan",
					kind: "ask",
				},
			},
			outcome: { state: "deferred_link", first_seen_at: now },
			first_seen_at: now,
			updated_at: now,
		};
		await fs.writeFile(file, JSON.stringify(transaction));

		expect(await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" })).toMatchObject({
			ok: true,
		});
	});

	it("does not admit Q12 when the sidecar session provenance is mismatched", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "provenance mismatch",
			idempotency_key: "provenance-mismatch-prompt",
			allow_mutation: true,
		});
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			current_turn_id: sent.turn_id,
			source: "agent_session_event",
			live: true,
			session_id: "wrong-session",
		});
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(listed).toMatchObject({ reconciliation: { complete: false, reason: "terminal_uncertain" } });
	});

	it("does not admit a gate whose runtime turn differs from the waiting admission token", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], query => {
			if (query !== "Q12") return { ok: true, page: { items: [], complete: true, revision: "context" } };
			return {
				ok: true,
				page: {
					items: [sharedAskGate("wrong-runtime-gate", "runtime-not-owner")],
					complete: true,
					revision: "q12-wrong-owner",
				},
			};
		});
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "wrong runtime owner",
			idempotency_key: "wrong-runtime-owner-prompt",
			allow_mutation: true,
		});
		const turn = sent.turn as Record<string, unknown>;
		const delivery = turn.delivery as Record<string, unknown>;
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			live: true,
			source: "agent_session_event",
			current_turn_id: sent.turn_id,
			activity: { seq: 1, phase: "waiting", active_tool_count: 0, active_tools: [] },
		});
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(listed).toMatchObject({
			questions: [],
			reconciliation: { complete: false, reason: "terminal_uncertain" },
		});
		expect(delivery.runtime_turn_id).not.toBe("runtime-not-owner");
	});
});

describe("Coordinator MCP deep-audit regressions", () => {
	it("returns delivery_pending after broker close for an unexpired retained lease, then expires and emits it once", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		await injectPendingDeliveryForTest(server, "visible-session", "close-retained-lease", 99);
		await withSessionTransaction(paths, "visible-session", async transaction => {
			for (const event of Object.values(transaction.outbox)) {
				if (event.public_event_id !== "close-retained-lease") {
					event.emitted = true;
					event.public_delivery.state = "acknowledged";
					event.public_delivery.journal_seq = 1;
					event.public_delivery.acknowledged_at = new Date().toISOString();
				}
			}
		});
		expect(await claimPublicDelivery(paths, "visible-session", { leaseMs: 1_000 })).toHaveLength(1);
		const sessionFile = path.join(coordinatorNamespace(root), "sessions", "visible-session.json");
		const session = JSON.parse(await fs.readFile(sessionFile, "utf8")) as Record<string, unknown>;
		await fs.writeFile(sessionFile, JSON.stringify({ ...session, ephemeral: true }));
		await expect(
			server.callTool("gjc_coordinator_stop_session", { session_id: "visible-session", allow_mutation: true }),
		).resolves.toMatchObject({ ok: false, reason: "delivery_pending", closed: false });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(1);
		await withSessionTransaction(paths, "visible-session", async transaction => {
			const retained = Object.values(transaction.outbox).find(
				event => event.public_event_id === "close-retained-lease",
			);
			if (!retained) throw new Error("missing retained delivery");
			retained.public_delivery.claim_expires_at = new Date(Date.now() - 1).toISOString();
		});
		await expect(
			server.callTool("gjc_coordinator_stop_session", { session_id: "visible-session", allow_mutation: true }),
		).resolves.toMatchObject({ ok: true, closed: true });
		expect(controls.filter(control => control.operation === "session.close")).toHaveLength(1);
		const journal = (
			await fs.readFile(path.join(coordinatorNamespace(root), "events", "event-journal.jsonl"), "utf8")
		)
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { id: string; kind: string });
		expect(journal.filter(event => event.id === "close-retained-lease")).toHaveLength(1);
		const watched = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		expect((watched.events as Array<{ kind: string }>).filter(event => event.kind === "session.reaped")).toHaveLength(
			1,
		);
		const scopedWatched = await server.callTool("gjc_coordinator_watch_events", {
			session_id: "visible-session",
			after_seq: 0,
			timeout_ms: 0,
		});
		expect(scopedWatched).toMatchObject({ ok: true });
		expect(
			(scopedWatched.events as Array<{ kind: string }>).filter(event => event.kind === "session.reaped"),
		).toHaveLength(1);
	});

	it("reconciles an acknowledged errored terminal sidecar as one failed turn with its receipt fields", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "errored terminal",
			idempotency_key: "errored-terminal",
			allow_mutation: true,
		});
		const turnId = String(sent.turn_id);
		const cursor = await currentEventCursor(root);
		const runtimeError = { code: "runtime_failed", message: "runtime terminal error" };
		await patchSessionState(server, root, "visible-session", {
			state: "errored",
			ready_for_input: false,
			current_turn_id: turnId,
			last_turn_id: turnId,
			source: "agent_session_event",
			live: false,
			updated_at: "2026-08-19T00:00:00.000Z",
			error: runtimeError,
			execution_state: "failed",
			receipt_state: "received",
		});
		const watched = await server.callTool("gjc_coordinator_watch_events", { after_seq: cursor, timeout_ms: 0 });
		const terminal = (watched.events as Array<Record<string, unknown>>).filter(
			event => event.turn_id === turnId && (event.kind === "turn.failed" || event.kind === "turn.completed"),
		);
		expect(terminal).toEqual([expect.objectContaining({ kind: "turn.failed", turn_id: turnId })]);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = await withSessionTransaction(paths, "visible-session", async current => current);
		expect(transaction.canonical.turns[turnId]).toMatchObject({
			status: "failed",
			terminal_fence: { status: "failed" },
			error: { code: "runtime_errored", message: "Runtime turn failed." },
		});
		expect(transaction.canonical.queue.active_turn_id).toBeNull();
		await expect(
			fs.access(path.join(coordinatorNamespace(root), "active-turns", "visible-session.json")),
		).rejects.toThrow();
		const repaired = await readCoordinatorSessionState(root);
		expect(repaired).toMatchObject({
			state: "errored",
			error: runtimeError,
			execution_state: "failed",
			receipt_state: "received",
		});
	});

	it("advertises Linux-only artifact capability consistently across platform discovery", async () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		if (!originalPlatform?.configurable) throw new Error("process_platform_not_configurable");
		try {
			for (const [platform, available] of [
				["linux", true],
				["darwin", false],
				["win32", false],
			] as const) {
				Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
				const server = await createSdkControlServer(
					await tempRoot(),
					[],
					[],
					undefined,
					undefined,
					undefined,
					undefined,
					{
						platform,
					},
				);
				const discovery = await server.handleJsonRpc({ jsonrpc: "2.0", id: platform, method: "tools/list" });
				const artifact = (discovery.result as { tools: Array<Record<string, unknown>> }).tools.find(
					tool => tool.name === "gjc_coordinator_read_artifact",
				);
				expect(artifact?.description).toContain(
					available ? "Read one bounded artifact" : "Unavailable on this platform",
				);
				if (!available) {
					await expect(
						server.callTool("gjc_coordinator_read_artifact", { path: "/unsupported" }),
					).resolves.toEqual({
						ok: false,
						error: { code: "artifact_unavailable", message: "Coordinator artifact could not be read." },
					});
				}
			}
		} finally {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	it.skipIf(process.platform !== "linux")(
		"decodes UTF-8 artifacts only through complete scalar boundaries",
		async () => {
			const root = await tempRoot();
			const artifactRoot = path.join(root, "artifacts");
			await fs.mkdir(artifactRoot, { recursive: true });
			const config = buildCoordinatorMcpConfig({
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: artifactRoot,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, "coordinator-state"),
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			});
			const cases: Array<[string, Buffer, number, string]> = [
				["exact", Buffer.from("a€"), 4, "a€"],
				["split", Buffer.from("a€"), 3, "a"],
				["continuation", Buffer.from([0x61, 0xe2, 0x28, 0xa1]), 4, "a"],
				["overlong", Buffer.from([0x61, 0xc0, 0x80]), 3, "a"],
				["surrogate", Buffer.from([0x61, 0xed, 0xa0, 0x80]), 4, "a"],
				["out-of-range", Buffer.from([0x61, 0xf4, 0x90, 0x80, 0x80]), 5, "a"],
				["zero", Buffer.from("€"), 0, ""],
			];
			for (const [name, bytes, cap, expected] of cases) {
				const artifact = path.join(artifactRoot, `${name}.bin`);
				await fs.writeFile(artifact, bytes);
				const result = await readCoordinatorArtifact({ ...config, artifactByteCap: cap }, { path: artifact });
				expect(result).toMatchObject({ ok: true, text: expected, bytes: Buffer.byteLength(expected) });
			}
		},
	);

	it.skipIf(process.platform !== "linux")("truncates malformed artifact bytes in one valid UTF-8 pass", async () => {
		const root = await tempRoot();
		const artifactRoot = path.join(root, "artifacts");
		await fs.mkdir(artifactRoot, { recursive: true });
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: artifactRoot,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, "coordinator-state"),
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		const artifact = path.join(artifactRoot, "malformed-artifact.bin");
		await fs.writeFile(
			artifact,
			Buffer.concat([Buffer.from("valid-prefix"), Buffer.from([0xff]), Buffer.alloc(64 * 1024, 0x61)]),
		);
		await expect(server.callTool("gjc_coordinator_read_artifact", { path: artifact })).resolves.toMatchObject({
			ok: true,
			text: "valid-prefix",
		});
	});

	it("does not admit a pre-acknowledgement terminal sidecar", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "pre-ack terminal",
			idempotency_key: "pre-ack-terminal",
			allow_mutation: true,
		});
		const turnId = String(sent.turn_id);
		const cursor = await currentEventCursor(root);
		await patchTurnDelivery(server, "visible-session", turnId, {
			prompt_acknowledged: false,
			runtime_command_id: undefined,
			runtime_turn_id: undefined,
			state: "queued",
		});
		await patchSessionState(server, root, "visible-session", {
			state: "completed",
			ready_for_input: false,
			current_turn_id: turnId,
			last_turn_id: turnId,
			source: "agent_session_event",
			live: true,
			updated_at: "2026-08-19T00:00:00.000Z",
			final_response: {
				text: "runtime completed before broker acknowledgement",
				format: "markdown",
				source: "runtime",
				artifact_path: null,
				truncated: false,
			},
		});
		const watched = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: cursor,
			timeout_ms: 0,
		});
		expect(watched).toMatchObject({ ok: true });
		expect(
			(watched.events as Array<Record<string, unknown>>).some(
				event => event.turn_id === turnId && (event.kind === "turn.completed" || event.kind === "turn.failed"),
			),
		).toBe(false);
		await expect(
			server.callTool("gjc_coordinator_read_turn", { session_id: "visible-session", turn_id: turnId }),
		).resolves.toMatchObject({
			ok: true,
			turn: { turn_id: turnId, status: "active" },
		});
	});

	it("does not admit a pre-acknowledgement waiting sidecar or question", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], query =>
			query === "Q12"
				? { ok: true, page: { items: [], complete: true, revision: "pre-ack-waiting" } }
				: { ok: true, page: { items: [], complete: true, revision: "context" } },
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "pre-ack waiting",
			idempotency_key: "pre-ack-waiting",
			allow_mutation: true,
		});
		const turnId = String(sent.turn_id);
		const cursor = await currentEventCursor(root);
		await patchTurnDelivery(server, "visible-session", turnId, {
			prompt_acknowledged: false,
			runtime_command_id: undefined,
			runtime_turn_id: undefined,
			state: "queued",
		});
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			ready_for_input: false,
			current_turn_id: turnId,
			last_turn_id: turnId,
			source: "agent_session_event",
			live: true,
			updated_at: "2026-08-19T00:00:00.000Z",
		});
		const watched = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: cursor,
			timeout_ms: 0,
		});
		expect(watched).toMatchObject({ ok: true });
		expect(
			(watched.events as Array<Record<string, unknown>>).some(
				event =>
					event.turn_id === turnId &&
					(event.kind === "turn.waiting_for_answer" || event.kind === "question.opened"),
			),
		).toBe(false);
		await expect(
			server.callTool("gjc_coordinator_read_turn", { session_id: "visible-session", turn_id: turnId }),
		).resolves.toMatchObject({
			ok: true,
			turn: { turn_id: turnId, status: "active" },
		});
	});

	it("performs one immediate zero-time reconcile for waiting and question events", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let gateAvailable = false;
		let runtimeTurnId = "";
		const server = await createSdkControlServer(root, controls, [], query => {
			if (query !== "Q12") return { ok: true, page: { items: [], complete: true, revision: "context" } };
			return gateAvailable
				? {
						ok: true,
						page: {
							items: [sharedAskGate("zero-time-gate", runtimeTurnId)],
							complete: true,
							revision: "zero-time-open",
						},
					}
				: { ok: true, page: { items: [], complete: true, revision: "zero-time-empty" } };
		});
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "zero-time waiting",
			idempotency_key: "zero-time-waiting",
			allow_mutation: true,
		});
		runtimeTurnId = String(
			(sent.turn as Record<string, unknown>).delivery &&
				((sent.turn as Record<string, unknown>).delivery as Record<string, unknown>).runtime_turn_id,
		);
		const cursor = await currentEventCursor(root);
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			ready_for_input: false,
			current_turn_id: sent.turn_id,
			last_turn_id: sent.turn_id,
			source: "agent_session_event",
			live: true,
			updated_at: "2026-08-19T00:00:00.000Z",
			activity: { seq: 1, phase: "waiting", active_tool_count: 0, active_tools: [] },
		});
		gateAvailable = true;
		const watched = await server.callTool("gjc_coordinator_watch_events", { after_seq: cursor, timeout_ms: 0 });
		expect(watched).toMatchObject({
			ok: true,
			events: expect.arrayContaining([
				expect.objectContaining({ kind: "turn.waiting_for_answer", turn_id: sent.turn_id }),
				expect.objectContaining({ kind: "question.opened", question_id: "zero-time-gate" }),
			]),
		});
	});

	it("performs one immediate zero-time reconcile for a terminal sidecar", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "zero-time terminal",
			idempotency_key: "zero-time-terminal",
			allow_mutation: true,
		});
		expect(sent).toMatchObject({
			ok: true,
			result: { accepted: true },
			turn: {
				turn_id: sent.turn_id,
				delivery: { prompt_acknowledged: true, runtime_turn_id: expect.any(String) },
			},
		});
		const cursor = await currentEventCursor(root);
		await patchSessionState(server, root, "visible-session", {
			state: "completed",
			ready_for_input: false,
			current_turn_id: sent.turn_id,
			last_turn_id: sent.turn_id,
			source: "agent_session_event",
			live: true,
			updated_at: "2026-08-19T00:00:00.000Z",
			final_response: {
				text: "zero-time terminal result",
				format: "markdown",
				source: "runtime",
				artifact_path: null,
				truncated: false,
			},
		});
		await expect(
			server.callTool("gjc_coordinator_watch_events", { after_seq: cursor, timeout_ms: 0 }),
		).resolves.toMatchObject({
			ok: true,
			events: expect.arrayContaining([expect.objectContaining({ kind: "turn.completed", turn_id: sent.turn_id })]),
		});
	});

	it("rotates bounded Q12 attempts across sessions with a persisted cursor", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let q12Calls = 0;
		const runtimeTurns = new Map<string, string>();
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			query => {
				if (query !== "Q12") return { ok: true, page: { items: [], complete: true, revision: "context" } };
				q12Calls += 1;
				if (q12Calls === 2)
					return {
						ok: true,
						page: {
							items: [sharedAskGate("fair-beta", runtimeTurns.get("beta-session") ?? "")],
							complete: true,
							revision: "fair-beta",
						},
					};
				if (q12Calls === 3)
					return {
						ok: true,
						page: {
							items: [sharedAskGate("fair-gamma", runtimeTurns.get("gamma-session") ?? "")],
							complete: true,
							revision: "fair-gamma",
						},
					};
				return { ok: true, page: { items: [], complete: false, revision: `fair-incomplete-${q12Calls}` } };
			},
			[
				{
					sessionId: "alpha-session",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
					endpointGeneration: 1,
				},
				{
					sessionId: "beta-session",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
					endpointGeneration: 1,
				},
				{
					sessionId: "gamma-session",
					locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
					live: true,
					endpointGeneration: 1,
				},
			],
		);
		for (const [sessionId, key] of [
			["alpha-session", "fair-register-alpha"],
			["beta-session", "fair-register-beta"],
			["gamma-session", "fair-register-gamma"],
		] as const)
			await expect(
				server.callTool("gjc_coordinator_register_session", {
					session_id: sessionId,
					cwd: root,
					idempotency_key: key,
					allow_mutation: true,
				}),
			).resolves.toMatchObject({ ok: true });
		for (const sessionId of ["alpha-session", "beta-session", "gamma-session"] as const) {
			const sent = await server.callTool("gjc_coordinator_send_prompt", {
				session_id: sessionId,
				prompt: `fair ${sessionId}`,
				idempotency_key: `fair-prompt-${sessionId}`,
				allow_mutation: true,
			});
			runtimeTurns.set(
				sessionId,
				String(((sent.turn as Record<string, unknown>).delivery as Record<string, unknown>).runtime_turn_id),
			);
			await patchSessionState(server, root, sessionId, {
				state: "needs_user_input",
				ready_for_input: false,
				current_turn_id: sent.turn_id,
				last_turn_id: sent.turn_id,
				source: "agent_session_event",
				live: true,
				updated_at: "2026-08-19T00:00:00.000Z",
			});
		}
		const cursor = await currentEventCursor(root);
		const first = await server.callTool("gjc_coordinator_watch_events", { after_seq: cursor, timeout_ms: 0 });
		expect(
			(first.events as Array<Record<string, unknown>>).some(
				event => event.kind === "question.opened" && event.session_id === "gamma-session",
			),
		).toBe(false);
		const second = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: first.next_after_seq,
			timeout_ms: 0,
		});
		expect(second).toMatchObject({
			ok: true,
			events: expect.arrayContaining([
				expect.objectContaining({
					kind: "question.opened",
					session_id: "gamma-session",
					question_id: "fair-gamma",
				}),
			]),
		});
		expect(q12Calls).toBeGreaterThanOrEqual(3);
	}, 15_000);

	it("keeps both controller guides on the watch-first optional-report contract", async () => {
		const docsRoot = path.resolve(import.meta.dir, "../../../docs");
		const hermes = await fs.readFile(path.join(docsRoot, "hermes-mcp-bridge.md"), "utf8");
		const bot = await fs.readFile(path.join(docsRoot, "bot-integration.md"), "utf8");
		for (const guide of [hermes, bot]) {
			expect(guide).toContain("gjc_coordinator_watch_events");
			expect(guide).toContain("next_after_seq");
			expect(guide).toContain("turn.waiting_for_answer");
			expect(guide).toContain("question.opened");
			expect(guide).toContain("turn.completed");
			expect(guide).toContain("turn.failed");
			expect(guide).toContain("optional");
		}
		expect(hermes).not.toContain(
			"Use `gjc_coordinator_report_status` with `session_id` and `turn_id` to write explicit completion/failure evidence.",
		);
		expect(bot).not.toContain("When the work is done, your bot must call `gjc_coordinator_report_status`");
		expect(bot).not.toContain("marks turn completion/failure with report_status");
	});

	it("keeps an unrelated active turn when a queued turn receives a terminal report", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const active = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "active work",
			idempotency_key: "audit-active-report",
			allow_mutation: true,
		});
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "queued work",
			queue: true,
			idempotency_key: "audit-queued-report",
			allow_mutation: true,
		});
		const queuedTurnId = String(queued.turn_id);
		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: queuedTurnId,
			status: "completed",
			summary: "queued receipt",
			idempotency_key: "audit-queued-terminal",
			allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, turn: { turn_id: queuedTurnId, status: "completed" } });
		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: active.turn_id })).resolves.toMatchObject({
			ok: true,
			turn: { turn_id: active.turn_id, status: "active" },
		});
		await expect(
			server.callTool("gjc_coordinator_read_coordination_status", { session_id: "visible-session" }),
		).resolves.toMatchObject({
			ok: true,
			summary: { active_turns: 1, terminal_turns: 1 },
		});
	});

	it("serializes active and queued terminal reports without losing either turn", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const active = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "active race",
			idempotency_key: "audit-race-active",
			allow_mutation: true,
		});
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "queued race",
			queue: true,
			idempotency_key: "audit-race-queued",
			allow_mutation: true,
		});
		const [activeReport, queuedReport] = await Promise.all([
			server.callTool("gjc_coordinator_report_status", {
				session_id: "visible-session",
				turn_id: active.turn_id,
				status: "completed",
				summary: "active race receipt",
				idempotency_key: "audit-race-active-report",
				allow_mutation: true,
			}),
			server.callTool("gjc_coordinator_report_status", {
				session_id: "visible-session",
				turn_id: queued.turn_id,
				status: "completed",
				summary: "queued race receipt",
				idempotency_key: "audit-race-queued-report",
				allow_mutation: true,
			}),
		]);
		expect(activeReport).toMatchObject({ ok: true });
		expect(queuedReport).toMatchObject({ ok: true });
		await expect(
			server.callTool("gjc_coordinator_read_coordination_status", { session_id: "visible-session" }),
		).resolves.toMatchObject({
			ok: true,
			summary: { active_turns: 0, terminal_turns: 2 },
		});
	});

	it("promotes exactly the queued successor when the active turn reports terminal", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const active = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "active work",
			idempotency_key: "audit-promotion-active",
			allow_mutation: true,
		});
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "queued successor",
			queue: true,
			idempotency_key: "audit-promotion-queued",
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: active.turn_id,
			status: "completed",
			summary: "active receipt",
			idempotency_key: "audit-promotion-report",
			allow_mutation: true,
		});
		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: queued.turn_id })).resolves.toMatchObject({
			ok: true,
			turn: { turn_id: queued.turn_id, status: "active" },
		});
	});

	it("returns a real event watermark for zero-time and deadline watches", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const discovery = await server.handleJsonRpc({ jsonrpc: "2.0", id: "watch-schema", method: "tools/list" });
		const watchTool = (discovery.result as { tools: Array<Record<string, unknown>> }).tools.find(
			tool => tool.name === "gjc_coordinator_watch_events",
		);
		expect(watchTool).toMatchObject({
			inputSchema: { properties: { after_seq: { type: "integer", minimum: 0 } } },
		});
		const namespace = coordinatorNamespace(root);
		await appendCoordinatorEventForTest(namespace, {
			stableId: "audit-watermark-event",
			kind: "session.registered",
			sessionId: "visible-session",
			summary: "watermark",
		});
		await expect(
			server.callTool("gjc_coordinator_watch_events", { after_seq: 1.5, timeout_ms: 0 }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		const immediate = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		if (
			immediate.ok !== true ||
			!Number.isSafeInteger(immediate.latest_seq) ||
			!Number.isSafeInteger(immediate.next_after_seq)
		)
			throw new Error(`watch_events returned an invalid immediate snapshot: ${JSON.stringify(immediate)}`);
		expect(immediate.next_after_seq as number).toBeLessThanOrEqual(immediate.latest_seq as number);
		const deadline = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: immediate.next_after_seq,
			timeout_ms: 1,
		});
		if (
			deadline.ok !== true ||
			!Number.isSafeInteger(deadline.latest_seq) ||
			!Number.isSafeInteger(deadline.next_after_seq)
		)
			throw new Error(`watch_events returned an invalid deadline snapshot: ${JSON.stringify(deadline)}`);
		expect(deadline.next_after_seq as number).toBeLessThanOrEqual(deadline.latest_seq as number);
	});

	it("migrates the legacy journal index once before scaled stable appends", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const namespace = coordinatorNamespace(root);
		const events = path.join(namespace, "events");
		const legacyFile = path.join(events, "event-journal-index.v1.json");
		const migrationFile = path.join(events, "event-journal-index.v1.migrated.json");
		const stableIndexDir = path.join(events, "event-index");
		const historicalIds = Array.from(
			{ length: 96 },
			(_, index) => `legacy-scale-${index.toString().padStart(3, "0")}`,
		);
		for (const stableId of historicalIds)
			await appendCoordinatorEventForTest(namespace, {
				stableId,
				kind: "turn.completed",
				sessionId: "visible-session",
				summary: "historical event",
			});
		const journal = await fs.readFile(path.join(events, "event-journal.jsonl"), "utf8");
		const byId: Record<string, { seq: number; offset: number }> = {};
		let offset = 0;
		for (const line of journal.split("\n")) {
			if (line.trim()) {
				const event = JSON.parse(line) as { id: string; seq: number };
				byId[event.id] = { seq: event.seq, offset };
			}
			offset += Buffer.byteLength(line) + 1;
		}
		await fs.writeFile(legacyFile, JSON.stringify({ schema_version: 1, by_id: byId }));
		await fs.rm(migrationFile, { force: true });
		await fs.rm(stableIndexDir, { recursive: true, force: true });

		const recovered = await appendCoordinatorEventForTest(namespace, {
			stableId: historicalIds[37]!,
			kind: "turn.completed",
			sessionId: "visible-session",
			summary: "recovered historical event",
		});
		expect(recovered.id).toBe(historicalIds[37]);
		expect(await Bun.file(migrationFile).exists()).toBe(true);
		expect((await fs.readdir(stableIndexDir)).length).toBeGreaterThanOrEqual(historicalIds.length);
		await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		const legacyBefore = await fs.readFile(legacyFile);
		for (let index = 0; index < 128; index++)
			await appendCoordinatorEventForTest(namespace, {
				stableId: `legacy-scale-novel-${index.toString().padStart(3, "0")}`,
				kind: "turn.failed",
				sessionId: "visible-session",
				summary: "novel stable event",
			});
		expect(await fs.readFile(legacyFile)).toEqual(legacyBefore);
	}, 30_000);

	it("recovers a missing historical stable-id sidecar without duplicating the journal event", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const namespace = coordinatorNamespace(root);
		const events = path.join(namespace, "events");
		const stableId = "post-fsync-sidecar-gap";
		const first = await appendCoordinatorEventForTest(namespace, {
			stableId,
			kind: "turn.completed",
			sessionId: "visible-session",
			summary: "durable before sidecar",
		});
		// Simulate a burst after the fsync/sidecar crash without spending hundreds
		// of lock acquisitions. The missing sidecar must still recover its older row.
		const trailingRows = Array.from({ length: 600 }, (_, index) =>
			JSON.stringify({
				schema_version: 1,
				seq: first.seq + index + 1,
				id: `later-journal-event-${index.toString().padStart(3, "0")}`,
				timestamp: "2026-08-20T00:00:00.000Z",
				kind: "turn.completed",
				session_id: "visible-session",
				summary: "x".repeat(512),
			}),
		).join("\n");
		await fs.appendFile(path.join(events, "event-journal.jsonl"), `\n${trailingRows}\n`);
		await fs.writeFile(
			path.join(events, "event-seq.json"),
			JSON.stringify({ seq: first.seq + 600, updated_at: "2026-08-20T00:00:00.000Z" }),
		);
		await fs.rm(path.join(events, "event-index", `${createHash("sha256").update(stableId).digest("hex")}.json`), {
			force: true,
		});
		const recovered = await appendCoordinatorEventForTest(namespace, {
			stableId,
			kind: "turn.completed",
			sessionId: "visible-session",
			summary: "retry after sidecar gap",
		});
		expect(recovered).toMatchObject({ id: stableId, seq: first.seq });
		expect(
			await Bun.file(
				path.join(events, "event-index", `${createHash("sha256").update(stableId).digest("hex")}.json`),
			).exists(),
		).toBe(true);
		const matching = (await fs.readFile(path.join(events, "event-journal.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { id: string })
			.filter(event => event.id === stableId);
		expect(matching).toHaveLength(1);
	});

	it("scopes coordination status and preserves evidence fields", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls, [], undefined, [
			{
				sessionId: "visible-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
			{
				sessionId: "other-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
			},
		]);
		await registerSdkSession(server, root);
		await server.callTool("gjc_coordinator_register_session", {
			session_id: "other-session",
			cwd: root,
			idempotency_key: "audit-status-register-other",
			allow_mutation: true,
		});
		const evidencePath = path.join(root, "audit-evidence.txt");
		await fs.writeFile(evidencePath, "evidence");
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			status: "blocked",
			summary: "visible report",
			evidence_paths: [evidencePath],
			idempotency_key: "audit-status-visible",
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "other-session",
			status: "blocked",
			summary: "other report",
			idempotency_key: "audit-status-other",
			allow_mutation: true,
		});
		const global = await server.callTool("gjc_coordinator_read_coordination_status");
		expect(global).toMatchObject({ ok: true, summary: { sessions: 2, reports: 2 } });
		const scoped = await server.callTool("gjc_coordinator_read_coordination_status", {
			session_id: "visible-session",
		});
		expect(scoped).toMatchObject({
			ok: true,
			scope: { session_id: "visible-session" },
			summary: { sessions: 1, reports: 1 },
		});
		expect(JSON.stringify(scoped)).toContain("audit-evidence.txt");
	});

	it("maps hostile SDK failures to fixed public errors", async () => {
		const root = await tempRoot();
		const hostile = "Bearer secret-token https://controller.example.test/private /Users/secret/project";
		const server = createBrokerTestServer(root, {
			ensureBroker: async () => testBrokerDiscovery(),
			readSdkBrokerDiscovery: async () => testBrokerDiscovery(),
			connectBroker: async () =>
				({
					global: async () => {
						throw new SdkClientError("hostile_sdk_code", hostile);
					},
					close: async () => {},
				}) as unknown as SdkClient,
		});
		const response = await server.callTool("gjc_coordinator_list_sessions");
		expect(response).toEqual({
			ok: false,
			error: { code: "unavailable", message: "Coordinator service is unavailable." },
		});
		expect(JSON.stringify(response)).not.toContain("secret-token");
		expect(JSON.stringify(response)).not.toContain("https://controller.example.test");
		expect(JSON.stringify(response)).not.toContain("/Users/secret/project");
	});

	it("recovers a projected prompt receipt without an outer response or remote redispatch", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const args = {
			session_id: "visible-session",
			prompt: "receipt recovery",
			queue: true,
			idempotency_key: "receipt-recovery",
			allow_mutation: true,
		};
		const first = await server.callTool("gjc_coordinator_send_prompt", args);
		const receiptFile = path.join(
			coordinatorNamespace(root),
			"idempotency",
			`${createHash("sha256").update(args.idempotency_key).digest("hex")}.json`,
		);
		const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8")) as Record<string, unknown>;
		delete receipt.response;
		delete receipt.completed_at;
		await Bun.write(receiptFile, JSON.stringify({ ...receipt, state: "in_progress" }));
		const recovered = await server.callTool("gjc_coordinator_send_prompt", args);
		expect(recovered).toMatchObject({
			ok: true,
			session_id: first.session_id,
			turn_id: first.turn_id,
			result: first.result,
		});
		expect(await server.callTool("gjc_coordinator_send_prompt", args)).toEqual(recovered);
		const remoteDispatches = lifecycleControls(controls).filter(
			control =>
				control.operation === "turn.prompt" ||
				control.operation === "turn.follow_up" ||
				control.operation === "turn.abort_and_prompt",
		);
		expect(remoteDispatches).toHaveLength(1);
		expect(remoteDispatches[0]).toMatchObject({
			operation: "turn.follow_up",
			idempotencyKey: args.idempotency_key,
		});
	});

	it("recovers retained public deliveries without duplicating journal events", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		await injectPendingDeliveryForTest(server, "visible-session", "audit-retained-event", 1);
		const first = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		const firstEvents = first.events as Array<{ id: string }>;
		expect(firstEvents.filter(event => event.id === "audit-retained-event")).toHaveLength(1);
		const cursor = Number(first.next_after_seq);
		const second = await server.callTool("gjc_coordinator_watch_events", { after_seq: cursor, timeout_ms: 0 });
		const secondEvents = second.events as Array<{ id: string }>;
		expect(secondEvents.some(event => event.id === "audit-retained-event")).toBe(false);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const registry = JSON.parse(await fs.readFile(paths.registry, "utf8")) as Record<string, unknown>;
		expect((registry.retained_sessions as Record<string, unknown> | undefined)?.["visible-session"]).toBeUndefined();
	});

	it("reserves the non-queued prompt slot across coordinator processes", async () => {
		const root = await tempRoot();
		const controlsA: SdkControl[] = [];
		const controlsB: SdkControl[] = [];
		const brokerSessions = [
			{
				sessionId: "visible-session",
				locator: { cwd: root, worktreeRoot: null, stateRoot: path.join(root, ".gjc", "state") },
				live: true,
				endpointGeneration: 1,
				pid: 101,
				endpointMtimeMs: 1,
			},
		];
		const serverA = await createSdkControlServer(root, controlsA, [], undefined, brokerSessions);
		const serverB = await createSdkControlServer(root, controlsB, [], undefined, brokerSessions);
		await registerSdkSession(serverA, root);
		const [first, second] = await Promise.all([
			serverA.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "cross-process A",
				idempotency_key: "cross-process-a",
				allow_mutation: true,
			}),
			serverB.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "cross-process B",
				idempotency_key: "cross-process-b",
				allow_mutation: true,
			}),
		]);
		const responses = [first, second];
		expect(responses.filter(response => response.ok === true)).toHaveLength(1);
		expect(
			responses.filter(
				response => (response.error as Record<string, unknown> | undefined)?.code === "active_turn_exists",
			),
		).toHaveLength(1);
		const dispatches = [...controlsA, ...controlsB].filter(control => control.operation === "turn.prompt");
		expect(dispatches).toHaveLength(1);
	});

	it("preserves a terminal fence when a reserved prompt is acknowledged after sidecar reconciliation", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let server!: CoordinatorMcpServer;
		let reconciledTurnId: string | null = null;
		server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			controlResult: control =>
				control.operation === "turn.prompt"
					? { accepted: true, command_id: "barrier-command", turn_id: "barrier-runtime-turn" }
					: { accepted: true, command_id: "sdk-command-unrelated", turn_id: "sdk-turn-unrelated" },
			afterPromptReceiptPersisted: async sessionId => {
				const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
				const transaction = JSON.parse(await fs.readFile(transactionPath(paths, sessionId), "utf8")) as {
					canonical: {
						turns: Record<string, Record<string, unknown>>;
					};
					requests: { prompts: Record<string, Record<string, unknown>> };
				};
				const promptRequest = Object.values(transaction.requests.prompts)[0];
				expect(promptRequest).toMatchObject({ phase: "accepted", runtime_receipt: { accepted: true } });
				const reservation = Object.values(transaction.canonical.turns).find(turn => turn.status === "delivering");
				if (!reservation || typeof reservation.turn_id !== "string")
					throw new Error("missing delivering reservation");
				reconciledTurnId = reservation.turn_id;
				await patchSessionState(server, root, sessionId, {
					state: "completed",
					ready_for_input: false,
					current_turn_id: reservation.turn_id,
					last_turn_id: reservation.turn_id,
					source: "agent_session_event",
					live: false,
					updated_at: "2026-08-19T00:00:00.000Z",
					final_response: {
						text: "terminal sidecar result",
						format: "markdown",
						source: "runtime",
						artifact_path: null,
						truncated: false,
					},
				});
			},
		});
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "terminal barrier prompt",
			idempotency_key: "terminal-barrier-prompt",
			allow_mutation: true,
		});
		expect(typeof reconciledTurnId).toBe("string");
		expect(sent).toMatchObject({
			ok: true,
			turn_id: reconciledTurnId,
			active_turn_id: reconciledTurnId,
			status: "active",
			turn: { turn_id: reconciledTurnId, status: "active" },
			result: { accepted: true, command_id: "barrier-command", turn_id: "barrier-runtime-turn" },
		});
		const watched = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		const watchedEvents = watched.events as Array<Record<string, unknown>>;
		expect(watched).toMatchObject({
			ok: true,
			events: expect.arrayContaining([
				expect.objectContaining({ kind: "turn.completed", turn_id: reconciledTurnId }),
			]),
		});
		expect(
			watchedEvents.filter(event => event.turn_id === reconciledTurnId && event.kind === "turn.failed"),
		).toHaveLength(0);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			canonical: {
				turns: Record<string, Record<string, unknown>>;
				queue: Record<string, unknown>;
			};
			requests: { prompts: Record<string, Record<string, unknown>> };
		};
		const turn = transaction.canonical.turns[reconciledTurnId!];
		expect(turn).toMatchObject({
			status: "completed",
			terminal_fence: { status: "completed" },
			final_response: { text: "terminal sidecar result", source: "runtime" },
			error: null,
			delivery: {
				runtime_command_id: "barrier-command",
				runtime_turn_id: "barrier-runtime-turn",
				state: "acknowledged",
			},
		});
		expect(transaction.canonical.queue).toMatchObject({ active_turn_id: null, ordered_turn_ids: [] });
		const activeProjection = path.join(coordinatorNamespace(root), "active-turns", "visible-session.json");
		await expect(fs.access(activeProjection)).rejects.toThrow();
		const turnProjection = JSON.parse(
			await fs.readFile(path.join(coordinatorNamespace(root), "turns", `${reconciledTurnId}.json`), "utf8"),
		) as Record<string, unknown>;
		expect(turnProjection).toMatchObject({ turn_id: reconciledTurnId, status: "completed" });
		const journal = path.join(coordinatorNamespace(root), "events", "event-journal.jsonl");
		const lifecycleEvents = (await fs.readFile(journal, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.filter(event => event.turn_id === reconciledTurnId);
		const terminalEventIndex = lifecycleEvents.findIndex(
			event => event.kind === "turn.completed" || event.kind === "turn.failed",
		);
		expect(terminalEventIndex).toBeGreaterThanOrEqual(0);
		const activeEventIndices = lifecycleEvents.flatMap((event, index) =>
			event.kind === "turn.active" ? [index] : [],
		);
		expect(activeEventIndices.every(index => index < terminalEventIndex)).toBe(true);
		expect(lifecycleEvents.filter(event => event.kind === "turn.completed")).toHaveLength(1);
		expect(lifecycleEvents.filter(event => event.kind === "turn.acknowledged")).toHaveLength(1);
		const promptRequest = Object.values(transaction.requests.prompts)[0];
		expect(promptRequest).toMatchObject({
			phase: "completed",
			runtime_receipt: { accepted: true, command_id: "barrier-command", turn_id: "barrier-runtime-turn" },
		});
		expect(controls.filter(control => control.operation === "turn.prompt")).toHaveLength(1);
	});

	it("ignores a stale-authority terminal sidecar after a successor turn is accepted", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "first incarnation turn",
			idempotency_key: "old-incarnation-first",
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: first.turn_id,
			status: "completed",
			summary: "first turn complete",
			idempotency_key: "old-incarnation-first-terminal",
			allow_mutation: true,
		});
		const successor = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "successor turn",
			idempotency_key: "old-incarnation-successor",
			allow_mutation: true,
		});
		const staleStateFile = coordinatorSessionStatePath(root, "visible-session");
		const stalePrior = JSON.parse(await fs.readFile(staleStateFile, "utf8")) as Record<string, unknown>;
		await fs.writeFile(
			staleStateFile,
			JSON.stringify({
				...stalePrior,
				state: "completed",
				ready_for_input: false,
				current_turn_id: first.turn_id,
				last_turn_id: first.turn_id,
				source: "agent_session_event",
				live: false,
				endpoint_incarnation: "test-incarnation",
				sidecar_key_id: "stale-key",
				sidecar_signature: "forged",
				final_response: {
					text: "stale terminal output",
					format: "markdown",
					source: "runtime",
					artifact_path: null,
					truncated: false,
				},
			}),
		);
		await expect(
			server.callTool("gjc_coordinator_read_turn", { session_id: "visible-session", turn_id: successor.turn_id }),
		).resolves.toMatchObject({ ok: true, turn: { turn_id: successor.turn_id, status: "active" } });
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = await withSessionTransaction(paths, "visible-session", async current => current);
		const canonicalSuccessor = transaction.canonical.turns[String(successor.turn_id)]!;
		expect(canonicalSuccessor).toMatchObject({
			status: "active",
			final_response: { text: null, format: "markdown", source: null, artifact_path: null, truncated: false },
			terminal_fence: null,
		});
		const serializedSuccessor = JSON.stringify(canonicalSuccessor);
		expect(serializedSuccessor).not.toContain("stale terminal output");
		expect(serializedSuccessor).not.toContain('terminal_fence":{');
	});

	it("repairs projection metadata without changing canonical state for malformed runtime terminal responses", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "malformed runtime terminal",
			idempotency_key: "malformed-runtime-terminal",
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const wal = transactionPath(paths, "visible-session");
		const before = await fs.readFile(wal, "utf8");
		const beforeTransaction = JSON.parse(before) as {
			revision: number;
			endpoint: unknown;
			canonical: unknown;
		};
		const beforeRevision = beforeTransaction.revision;
		await patchSessionState(server, root, "visible-session", {
			state: "completed",
			ready_for_input: false,
			current_turn_id: sent.turn_id,
			last_turn_id: sent.turn_id,
			source: "agent_session_event",
			live: false,
			final_response: { text: 7, format: null, source: [], artifact_path: 1, truncated: "no" },
		});
		await expect(
			server.callTool("gjc_coordinator_read_turn", { session_id: "visible-session", turn_id: sent.turn_id }),
		).resolves.toMatchObject({ ok: true, turn: { turn_id: sent.turn_id, status: "active" } });
		const afterTransaction = JSON.parse(await fs.readFile(wal, "utf8")) as {
			revision: number;
			endpoint: unknown;
			canonical: unknown;
			projection: {
				applied_turns_revision: number;
				applied_reports_revision: number;
				applied_session_revision: number;
				applied_active_revision: number;
				applied_events_revision: number;
			};
		};
		// Repair may advance bookkeeping, but malformed runtime ingress must not alter business state or endpoint authority.
		expect(afterTransaction.canonical).toEqual(beforeTransaction.canonical);
		expect(afterTransaction.endpoint).toEqual(beforeTransaction.endpoint);
		expect(afterTransaction.revision).toBeGreaterThan(beforeRevision);
		expect(afterTransaction.projection).toMatchObject({
			applied_turns_revision: afterTransaction.revision,
			applied_reports_revision: afterTransaction.revision,
			applied_session_revision: afterTransaction.revision,
			applied_active_revision: afterTransaction.revision,
			applied_events_revision: afterTransaction.revision,
		});
	});

	it("persists and exactly replays a runtime gate rejection as an unlinked pending question", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "";
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			query =>
				query === "Q12"
					? {
							ok: true,
							page: {
								items: [sharedAskGate("rejected-answer", runtimeTurnId)],
								complete: true,
								revision: "rejected-answer",
							},
						}
					: { ok: true, page: { items: [], complete: true, revision: "context" } },
			undefined,
			undefined,
			undefined,
			{
				controlResult: control =>
					control.operation === "workflow.gate_answer" ? { ok: true, result: { status: "rejected" } } : undefined,
			},
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "rejected answer",
			idempotency_key: "rejected-answer-prompt",
			allow_mutation: true,
		});
		runtimeTurnId = String((sent.turn as Record<string, Record<string, unknown>>).delivery.runtime_turn_id);
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const question = (listed.questions as Array<Record<string, unknown>>)[0]!;
		const args = {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "rejected-answer",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "rejected-answer",
			allow_mutation: true,
		};
		const expected = {
			ok: false,
			schema_version: 1,
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "rejected-answer",
			error: { code: "validation_rejected", message: "Coordinator answer failed workflow validation." },
			question_status: "pending",
		};
		expect(await server.callTool("gjc_coordinator_submit_question_answer", args)).toEqual(expected);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const persisted = await withSessionTransaction(paths, "visible-session", async current => current);
		expect(persisted.canonical.questions["rejected-answer"]).toMatchObject({
			status: "pending",
			claim_fence_epoch: null,
			answer_request_id: null,
		});
		const request = Object.values(persisted.requests.answers)[0]!;
		expect(request).toMatchObject({
			phase: "rejected",
			question_id: "rejected-answer",
			safe_receipt: { status: "rejected" },
		});
		expect(await server.callTool("gjc_coordinator_submit_question_answer", args)).toEqual(expected);
		expect(controls.filter(control => control.operation === "workflow.gate_answer")).toHaveLength(1);
	});

	it("retains a rejected receipt while a corrected answer under a new key is accepted", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "";
		let answerCalls = 0;
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			query =>
				query === "Q12"
					? {
							ok: true,
							page: {
								items: [sharedAskGate("rejected-then-accepted", runtimeTurnId)],
								complete: true,
								revision: "rejected-then-accepted",
							},
						}
					: { ok: true, page: { items: [], complete: true, revision: "context" } },
			undefined,
			undefined,
			undefined,
			{
				controlResult: control => {
					if (control.operation !== "workflow.gate_answer") return undefined;
					answerCalls += 1;
					return answerCalls === 1
						? { ok: true, result: { status: "rejected" } }
						: { ok: true, result: { status: "accepted", resolved_at: "2026-08-20T00:00:00.000Z" } };
				},
			},
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "rejected then accepted answer",
			idempotency_key: "rejected-then-accepted-prompt",
			allow_mutation: true,
		});
		runtimeTurnId = String((sent.turn as Record<string, Record<string, unknown>>).delivery.runtime_turn_id);
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const question = (listed.questions as Array<Record<string, unknown>>)[0]!;
		const firstArgs = {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "rejected-then-accepted",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "rejected-then-accepted-first",
			allow_mutation: true,
		};
		const rejected = await server.callTool("gjc_coordinator_submit_question_answer", firstArgs);
		expect(rejected).toMatchObject({ ok: false, error: { code: "validation_rejected" }, question_status: "pending" });
		const accepted = await server.callTool("gjc_coordinator_submit_question_answer", {
			...firstArgs,
			idempotency_key: "rejected-then-accepted-corrected",
		});
		expect(accepted).toMatchObject({ ok: true, operation: "workflow.gate_answer", status: "accepted" });
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const persisted = await withSessionTransaction(paths, "visible-session", async current => current);
		expect(persisted.canonical.questions["rejected-then-accepted"]).toMatchObject({ status: "answered" });
		const requests = Object.values(persisted.requests.answers);
		expect(requests).toHaveLength(2);
		const rejectedRequest = requests.find(request => request.phase === "rejected");
		const completedRequest = requests.find(request => request.phase === "completed");
		expect(rejectedRequest).toMatchObject({ safe_receipt: { status: "rejected" } });
		expect(completedRequest).toMatchObject({ safe_receipt: { status: "accepted" } });
		expect(rejectedRequest?.request_id).not.toBe(completedRequest?.request_id);
		expect(persisted.canonical.questions["rejected-then-accepted"]).toMatchObject({
			status: "answered",
			answer_request_id: completedRequest?.request_id,
			claim_fence_epoch: completedRequest?.claim_fence_epoch,
		});
		expect(await server.callTool("gjc_coordinator_submit_question_answer", firstArgs)).toEqual(rejected);
		expect(answerCalls).toBe(2);
	});

	it("reverts an answer claim when runtime admission changes before dispatch and permits exact retry", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let runtimeTurnId = "";
		const admissionStarted = Promise.withResolvers<void>();
		const releaseAdmission = Promise.withResolvers<void>();
		const server = await createSdkControlServer(
			root,
			controls,
			[],
			query =>
				query === "Q12"
					? {
							ok: true,
							page: {
								items: [sharedAskGate("admission-race", runtimeTurnId)],
								complete: true,
								revision: "race",
							},
						}
					: { ok: true, page: { items: [], complete: true, revision: "context" } },
			undefined,
			undefined,
			undefined,
			{
				afterAnswerRemoteStarted: async () => {
					admissionStarted.resolve();
					await releaseAdmission.promise;
				},
				controlResult: control =>
					control.operation === "workflow.gate_answer"
						? { ok: true, result: { status: "accepted", resolved_at: "2026-08-20T00:00:00.000Z" } }
						: undefined,
			},
		);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "answer admission race",
			idempotency_key: "answer-admission-race-prompt",
			allow_mutation: true,
		});
		runtimeTurnId = String((sent.turn as Record<string, Record<string, unknown>>).delivery.runtime_turn_id);
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			ready_for_input: false,
			current_turn_id: sent.turn_id,
			last_turn_id: sent.turn_id,
			source: "agent_session_event",
			live: true,
			activity: { seq: 1, phase: "waiting", active_tool_count: 0, active_tools: [] },
		});
		const listed = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		const question = (listed.questions as Array<Record<string, unknown>>)[0]!;
		const args = {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			question_id: "admission-race",
			answer_binding: question.answer_binding,
			answer: { selected: ["opt_0"] },
			idempotency_key: "answer-admission-race",
			allow_mutation: true,
		};
		const admittedAnswer = server.callTool("gjc_coordinator_submit_question_answer", args);
		await admissionStarted.promise;
		await patchSessionState(server, root, "visible-session", { state: "running", ready_for_input: false });
		releaseAdmission.resolve();
		await expect(admittedAnswer).resolves.toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		expect(controls.filter(control => control.operation === "workflow.gate_answer")).toHaveLength(0);
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const reverted = await withSessionTransaction(paths, "visible-session", async current => current);
		expect(reverted.canonical.questions["admission-race"]).toMatchObject({
			status: "pending",
			answer_request_id: null,
		});
		expect(reverted.requests.answers).toEqual({});
		await patchSessionState(server, root, "visible-session", {
			state: "needs_user_input",
			ready_for_input: false,
			current_turn_id: sent.turn_id,
			last_turn_id: sent.turn_id,
			source: "agent_session_event",
			live: true,
		});
		await expect(server.callTool("gjc_coordinator_submit_question_answer", args)).resolves.toMatchObject({
			ok: true,
			status: "accepted",
		});
		expect(controls.filter(control => control.operation === "workflow.gate_answer")).toHaveLength(1);
	});

	it("repairs projections when terminal reconciliation wins after accepted finalization", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		let server!: CoordinatorMcpServer;
		let finalizedTurnId: string | null = null;
		let barrierCalls = 0;
		server = await createSdkControlServer(root, controls, [], undefined, undefined, undefined, undefined, {
			afterCanonicalTurnCommit: async sessionId => {
				barrierCalls += 1;
				const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
				const transaction = JSON.parse(await fs.readFile(transactionPath(paths, sessionId), "utf8")) as {
					canonical: { turns: Record<string, Record<string, unknown>> };
				};
				const finalized = Object.values(transaction.canonical.turns).find(
					turn => turn.status === "active" && turn.terminal_fence === null,
				);
				expect(finalized).toBeDefined();
				finalizedTurnId = String(finalized!.turn_id);
				await patchSessionState(server, root, sessionId, {
					state: "completed",
					ready_for_input: false,
					current_turn_id: finalizedTurnId,
					last_turn_id: finalizedTurnId,
					source: "agent_session_event",
					live: true,
					updated_at: "2026-08-19T00:00:00.000Z",
					final_response: {
						text: "terminal after finalization",
						format: "markdown",
						source: "runtime",
						artifact_path: null,
						truncated: false,
					},
				});
				await expect(
					server.callTool("gjc_coordinator_read_turn", {
						session_id: sessionId,
						turn_id: finalizedTurnId,
					}),
				).resolves.toMatchObject({
					ok: true,
					turn: { turn_id: finalizedTurnId, status: "completed" },
				});
			},
		});
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "terminal after finalization",
			idempotency_key: "terminal-after-finalization",
			allow_mutation: true,
		});
		expect(barrierCalls).toBe(1);
		expect(finalizedTurnId).not.toBeNull();
		expect(sent).toMatchObject({
			ok: true,
			turn_id: finalizedTurnId,
			active_turn_id: null,
			status: "completed",
			turn: { turn_id: finalizedTurnId, status: "completed" },
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const transaction = JSON.parse(await fs.readFile(transactionPath(paths, "visible-session"), "utf8")) as {
			canonical: {
				turns: Record<string, Record<string, unknown>>;
				queue: Record<string, unknown>;
			};
		};
		const turn = transaction.canonical.turns[finalizedTurnId!];
		expect(turn).toMatchObject({ status: "completed", terminal_fence: { status: "completed" } });
		expect(transaction.canonical.queue).toMatchObject({ active_turn_id: null, ordered_turn_ids: [] });
		const activeProjection = path.join(coordinatorNamespace(root), "active-turns", "visible-session.json");
		await expect(fs.access(activeProjection)).rejects.toThrow();
		const turnProjection = JSON.parse(
			await fs.readFile(path.join(coordinatorNamespace(root), "turns", `${finalizedTurnId}.json`), "utf8"),
		) as Record<string, unknown>;
		expect(turnProjection).toMatchObject({ turn_id: finalizedTurnId, status: "completed" });
		const sessionState = JSON.parse(
			await fs.readFile(path.join(coordinatorNamespace(root), "session-states", "visible-session.json"), "utf8"),
		) as Record<string, unknown>;
		expect(sessionState).toMatchObject({ state: "completed", current_turn_id: null });
	});

	it("atomically rejects close admission while a canonical turn is active", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "close admission",
			idempotency_key: "close-admission-prompt",
			allow_mutation: true,
		});
		const paths = coordinatorStatePaths(server.config.stateRoot, server.config.namespace.identity);
		const deletionId = "delete:visible-session:test-incarnation";
		const entry = {
			deletion_id: deletionId,
			session_id: "visible-session",
			endpoint_incarnation: "test-incarnation",
			operation_id: deletionId,
			key_digest: createHash("sha256").update(deletionId).digest("hex"),
			request_digest: createHash("sha256").update(deletionId).digest("hex"),
			close_key: deletionId,
			phase: "intent" as const,
			cleanup: { wal: false, turns: false, reports: false, session: false, events: false },
			authority_digest: createHash("sha256").update(deletionId).digest("hex"),
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		await expect(admitSessionClose(paths, entry)).rejects.toThrow("active_turn_exists");
		await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			turn_id: sent.turn_id,
			status: "completed",
			summary: "close admission can proceed",
			idempotency_key: "close-admission-terminal",
			allow_mutation: true,
		});
		// A turn that starts and completes after reaper preflight leaves no active
		// turn, but its canonical watermark must still reject idle close admission.
		await expect(
			admitSessionClose(paths, entry, { idleBeforeMs: Date.now() - server.config.sessionIdleTtlMs }),
		).rejects.toThrow("session_not_idle");
		await expect(admitSessionClose(paths, entry)).resolves.toMatchObject({ session_id: "visible-session" });
	});

	it("dedupes repeated acknowledgement observations by logical turn edge", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "ack edge",
			idempotency_key: "ack-edge-prompt",
			allow_mutation: true,
		});
		await server.callTool("gjc_coordinator_read_turn", { session_id: "visible-session", turn_id: sent.turn_id });
		await server.callTool("gjc_coordinator_read_turn", { session_id: "visible-session", turn_id: sent.turn_id });
		const journal = path.join(coordinatorNamespace(root), "events", "event-journal.jsonl");
		const acknowledged = (await fs.readFile(journal, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.filter(event => event.kind === "turn.acknowledged" && event.turn_id === sent.turn_id);
		expect(acknowledged).toHaveLength(1);
	});

	it("accepts a filtered limited-page watch cursor below the journal watermark", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const namespace = coordinatorNamespace(root);
		await appendCoordinatorEventForTest(namespace, {
			stableId: "audit-filtered-match",
			kind: "delegation.started",
			sessionId: "visible-session",
			summary: "filtered match",
		});
		await appendCoordinatorEventForTest(namespace, {
			stableId: "audit-filtered-tail",
			kind: "session.state_changed",
			sessionId: "visible-session",
			summary: "nonmatching tail",
		});
		const first = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: 0,
			event_types: ["delegation.started"],
			limit: 1,
			timeout_ms: 0,
		});
		expect(first).toMatchObject({ ok: true, events: [expect.objectContaining({ id: "audit-filtered-match" })] });
		expect(Number(first.next_after_seq)).toBeLessThan(Number(first.latest_seq));
		const resumed = await server.callTool("gjc_coordinator_watch_events", {
			after_seq: first.next_after_seq,
			event_types: ["delegation.started"],
			limit: 1,
			timeout_ms: 0,
		});
		expect(resumed).toMatchObject({ ok: true, events: [] });
	});

	it("rejects colon-containing session ids before durable creation state", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const response = await server.callTool("gjc_coordinator_register_session", {
			session_id: "colon:session",
			cwd: root,
			idempotency_key: "colon-session",
			allow_mutation: true,
		});
		expect(response).toMatchObject({ ok: false, error: { code: "invalid_session_id" } });
	});

	it("separates projection namespaces whose legacy labels collide", () => {
		const root = "/tmp/coordinator-state";
		const first = buildCoordinatorMcpConfig({
			GJC_COORDINATOR_MCP_STATE_ROOT: root,
			GJC_COORDINATOR_MCP_PROFILE: "team/a",
			GJC_COORDINATOR_MCP_REPO: "repo",
		});
		const second = buildCoordinatorMcpConfig({
			GJC_COORDINATOR_MCP_STATE_ROOT: root,
			GJC_COORDINATOR_MCP_PROFILE: "team:a",
			GJC_COORDINATOR_MCP_REPO: "repo",
		});
		expect(first.namespace.profile).toBe(second.namespace.profile);
		expect(coordinatorNamespace(root)).not.toBe(path.join(root, "local", "repo"));
		expect(first.namespace.identity).not.toBe(second.namespace.identity);
		expect(path.join(first.stateRoot, "v1", first.namespace.identity)).not.toBe(
			path.join(second.stateRoot, "v1", second.namespace.identity),
		);
	});

	it("quarantines imported reports with traversal ids", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const legacy = path.join(root, ".gjc", "coordinator-state", "local", "repo");
		await fs.mkdir(path.join(legacy, "sessions"), { recursive: true });
		await fs.mkdir(path.join(legacy, "reports"), { recursive: true });
		await fs.writeFile(
			path.join(legacy, "sessions", "visible-session.json"),
			JSON.stringify({
				namespace_identity: server.config.namespace.identity,
				session_id: "visible-session",
				cwd: root,
				broker_workspace: root,
				endpoint_incarnation: "legacy-incarnation",
			}),
		);
		const fileId = `report-${"a".repeat(64)}`;
		await fs.writeFile(
			path.join(legacy, "reports", `${fileId}.json`),
			JSON.stringify({ session_id: "visible-session", report_id: "../escape" }),
		);
		const response = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(response.ok).toBe(false);
	});

	it("quarantines every foreign legacy child in a same-session collision", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const legacy = path.join(root, ".gjc", "coordinator-state", "local", "repo");
		await fs.mkdir(path.join(legacy, "sessions"), { recursive: true });
		await fs.mkdir(path.join(legacy, "active-turns"), { recursive: true });
		await fs.writeFile(
			path.join(legacy, "sessions", "visible-session.json"),
			JSON.stringify({
				namespace_identity: server.config.namespace.identity,
				session_id: "visible-session",
				cwd: root,
				broker_workspace: root,
				endpoint_incarnation: "legacy-incarnation",
			}),
		);
		await fs.writeFile(
			path.join(legacy, "active-turns", "visible-session.json"),
			JSON.stringify({ namespace_identity: "foreign-namespace", session_id: "visible-session" }),
		);
		const response = await server.callTool("gjc_coordinator_list_questions", { session_id: "visible-session" });
		expect(response.ok).toBe(false);
	});

	it("revokes narrowed-root coordination status and watch disclosures", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		await server.callTool("gjc_coordinator_report_status", {
			status: "blocked",
			summary: "namespace report remains visible",
			idempotency_key: "narrowed-root-namespace-report",
			allow_mutation: true,
		});
		const narrowed = path.join(root, "narrowed");
		await fs.mkdir(narrowed);
		server.config.allowedRoots = [narrowed];
		const scopedStatus = await server.callTool("gjc_coordinator_read_coordination_status", {
			session_id: "visible-session",
		});
		expect(scopedStatus.ok).toBe(false);
		const globalStatus = await server.callTool("gjc_coordinator_read_coordination_status");
		expect(globalStatus).toMatchObject({
			ok: true,
			summary: { sessions: 0, turns: 0, reports: 1 },
			reports: [expect.objectContaining({ session_id: null, summary: "namespace report remains visible" })],
		});
		expect(JSON.stringify(globalStatus)).not.toContain("visible-session");
		const scopedWatch = await server.callTool("gjc_coordinator_watch_events", {
			session_id: "visible-session",
			after_seq: 0,
			timeout_ms: 0,
		});
		expect(scopedWatch.ok).toBe(false);
		const globalWatch = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0, timeout_ms: 0 });
		expect(globalWatch).toMatchObject({
			ok: true,
			events: [expect.objectContaining({ kind: "report.written", report_id: expect.any(String) })],
		});
	});
});
