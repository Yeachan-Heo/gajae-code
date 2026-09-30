import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCoordinatorMcpConfig,
	type CoordinatorMcpConfig,
	coordinatorNamespacePath,
} from "../../src/coordinator-mcp/policy";
import {
	type CanonicalCreateIntentV1,
	type CoordinatorSessionTransactionV1,
	coordinatorStatePaths,
	createSessionTransaction,
	initializeCoordinatorNamespace,
	withSessionTransaction,
} from "../../src/coordinator-mcp/question-state";
import { projectSharedStateRoot } from "../../src/gjc-runtime/session-layout";

/**
 * Coordinator-mcp lifecycle fixtures for the post-#4731 durability layout.
 *
 * PR #4731 moved authoritative projections to
 * `<stateRoot>/v1/<namespace-id>/projections` and demoted the human-readable
 * `<stateRoot>/<profile>/<repo>/` tree to migration input only: a legacy
 * projection imports solely when it is namespace-scoped (`namespace_identity`)
 * and carries the sidecar verifier the canonical WAL requires. Tests that
 * hand-wrote unscoped legacy-layout session records stopped reaching the
 * lifecycle paths at all (`unknown_session`), which is a fixture gap — not a
 * runtime regression.
 *
 * This helper materializes the current-dev durable layout directly: an
 * initialized namespace registry, a canonical WAL transaction per session, and
 * the projection session row `reapSession` reads. It is the fixture-side
 * counterpart of the canonical suite's register-then-migrate flow. The WAL —
 * not the projection row — is the rebuild source, so idle staleness for the
 * reaper is stamped into `canonical.session` exactly like the canonical suite.
 */

export const FIXTURE_ENDPOINT_GENERATION = 1;
export const FIXTURE_ENDPOINT_MTIME_MS = 1;
/** Longer than the reaper's 30-minute idle TTL; matches the canonical suite's idle fixtures. */
export const FIXTURE_IDLE_AGE_MS = 31 * 60_000;

export function fixtureEndpointIncarnation(sessionId: string): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				endpointGeneration: FIXTURE_ENDPOINT_GENERATION,
				endpointMtimeMs: FIXTURE_ENDPOINT_MTIME_MS,
				pid: process.pid,
				sessionId,
			}),
		)
		.digest("hex");
}

/** A deterministic sidecar verifier; lifecycle tests never exercise signatures. */
function fixtureVerifier() {
	return { key_id: "a".repeat(64), public_key: `${"b".repeat(32)}fixture-public-key` };
}

export type CoordinatorSessionFixtureOptions = {
	/** Session id; also the projection filename stem. */
	sessionId: string;
	/** Workspace root the session is bound to (realpath'd before persisting). */
	cwd: string;
	/** `GJC_COORDINATOR_MCP_*` env the owning server is built with. */
	env: NodeJS.ProcessEnv;
	/** Extra projection-row fields (e.g. `ephemeral: true`). */
	overrides?: Record<string, unknown>;
	/**
	 * Stamp the canonical WAL session as created this many milliseconds ago.
	 * Must be set together with `activityAgeMs` to express "old session with
	 * recent activity" (which must NOT be reapable); alone it is the idle
	 * stamp for turn-less sessions.
	 */
	creationAgeMs?: number;
	/**
	 * Stamp the WAL turn watermark (`recovery.prompt_watermark_at` — the idle
	 * reaper's durable activity authority) this many milliseconds ago. Defaults
	 * to `creationAgeMs`.
	 */
	activityAgeMs?: number;
	/**
	 * Admit one canonical turn in the given status and make it the active turn.
	 * The WAL — not hand-written projection rows — is the only stable holder of
	 * active-turn state, because projection recovery rebuilds from it.
	 */
	activeTurn?: { turnId: string; status: "active" | "delivering" | "waiting_for_answer" | "completing" };
};

export type CoordinatorSessionFixture = {
	config: CoordinatorMcpConfig;
	namespaceDir: string;
	sessionFile: string;
	paths: ReturnType<typeof coordinatorStatePaths>;
};

