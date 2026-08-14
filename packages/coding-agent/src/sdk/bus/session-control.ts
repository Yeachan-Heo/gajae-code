import {
	type GenericNotificationSessionSource,
	getCurrentTelegramActivationMarker,
	isProviderEffectivelyEnabled,
	type NotificationConfig,
	resolveGenericNotificationSessionEligibility,
	resolveGenericNotificationStreamPolicy,
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
export type TelegramDaemonPreflightResult = "ready" | "blocked_identity" | "failed";

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
	/** Rotates a running/default endpoint into Telegram-isolated chat scope. */
	isolateTelegram?(binding: BoundNotificationSession<Context>): Promise<NotificationEndpointStartResult>;
	/** Refresh mutable delivery policy from the same configuration snapshot used for reconciliation. */
	refreshPolicy?(binding: BoundNotificationSession<Context>, policy: NotificationRuntimePolicy): void;
	/** Enables delivery only after the controller has committed a stable policy. */
	activate?(binding: BoundNotificationSession<Context>): void;
}

export interface NotificationSessionStatus {
	eligible: boolean;
	locallyEnabled: boolean;
	genericSessionEnabled: boolean;
	genericEligibilitySource: GenericNotificationSessionSource;
	running: boolean;
}

export interface NotificationSessionReconcileResult {
	outcome: NotificationEndpointStartResult | "stopped";
	status: NotificationSessionStatus;
}

export interface NotificationRuntimePolicy {
	redact: boolean;
	verbosity: NotificationConfig["verbosity"];
	/** Generic live-frame delivery policy; never proof of provider effectiveness. */
	stream: boolean;
	mode: "provisional" | "committed";
}

export interface NotificationSessionControllerOptions {
	/** Gate A result, resolved once by the SDK from the canonical host predicate. */
	eligible: boolean;
	/** Reads the global-only, schema-default-resolved notification configuration. */
	getConfig(): NotificationConfig;
	/** Kept as a reference so test and embedding hosts can supply their own environment. */
	env?: NodeJS.ProcessEnv;
	/** This process was launched by a marked GJC child spawn site. */
	spawnedByGjc?: boolean;
}

/**
 * Shared owner of notification session policy.
 *
 * Gate A is captured at creation. Gate B is evaluated through the typed generic
 * session policy. Provider effectiveness remains separate; Telegram owner proof
 * runs only when Telegram is effective and has no inactive marker.
 */
const MAX_RECONCILE_ATTEMPTS = 3;

