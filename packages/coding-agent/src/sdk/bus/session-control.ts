import {
	getCurrentTelegramActivationMarker,
	isSessionNotificationsEnabled,
	isTelegramConfigured,
	type NotificationConfig,
} from "./config";

/** Minimal session-manager surface shared by extension, TUI, and headless hosts. */
export interface NotificationSessionContext {
	sessionManager: {
		getCwd(): string;
		getSessionId(): string;
	};
}

/** A snapshot of the current session, resolved from the session manager per operation. */
export interface BoundNotificationSession<Context extends NotificationSessionContext = NotificationSessionContext> {
	readonly context: Context;
	readonly cwd: string;
	readonly sessionId: string;
	unbind(): void;
}

export type NotificationEndpointStartResult = "started" | "already" | "disabled" | "failed";
export type TelegramDaemonPreflightResult = "ready" | "blocked_identity";

/**
 * The endpoint implementation is deliberately injected. The controller owns
 * policy and session-local state while the extension continues to own its
 * concrete NotificationServer resources.
 */
export interface NotificationSessionRuntime<Context extends NotificationSessionContext = NotificationSessionContext> {
	isRunning(binding: BoundNotificationSession<Context>): boolean;
	start(binding: BoundNotificationSession<Context>): Promise<NotificationEndpointStartResult>;
	stop(binding: BoundNotificationSession<Context>): Promise<boolean>;
	/**
	 * Proves the complete Telegram owner identity before a generic endpoint can
	 * emit a frame. `blocked_identity` is fail-closed and starts nothing.
	 */
	ensureTelegramDaemon?(binding: BoundNotificationSession<Context>): Promise<TelegramDaemonPreflightResult>;
}

export interface NotificationSessionStatus {
	eligible: boolean;
	locallyEnabled: boolean;
	effectiveEnabled: boolean;
	running: boolean;
	environment: "off" | "explicit" | "token" | "default";
}

export interface NotificationSessionReconcileResult {
	outcome: NotificationEndpointStartResult | "stopped";
	status: NotificationSessionStatus;
}

export interface NotificationSessionControllerOptions {
	/** Gate A result, resolved once by the SDK from the canonical host predicate. */
	eligible: boolean;
	/** Reads the global-only, schema-default-resolved notification configuration. */
	getConfig(): NotificationConfig;
	/** Kept as a reference so test and embedding hosts can supply their own environment. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Shared owner of notification session policy.
 *
 * Gate A is captured at creation. Gate B is evaluated for each session
 * operation with `isSessionNotificationsEnabled`. Gate C verifies complete
 * Telegram ownership before a generic endpoint is allowed to start.
 */
export class NotificationSessionController {
	readonly #eligible: boolean;
	readonly #getConfig: () => NotificationConfig;
	readonly #env: NodeJS.ProcessEnv;
	readonly #disabledSessions = new Set<string>();
	/** Sessions held inactive after a post-commit foreign daemon identity race. */
	readonly #blockedRuntimeSessions = new Set<string>();
	/** Sessions closed during host shutdown; no queued operation may restart them. */
	readonly #shuttingDownSessions = new Set<string>();
	/** Serializes endpoint mutations for each bound session snapshot. */
	readonly #sessionOperations = new Map<string, Promise<void>>();
	#runtime: NotificationSessionRuntime<NotificationSessionContext> | undefined;

	constructor(options: NotificationSessionControllerOptions) {
		this.#eligible = options.eligible;
		this.#getConfig = options.getConfig;
		this.#env = options.env ?? process.env;
	}

