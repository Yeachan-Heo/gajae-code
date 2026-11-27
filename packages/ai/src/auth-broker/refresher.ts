/**
 * Background OAuth refresh loop for the auth-broker server.
 *
 * Iterates active OAuth credentials at `refreshIntervalMs` cadence, refreshing
 * any whose `expires - Date.now() < refreshSkewMs`. Refresh single-flight
 * lives in {@link AuthStorage} so manual and background refreshes share the
 * same upstream attempt.
 * Definitively-failed credentials (invalid_grant / 401 not from network blip)
 * are disabled via {@link AuthStorage.disableCredentialById} so the next
 * snapshot pull surfaces a clean delete on the client.
 */
import { logger } from "@gajae-code/utils";
import type { AuthStorage } from "../auth-storage";
import { cleanReason } from "./redact";
import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types";

export interface AuthBrokerRefresherOptions {
	storage: AuthStorage;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Loop cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Override clock (tests). */
	now?: () => number;
}

const INVALID_GRANT_REGEX = /invalid_grant|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i;
const TRANSIENT_REGEX = /timeout|network|fetch failed|ECONNREFUSED/i;
const HTTP_401_403_REGEX = /\b(401|403)\b/;

function isDefinitiveFailure(errorMsg: string): boolean {
	if (INVALID_GRANT_REGEX.test(errorMsg)) return true;
	if (HTTP_401_403_REGEX.test(errorMsg) && !TRANSIENT_REGEX.test(errorMsg)) return true;
	return false;
}

export interface AuthBrokerRefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepAt: number;
}

export class AuthBrokerRefresher {
	readonly #storage: AuthStorage;
	readonly #refreshSkewMs: number;
	readonly #refreshIntervalMs: number;
	readonly #now: () => number;
	#timer: NodeJS.Timeout | undefined;
	#running = false;
	#nextSweepAt: number;
	constructor(opts: AuthBrokerRefresherOptions) {
		this.#storage = opts.storage;
		this.#refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#now = opts.now ?? Date.now;
		this.#nextSweepAt = this.#now();
	}

	start(): void {
		if (this.#timer !== undefined) return;
		// Refresh sweep is best-effort; kick once immediately so freshly-booted
		// brokers don't hand out near-expired tokens for the first interval.
		this.#nextSweepAt = this.#now();
		void this.tick();
		this.#timer = setInterval(() => {
			void this.tick();
		}, this.#refreshIntervalMs);
	}

	stop(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	getSchedule(): AuthBrokerRefresherSchedule {
		return {
			enabled: true,
			intervalMs: this.#refreshIntervalMs,
			skewMs: this.#refreshSkewMs,
			nextSweepAt: this.#nextSweepAt,
		};
	}

	/** Run one sweep. Exposed for tests. */
	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#nextSweepAt = this.#now();
		try {
			await this.#storage.reload();
			const snapshot = this.#storage.exportSnapshot();
			const now = this.#now();
			const deadline = now + this.#refreshSkewMs;
			const targets: number[] = [];
			for (const entry of snapshot.credentials) {
				if (entry.credential.type !== "oauth") continue;
				if (entry.credential.mcpBinding) continue;
				const expires = entry.credential.expires;
				if (typeof expires !== "number" || !Number.isFinite(expires)) continue;
				if (expires > deadline) continue;
				targets.push(entry.id);
			}
			await Promise.all(targets.map(id => this.#refreshOne(id)));
		} finally {
			this.#running = false;
			this.#nextSweepAt = this.#now() + this.#refreshIntervalMs;
		}
	}

	async #refreshOne(id: number): Promise<void> {
		try {
			await this.#storage.refreshCredentialById(id);
		} catch (error) {
			const rawErrorMsg = String(error);
			const errorMsg = cleanReason(error) ?? "Unknown refresh failure";
			if (isDefinitiveFailure(rawErrorMsg)) {
				logger.warn("auth-broker refresh failed definitively; disabling credential", {
					id,
					error: errorMsg,
				});
				try {
					this.#storage.disableCredentialById(id, `auth-broker refresh failed: ${errorMsg}`);
				} catch (disableError) {
					// The row is still active on disk; the next sweep retries the refresh and the disable.
					logger.warn("auth-broker could not disable a definitively failed credential", {
						id,
						error: cleanReason(disableError) ?? "Unknown disable failure",
					});
				}
			} else {
				logger.debug("auth-broker refresh failed (transient)", { id, error: errorMsg });
			}
		}
	}
}