export class NotificationSessionController {
	readonly #eligible: boolean;
	readonly #getConfig: () => NotificationConfig;
	readonly #env: NodeJS.ProcessEnv;
	readonly #spawnedByGjc: boolean;
	readonly #disabledSessions = new Set<string>();
	/** Explicit per-session opt-in overrides only the generic GJC_NOTIFICATIONS=0 auto-admission suppression. */
	readonly #manualOptInSessions = new Set<string>();
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
		this.#spawnedByGjc = options.spawnedByGjc ?? false;
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
		if (this.#manualOptInSessions.delete(previousSessionId)) this.#manualOptInSessions.add(nextSessionId);
		if (this.#blockedRuntimeSessions.delete(previousSessionId)) this.#blockedRuntimeSessions.add(nextSessionId);
		if (this.#shuttingDownSessions.delete(previousSessionId)) this.#shuttingDownSessions.add(nextSessionId);

		// Operations are bound to the identity captured when they were queued. Moving
		// a predecessor operation to the successor makes successor startup wait for
		// predecessor teardown, while that teardown can itself await successor
		// authority: a session-switch deadlock. Leave new-session operations owned by
		// their new key and let the predecessor operation settle independently.
		this.#sessionOperations.delete(previousSessionId);
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
				this.#refreshPolicy(runtime, binding, { redact: true, verbosity: "lean", stream: false }, "provisional");
				let preserveSafeSibling = false;
				try {
					const cfg = this.#getConfig();
					preserveSafeSibling =
						isProviderEffectivelyEnabled(cfg, "discord") || isProviderEffectivelyEnabled(cfg, "slack");
				} catch {
					preserveSafeSibling = false;
				}
				if (preserveSafeSibling && runtime?.isolateTelegram) {
					this.#blockedRuntimeSessions.add(binding.sessionId);
					const outcome = await runtime.isolateTelegram(binding);
					if (outcome === "started" || outcome === "already") {
						this.#blockedRuntimeSessions.delete(binding.sessionId);
						const cfg = this.#getConfig();
						this.#refreshPolicy(
							runtime,
							binding,
							{
								redact: cfg.redact,
								verbosity: cfg.verbosity,
								stream: resolveGenericNotificationStreamPolicy({
									cfg,
									env: this.#env,
									genericSessionEnabled: true,
								}).enabled,
							},
							"committed",
						);
						runtime.activate?.(binding);
						return true;
					}
				}
				if (runtime?.isRunning(binding)) {
					const stopped = await runtime.stop(binding);
					if (!stopped || runtime.isRunning(binding)) {
						throw new Error("Notification runtime remained active while entering blocked identity state");
					}
				}
				this.#blockedRuntimeSessions.add(binding.sessionId);
				return true;
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
					this.#manualOptInSessions.add(binding.sessionId);
				} else {
					this.#disabledSessions.add(binding.sessionId);
					this.#manualOptInSessions.delete(binding.sessionId);
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
		const runtime = this.#runtime as NotificationSessionRuntime<Context> | undefined;
		for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
			this.#refreshPolicy(runtime, binding, { redact: true, verbosity: "lean", stream: false }, "provisional");
			let cfg: NotificationConfig;
			try {
				cfg = this.#getConfig();
			} catch {
				if (runtime?.isRunning(binding)) await runtime.stop(binding);
				return { outcome: "failed", status: this.#failClosedStatus(binding, runtime) };
			}
			const nonTelegramEffective =
				isProviderEffectivelyEnabled(cfg, "discord") || isProviderEffectivelyEnabled(cfg, "slack");
			if (nonTelegramEffective) this.#blockedRuntimeSessions.delete(binding.sessionId);
			const status = this.#status(binding, cfg, runtime);
			if (!status.genericSessionEnabled) {
				if (runtime && status.running) await runtime.stop(binding);
				if (!this.#isCurrentConfig(cfg)) continue;
				return { outcome: status.running ? "stopped" : "disabled", status: this.#status(binding, cfg, runtime) };
			}

			if (!runtime) return { outcome: "disabled", status };
			const telegramMarker = getCurrentTelegramActivationMarker(cfg);
			const telegramEffective = isProviderEffectivelyEnabled(cfg, "telegram");
			const nonTelegramEffectiveForTelegram =
				isProviderEffectivelyEnabled(cfg, "discord") || isProviderEffectivelyEnabled(cfg, "slack");
			if (telegramEffective && telegramMarker && !nonTelegramEffectiveForTelegram) {
				if (runtime.isRunning(binding)) await runtime.stop(binding);
				if (!this.#isCurrentConfig(cfg)) continue;
				return { outcome: "disabled", status: this.#status(binding, cfg, runtime) };
			}
			if (telegramEffective && !telegramMarker) {
				let ensured: TelegramDaemonPreflightResult | undefined;
				try {
					ensured = await runtime.ensureTelegramDaemon?.(binding);
				} catch {
					ensured = "failed";
				}
				if (!this.#isCurrentConfig(cfg)) continue;
				if (ensured !== "ready" && !nonTelegramEffectiveForTelegram) {
					if (runtime.isRunning(binding)) await runtime.stop(binding);
					this.#blockedRuntimeSessions.add(binding.sessionId);
					return {
						outcome: ensured === "failed" ? "failed" : "disabled",
						status: this.#status(binding, cfg, runtime),
					};
				}
				if (ensured !== "ready" && nonTelegramEffectiveForTelegram) {
					const isolated = await runtime.isolateTelegram?.(binding);
					if (isolated !== "started" && isolated !== "already") {
						if (runtime.isRunning(binding)) await runtime.stop(binding);
						this.#blockedRuntimeSessions.add(binding.sessionId);
						return { outcome: "failed", status: this.#status(binding, cfg, runtime) };
					}
				}
			}

			const current = this.#status(binding, cfg, runtime);
			if (!current.genericSessionEnabled || !this.#isCurrentConfig(cfg)) continue;
			this.#refreshPolicy(
				runtime,
				binding,
				{
					redact: cfg.redact,
					verbosity: cfg.verbosity,
					stream: resolveGenericNotificationStreamPolicy({
						cfg,
						env: this.#env,
						genericSessionEnabled: current.genericSessionEnabled,
					}).enabled,
				},
				"committed",
			);
			const outcome = current.running ? "already" : await runtime.start(binding);
			// start() may have created a cold runtime after the first committed refresh.
			// Reapply the stable policy before activate() exposes any notification output.
			this.#refreshPolicy(
				runtime,
				binding,
				{
					redact: cfg.redact,
					verbosity: cfg.verbosity,
					stream: resolveGenericNotificationStreamPolicy({
						cfg,
						env: this.#env,
						genericSessionEnabled: current.genericSessionEnabled,
					}).enabled,
				},
				"committed",
			);
			if (!this.#isCurrentConfig(cfg)) {
				this.#refreshPolicy(runtime, binding, { redact: true, verbosity: "lean", stream: false }, "provisional");
				const stopped = runtime.isRunning(binding) ? await runtime.stop(binding) : true;
				if (!stopped || runtime.isRunning(binding)) {
					return { outcome: "failed", status: this.#status(binding, this.#getConfig(), runtime) };
				}
				continue;
			}
			runtime.activate?.(binding);
			const afterStart = this.#status(binding, cfg, runtime);
			if (!afterStart.genericSessionEnabled) {
				if (afterStart.running) await runtime.stop(binding);
				return {
					outcome: afterStart.running ? "stopped" : "disabled",
					status: this.#status(binding, cfg, runtime),
				};
			}
			return { outcome, status: afterStart };
		}

		this.#refreshPolicy(runtime, binding, { redact: true, verbosity: "lean", stream: false }, "provisional");
		let cfg: NotificationConfig;
		try {
			cfg = this.#getConfig();
		} catch {
			if (runtime?.isRunning(binding)) await runtime.stop(binding);
			return { outcome: "failed", status: this.#failClosedStatus(binding, runtime) };
		}
		const status = this.#status(binding, cfg, runtime);
		if (!runtime || !status.running) return { outcome: "disabled", status };
		const stopped = await runtime.stop(binding);
		const finalStatus = this.#status(binding, cfg, runtime);
		return { outcome: stopped && !finalStatus.running ? "stopped" : "failed", status: finalStatus };
	}

	#failClosedStatus<Context extends NotificationSessionContext>(
		binding: BoundNotificationSession<Context>,
		runtime: NotificationSessionRuntime<Context> | undefined,
	): NotificationSessionStatus {
		return {
			eligible: this.#eligible,
			locallyEnabled: false,
			genericSessionEnabled: false,
			genericEligibilitySource: "none",
			running: runtime?.isRunning(binding) ?? false,
		};
	}

	#refreshPolicy<Context extends NotificationSessionContext>(
		runtime: NotificationSessionRuntime<Context> | undefined,
		binding: BoundNotificationSession<Context>,
		policy: Omit<NotificationRuntimePolicy, "mode">,
		mode: NotificationRuntimePolicy["mode"],
	): void {
		runtime?.refreshPolicy?.(binding, { ...policy, mode });
	}

	#isCurrentConfig(cfg: NotificationConfig): boolean {
		try {
			return Bun.deepEquals(this.#getConfig(), cfg, true);
		} catch {
			return false;
		}
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
		const manualOptIn = this.#manualOptInSessions.has(binding.sessionId);
		const eligibilityEnv =
			manualOptIn && this.#env.GJC_NOTIFICATIONS === "0"
				? { ...this.#env, GJC_NOTIFICATIONS: undefined }
				: this.#env;
		const eligibility = resolveGenericNotificationSessionEligibility({
			cfg,
			env: eligibilityEnv,
			sessionDisabled: !locallyEnabled,
			spawnedByGjc: this.#spawnedByGjc,
		});
		const telegramMarkerBlocksOnlyProvider =
			Boolean(getCurrentTelegramActivationMarker(cfg)) &&
			isProviderEffectivelyEnabled(cfg, "telegram") &&
			!isProviderEffectivelyEnabled(cfg, "discord") &&
			!isProviderEffectivelyEnabled(cfg, "slack");
		const telegramBlockedWithoutSibling =
			blockedRuntime && !isProviderEffectivelyEnabled(cfg, "discord") && !isProviderEffectivelyEnabled(cfg, "slack");
		const genericSessionEnabled =
			!telegramBlockedWithoutSibling &&
			!shuttingDown &&
			!telegramMarkerBlocksOnlyProvider &&
			this.#eligible &&
			eligibility.enabled;
		return {
			eligible: this.#eligible,
			locallyEnabled,
			genericSessionEnabled,
			genericEligibilitySource: eligibility.source,
			running: runtime?.isRunning(binding) ?? false,
		};
	}
}
