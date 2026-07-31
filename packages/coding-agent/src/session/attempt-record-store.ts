import type { AttemptScope, AttemptScopeAuthority } from "@gajae-code/agent-core/attempt-scope";

export type AttemptExecutionState = "unknown" | "clean" | "executed";

interface AttemptRecord {
	readonly scope: AttemptScope;
	state: AttemptExecutionState;
}

type RetireCapableAuthority = AttemptScopeAuthority & {
	unregisterSide?: (lineage: AttemptScope["lineage"]) => void;
};

const RECORD_LRU_CAP = 1024;

function scopeKey(scope: AttemptScope): string {
	return `${scope.lineage}:${scope.attemptId}:${scope.generation}`;
}

/**
 * Tracks whether an attempt has had an extension handler delivered to it.
 *
 * Records are deliberately established in two phases: allocation registers an
 * `unknown` record, then the session marks it `clean` immediately before the
 * first handler-capable delivery can occur. The runner changes a clean record
 * to `executed` immediately before invoking its first handler.
 */
export class AttemptRecordStore {
	readonly #authority: RetireCapableAuthority;
	readonly #records = new Map<string, AttemptRecord>();

	constructor(authority: AttemptScopeAuthority) {
		this.#authority = authority;
	}

	register(scope: AttemptScope): boolean {
		if (!this.#authority.isCurrent(scope)) return false;
		const key = scopeKey(scope);
		const existing = this.#records.get(key);
		if (existing) {
			this.#touch(key, existing);
			return true;
		}
		this.#records.set(key, { scope, state: "unknown" });
		this.#evictIfNeeded();
		return true;
	}

	establishClean(scope: AttemptScope): boolean {
		if (!this.#authority.isCurrent(scope)) return false;
		const key = scopeKey(scope);
		const record = this.#records.get(key);
		if (!record) return false;
		if (record.state === "unknown") record.state = "clean";
		if (record.state === "clean") this.#touch(key, record);
		return record.state === "clean";
	}

	markExecuted(scope: AttemptScope): boolean {
		if (!this.#authority.isCurrent(scope)) return false;
		const key = scopeKey(scope);
		const record = this.#records.get(key);
		if (!record) return false;
		if (record.state === "executed") {
			this.#touch(key, record);
			return true;
		}
		if (record.state !== "clean") return false;
		record.state = "executed";
		this.#touch(key, record);
		return true;
	}

	isClean(scope: AttemptScope): boolean {
		if (!this.#authority.isCurrent(scope)) return false;
		return this.#records.get(scopeKey(scope))?.state === "clean";
	}

	retire(scope: AttemptScope): boolean {
		const key = scopeKey(scope);
		const deleted = this.#records.delete(key);
		if (scope.lineage !== "main") this.#authority.unregisterSide?.(scope.lineage);
		return deleted;
	}

	#touch(key: string, record: AttemptRecord): void {
		this.#records.delete(key);
		this.#records.set(key, record);
	}

	#evictIfNeeded(): void {
		while (this.#records.size > RECORD_LRU_CAP) {
			const oldest = this.#records.keys().next().value as string | undefined;
			if (oldest === undefined) return;
			const record = this.#records.get(oldest);
			if (!record) {
				this.#records.delete(oldest);
				continue;
			}
			// Never evict a record whose scope is still current (live attempt).
			if (this.#authority.isCurrent(record.scope)) break;
			this.#records.delete(oldest);
			if (record.scope.lineage !== "main") this.#authority.unregisterSide?.(record.scope.lineage);
		}
	}
}