	/** Attach the concrete generic endpoint implementation used by this host. */
	attachRuntime<Context extends NotificationSessionContext>(runtime: NotificationSessionRuntime<Context>): () => void {
		const attached = runtime as unknown as NotificationSessionRuntime<NotificationSessionContext>;
		this.#runtime = attached;
		return () => {
			if (this.#runtime === attached) this.#runtime = undefined;
		};
	}

	/**
	 * Bind a fresh session snapshot. Callers should not cache it: cwd and session
	 * id may change on `/new`, fork, or resume.
	 */
	bind<Context extends NotificationSessionContext>(context: Context): BoundNotificationSession<Context> {
		let bound = true;
		const getCwd = context.sessionManager.getCwd;
		const cwd =
			typeof getCwd === "function" ? getCwd.call(context.sessionManager) : (context as { cwd?: unknown }).cwd;
		if (typeof cwd !== "string" || cwd.length === 0) {
			throw new Error("Notification session context does not expose a cwd.");
		}
		return {
			cwd,
			sessionId: context.sessionManager.getSessionId(),
			unbind: () => {
				bound = false;
			},
			get context() {
				if (!bound) throw new Error("Notification session binding has been released.");
				return context;
			},
		};
	}

	/** Preserve session-local safety state and pending-operation ownership across a session rekey. */
	rekeySession(previousSessionId: string, nextSessionId: string): void {
		if (previousSessionId === nextSessionId) return;
		if (this.#disabledSessions.delete(previousSessionId)) this.#disabledSessions.add(nextSessionId);
		if (this.#blockedRuntimeSessions.delete(previousSessionId)) this.#blockedRuntimeSessions.add(nextSessionId);
		if (this.#shuttingDownSessions.delete(previousSessionId)) this.#shuttingDownSessions.add(nextSessionId);

		const previousOperation = this.#sessionOperations.get(previousSessionId);
		if (!previousOperation) return;
		const nextOperation = this.#sessionOperations.get(nextSessionId);
		const completion = nextOperation ? previousOperation.then(() => nextOperation) : previousOperation;
		this.#sessionOperations.delete(previousSessionId);
		this.#sessionOperations.set(nextSessionId, completion);
		void completion.then(() => {
			if (this.#sessionOperations.get(nextSessionId) === completion) {
				this.#sessionOperations.delete(nextSessionId);
			}
		});
	}

	query<Context extends NotificationSessionContext>(context: Context): NotificationSessionStatus {
		const binding = this.bind(context);
		try {
			return this.#query(binding);
		} finally {
			binding.unbind();
		}
	}

	/** Stop the current endpoint during host shutdown without changing local preference. */
	async stopCurrentSession<Context extends NotificationSessionContext>(context: Context): Promise<boolean> {
		const binding = this.bind(context);
		try {
			// Set this before joining the queue so an in-flight start self-stops before
			// shutdown resolves, and no later operation can restart this session.
			this.#shuttingDownSessions.add(binding.sessionId);
			return await this.#enqueue(binding, async () => {
				const runtime = this.#runtime as NotificationSessionRuntime<Context> | undefined;
				return runtime?.isRunning(binding) ? await runtime.stop(binding) : false;
			});
		} finally {
			binding.unbind();
		}
	}

	/**
	 * Hold this session's endpoint inactive after a foreign-daemon identity race.
	 * The block remains until an explicit same-identity reconnect or CAS restore clears it.
	 */
	async enterBlockedRuntime<Context extends NotificationSessionContext>(context: Context): Promise<boolean> {
		const binding = this.bind(context);
		try {
			return await this.#enqueue(binding, async () => {
				const runtime = this.#runtime as NotificationSessionRuntime<Context> | undefined;
				const stopped = runtime?.isRunning(binding) ? await runtime.stop(binding) : false;
				this.#blockedRuntimeSessions.add(binding.sessionId);
				return stopped;
			});
		} finally {
			binding.unbind();
		}
	}

