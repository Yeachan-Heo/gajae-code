import { Snowflake } from "@gajae-code/utils";
import type { BrowserHandle, BrowserKindTag } from "./registry";
import type { ReadyInfo } from "./tab-protocol";

export const DEAD_TAB_RECOVERY_TTL_MS = 30_000;

export interface DeadTabRecoveryDescriptor {
	readonly token: string;
	readonly name: string;
	readonly ownerId?: string;
	readonly browser: BrowserHandle;
	readonly kindTag: BrowserKindTag;
	readonly targetId: string;
	readonly info: Readonly<ReadyInfo>;
	readonly dialogPolicy?: "accept" | "dismiss";
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface DeadTabRecoveryRegistration {
	name: string;
	ownerId?: string;
	browser: BrowserHandle;
	kindTag: BrowserKindTag;
	targetId: string;
	info: ReadyInfo;
	dialogPolicy?: "accept" | "dismiss";
}

export class DeadTabRecoveryDescriptorRegistry {
	#byToken = new Map<string, DeadTabRecoveryDescriptor>();
	#tokenByName = new Map<string, string>();

	constructor(private readonly ttlMs = DEAD_TAB_RECOVERY_TTL_MS) {}

	register(input: DeadTabRecoveryRegistration, now = Date.now()): DeadTabRecoveryDescriptor {
		this.invalidateName(input.name);
		const token = Snowflake.next();
		const descriptor: DeadTabRecoveryDescriptor = Object.freeze({
			...input,
			info: Object.freeze({ ...input.info, viewport: Object.freeze({ ...input.info.viewport }) }),
			token,
			createdAt: now,
			expiresAt: now + this.ttlMs,
		});
		this.#byToken.set(token, descriptor);
		this.#tokenByName.set(input.name, token);
		return descriptor;
	}

	peekByName(name: string, now = Date.now()): DeadTabRecoveryDescriptor | undefined {
		const token = this.#tokenByName.get(name);
		if (!token) return undefined;
		const descriptor = this.#byToken.get(token);
		if (!descriptor) {
			this.#tokenByName.delete(name);
			return undefined;
		}
		if (descriptor.expiresAt <= now) {
			this.#invalidateToken(token);
			return undefined;
		}
		return descriptor;
	}

	consume(token: string, ownerId: string | undefined, now = Date.now()): DeadTabRecoveryDescriptor | undefined {
		const descriptor = this.#byToken.get(token);
		if (!descriptor) return undefined;
		this.#invalidateToken(token);
		if (descriptor.expiresAt <= now) return undefined;
		if (descriptor.ownerId !== ownerId) return undefined;
		return descriptor;
	}

	invalidateName(name: string): void {
		const token = this.#tokenByName.get(name);
		if (token) this.#invalidateToken(token);
	}

	invalidateOwner(ownerId: string | null | undefined): void {
		if (!ownerId) return;
		for (const descriptor of [...this.#byToken.values()]) {
			if (descriptor.ownerId === ownerId) this.#invalidateToken(descriptor.token);
		}
	}

	clear(): void {
		this.#byToken.clear();
		this.#tokenByName.clear();
	}

	#invalidateToken(token: string): void {
		const descriptor = this.#byToken.get(token);
		this.#byToken.delete(token);
		if (descriptor && this.#tokenByName.get(descriptor.name) === token) this.#tokenByName.delete(descriptor.name);
	}
}