/** Materializes one durable coordinator session: registry, canonical WAL, projection row. */
export async function writeDurableCoordinatorSession(
	options: CoordinatorSessionFixtureOptions,
): Promise<CoordinatorSessionFixture> {
	const config = buildCoordinatorMcpConfig(options.env);
	const namespaceDir = coordinatorNamespacePath(config);
	const paths = coordinatorStatePaths(config.stateRoot, config.namespace.identity);
	await initializeCoordinatorNamespace(paths);
	const realRoot = await fs.realpath(options.cwd);
	const creationAgeMs = options.creationAgeMs ?? options.activityAgeMs ?? FIXTURE_IDLE_AGE_MS;
	const activityAgeMs = options.activityAgeMs ?? creationAgeMs;
	const createdAt = new Date(Date.now() - creationAgeMs).toISOString();
	const activityAt = new Date(Date.now() - activityAgeMs).toISOString();

	const endpointIncarnationHash = fixtureEndpointIncarnation(options.sessionId);
	const intent: CanonicalCreateIntentV1 = {
		kind: "register",
		session: {
			schema_version: 1,
			namespace_id: config.namespace.identity,
			session_id: options.sessionId,
			cwd: realRoot,
			created_at: createdAt,
			updated_at: createdAt,
			mpreset: null,
			source: null,
			model: null,
			tmux: { session: null, window: null, pane: null },
			broker: {
				workspace: realRoot,
				endpoint_url: "",
				endpoint_generation: FIXTURE_ENDPOINT_GENERATION,
				endpoint_incarnation: endpointIncarnationHash,
				sidecar_verifier: fixtureVerifier(),
			},
			ephemeral: options.overrides?.ephemeral === true,
			visible: true,
		},
		initial_state: "ready_for_input",
		initial_events: [
			{ kind: "session.registered", entity: "session", entity_id: options.sessionId, created_at: createdAt },
		],
	};
	await createSessionTransaction(paths, intent);
	// The projection row the reaper reads is rebuilt from the WAL, so the
	// idle stamp (and any active turn) has to survive there (mirrors the
	// canonical idle/capacity fixtures). The activity watermark is what the
	// reaper actually reads, so an old session with recent activity stays
	// non-reapable — exactly the production invariant.
	await withSessionTransaction(paths, options.sessionId, async (current: CoordinatorSessionTransactionV1) => {
		const nextRevision = current.revision + 1;
		current.canonical.session.created_at = createdAt;
		current.canonical.session.updated_at = createdAt;
		current.recovery.prompt_watermark_at = activityAt;
		if (options.activeTurn) {
			current.canonical.turns[options.activeTurn.turnId] = {
				schema_version: 1,
				turn_id: options.activeTurn.turnId,
				session_id: options.sessionId,
				namespace_id: config.namespace.identity,
				status: options.activeTurn.status,
				prompt: { text: "fixture active turn", created_at: createdAt, source: "coordinator" },
				delivery: { delivered: false, queued: false, target: null, attempts: [] },
				runtime_provenance: null,
				question_ids: [],
				final_response: { text: null, format: "markdown", source: null, artifact_path: null, truncated: false },
				evidence: [],
				error: null,
				liveness: {},
				created_at: createdAt,
				updated_at: activityAt,
				started_at: createdAt,
				completed_at: null,
				terminal_fence: null,
			};
			current.canonical.queue.active_turn_id = options.activeTurn.turnId;
		}
		current.projection.applied_turns_revision = nextRevision;
		current.projection.applied_reports_revision = nextRevision;
		current.projection.applied_session_revision = nextRevision;
		current.projection.applied_active_revision = nextRevision;
		current.projection.applied_events_revision = nextRevision;
	});
	const sessionsDir = path.join(namespaceDir, "sessions");
	await fs.mkdir(sessionsDir, { recursive: true });
	const sessionFile = path.join(sessionsDir, `${options.sessionId}.json`);
	await Bun.write(
		sessionFile,
		`${JSON.stringify({
			session_id: options.sessionId,
			namespace_identity: config.namespace.identity,
			cwd: realRoot,
			created_at: createdAt,
			broker_workspace: realRoot,
			endpoint_generation: FIXTURE_ENDPOINT_GENERATION,
			endpoint_incarnation: endpointIncarnationHash,
			...options.overrides,
		})}\n`,
	);
	return { config, namespaceDir, sessionFile, paths };
}

/**
 * Broker session rows matching a durable fixture session. `live` rows describe
 * the pre-close index; `terminal` rows describe the post-close retention DR-1
 * proof (terminal, not live, exact generation + incarnation).
 */
export function fixtureBrokerRows(
	root: string,
	sessionId: string,
): {
	live: Record<string, unknown>;
	terminal: Record<string, unknown>;
} {
	const base = {
		sessionId,
		locator: { cwd: root, worktreeRoot: null, stateRoot: projectSharedStateRoot(root) },
		endpointGeneration: FIXTURE_ENDPOINT_GENERATION,
		pid: process.pid,
		endpointMtimeMs: FIXTURE_ENDPOINT_MTIME_MS,
	};
	return {
		live: { ...base, live: true, terminal: false, ambiguous: false },
		terminal: { ...base, live: false, terminal: true, ambiguous: false },
	};
}

/** A temp root that `afterEach` cleanup can collect. */
export async function coordinatorFixtureRoot(registry: string[]): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-fixture-"));
	registry.push(root);
	return root;
}