	/** Clear a block only after the caller has verified a safe same-identity reconnect or restore. */
	async clearBlockedRuntime<Context extends NotificationSessionContext>(context: Context): Promise<void> {
		const binding = this.bind(context);
		try {
			await this.#enqueue(binding, async () => {
				this.#blockedRuntimeSessions.delete(binding.sessionId);
			});
		} finally {
			binding.unbind();
		}
	}

	async setLocalEnabled<Context extends NotificationSessionContext>(
		context: Context,
		enabled: boolean,
	): Promise<NotificationSessionReconcileResult> {
		const binding = this.bind(context);
		try {
			return await this.#enqueue(binding, async () => {
				if (enabled) {
					this.#disabledSessions.delete(binding.sessionId);
					this.#shuttingDownSessions.delete(binding.sessionId);
				} else {
					this.#disabledSessions.add(binding.sessionId);
				}
				return await this.#reconcile(binding);
			});
		} finally {
			binding.unbind();
		}
	}

	async reconcileCurrentSession<Context extends NotificationSessionContext>(
		context: Context,
	): Promise<NotificationSessionReconcileResult> {
		const binding = this.bind(context);
		try {
			return await this.#enqueue(binding, () => this.#reconcile(binding));
		} finally {
			binding.unbind();
		}
	}

	async #reconcile<Context extends NotificationSessionContext>(
		binding: BoundNotificationSession<Context>,
	): Promise<NotificationSessionReconcileResult> {
		const cfg = this.#getConfig();
		const runtime = this.#runtime as NotificationSessionRuntime<Context> | undefined;
		const status = this.#status(binding, cfg, runtime);
		if (!status.effectiveEnabled) {
			if (runtime && status.running) await runtime.stop(binding);
			return { outcome: status.running ? "stopped" : "disabled", status: this.#status(binding, cfg, runtime) };
		}

		if (!runtime) return { outcome: "disabled", status };
		if (getCurrentTelegramActivationMarker(cfg)) {
			if (runtime.isRunning(binding)) await runtime.stop(binding);
			this.#blockedRuntimeSessions.add(binding.sessionId);
			return { outcome: "disabled", status: this.#status(binding, cfg, runtime) };
		}
		if (isTelegramConfigured(cfg)) {
			try {
				const ensured = await runtime.ensureTelegramDaemon?.(binding);
				if (ensured !== "ready") {
					if (runtime.isRunning(binding)) await runtime.stop(binding);
					this.#blockedRuntimeSessions.add(binding.sessionId);
					return { outcome: "disabled", status: this.#status(binding, cfg, runtime) };
				}
			} catch {
				if (runtime.isRunning(binding)) await runtime.stop(binding);
				this.#blockedRuntimeSessions.add(binding.sessionId);
				return { outcome: "failed", status: this.#status(binding, cfg, runtime) };
			}
		}

		const current = this.#status(binding, cfg, runtime);
		if (!current.effectiveEnabled) {
			if (current.running) await runtime.stop(binding);
			return { outcome: current.running ? "stopped" : "disabled", status: this.#status(binding, cfg, runtime) };
		}
		const outcome = current.running ? "already" : await runtime.start(binding);
		const afterStart = this.#status(binding, cfg, runtime);
		if (!afterStart.effectiveEnabled) {
			if (afterStart.running) await runtime.stop(binding);
			return { outcome: afterStart.running ? "stopped" : "disabled", status: this.#status(binding, cfg, runtime) };
		}
		return { outcome, status: this.#status(binding, cfg, runtime) };
	}

	#enqueue<Context extends NotificationSessionContext, Result>(
		binding: BoundNotificationSession<Context>,
		operation: () => Promise<Result>,
	): Promise<Result> {
		const previous = this.#sessionOperations.get(binding.sessionId) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const completion = result.then(
			() => undefined,
			() => undefined,
		);
		this.#sessionOperations.set(binding.sessionId, completion);
		void completion.then(() => {
			if (this.#sessionOperations.get(binding.sessionId) === completion) {
				this.#sessionOperations.delete(binding.sessionId);
			}
		});
		return result;
	}

	#query<Context extends NotificationSessionContext>(
		binding: BoundNotificationSession<Context>,
	): NotificationSessionStatus {
		const cfg = this.#getConfig();
		return this.#status(binding, cfg, this.#runtime as NotificationSessionRuntime<Context> | undefined);
	}

	#status<Context extends NotificationSessionContext>(
		binding: BoundNotificationSession<Context>,
		cfg: NotificationConfig,
		runtime: NotificationSessionRuntime<Context> | undefined,
	): NotificationSessionStatus {
		const locallyEnabled = !this.#disabledSessions.has(binding.sessionId);
		const blockedRuntime = this.#blockedRuntimeSessions.has(binding.sessionId);
		const shuttingDown = this.#shuttingDownSessions.has(binding.sessionId);
		const effectiveEnabled =
			!blockedRuntime &&
			!shuttingDown &&
			!getCurrentTelegramActivationMarker(cfg) &&
			this.#eligible &&
			isSessionNotificationsEnabled({ cfg, env: this.#env, sessionDisabled: !locallyEnabled });
		const environment =
			this.#env.GJC_NOTIFICATIONS === "0"
				? "off"
				: this.#env.GJC_NOTIFICATIONS === "1"
					? "explicit"
					: this.#env.GJC_NOTIFICATIONS_TOKEN
						? "token"
						: "default";
		return {
			eligible: this.#eligible,
			locallyEnabled,
			effectiveEnabled,
			running: runtime?.isRunning(binding) ?? false,
			environment,
		};
	}
}
