import {
	type ActivityControls,
	type CreateAgentSessionResult,
	createActivityControls,
} from "@gajae-code/coding-agent/sdk";
import { redactCrashSecrets } from "@gajae-code/utils/crash-redaction";
import type {
	DesktopMcpAction,
	DesktopMcpErrorCode,
	DesktopMcpOperationResult,
	DesktopMcpRef,
	DesktopMcpScope,
	DesktopMcpServer,
	DesktopMcpSnapshot,
} from "./mcp-protocol";

export const DESKTOP_MCP_LIMITS = { servers: 100, fieldChars: 128 } as const;

const REASONS: Record<DesktopMcpErrorCode, string> = {
	invalid_input: "Invalid MCP control input.",
	unavailable: "The captured factory result has no available MCP controls.",
	disposed: "MCP controls or their session have been disposed.",
	stale_session: "The session has changed; reopen MCP controls.",
	session_transitioning: "The session is transitioning; retry after it settles.",
	stale_connection: "The connection has changed; reopen MCP controls.",
	not_found: "This MCP reference is unknown or has expired.",
	stale_target: "The MCP server binding has changed; refresh its reference.",
	busy: "The SDK lifecycle is busy; retry after it settles.",
	unsupported: "The public SDK does not support this control.",
	unknown_effect: "MCP control completion was not proven. Refresh status before retrying.",
	backend_failure: "The SDK MCP operation failed. Completion was not proven.",
	redaction_failed: "MCP display redaction failed; content was withheld.",
};

export class DesktopMcpError extends Error {
	constructor(readonly code: DesktopMcpErrorCode) {
		super(REASONS[code]);
		this.name = "DesktopMcpError";
	}
}

export interface DesktopMcpOptions {
	connectionGeneration: string;
	/** Host policy, invoked before truncation. Throwing or returning a non-string fails closed. */
	redact(text: string): string;
}

type FactoryResult = Pick<CreateAgentSessionResult, "session" | "mcpManager">;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopMcpError("invalid_input");
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new DesktopMcpError("invalid_input");
	const names = Reflect.ownKeys(value);
	if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)))
		throw new DesktopMcpError("invalid_input");
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new DesktopMcpError("invalid_input");
	}
	return value as Record<string, unknown>;
}

function reference(value: unknown): DesktopMcpRef {
	const parsed = object(value, ["key", "sessionGeneration", "connectionGeneration"]);
	if (
		typeof parsed.key !== "string" ||
		!parsed.key ||
		parsed.key.length > 128 ||
		typeof parsed.connectionGeneration !== "string" ||
		!parsed.connectionGeneration ||
		parsed.connectionGeneration.length > 128 ||
		typeof parsed.sessionGeneration !== "number" ||
		!Number.isSafeInteger(parsed.sessionGeneration) ||
		parsed.sessionGeneration < 0
	)
		throw new DesktopMcpError("invalid_input");
	return {
		key: parsed.key,
		connectionGeneration: parsed.connectionGeneration,
		sessionGeneration: parsed.sessionGeneration,
	};
}

function action(value: unknown): DesktopMcpAction {
	if (value !== "suspend" && value !== "resume" && value !== "reconnect") throw new DesktopMcpError("invalid_input");
	return value;
}

/** Only an explicit allowlist of public SDK codes may cross the host boundary. */
function failure(error: unknown): DesktopMcpError {
	if (error instanceof DesktopMcpError) return error;
	const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
	const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
	switch (code) {
		case "invalid_input":
		case "disposed":
		case "stale_session":
		case "session_transitioning":
		case "stale_target":
		case "not_found":
		case "busy":
		case "unsupported":
		case "unavailable":
		case "unknown_effect":
			return new DesktopMcpError(code);
		default:
			return new DesktopMcpError("backend_failure");
	}
}

/** Wire projection only. The public SDK owns references, admission and cancellation. */
export class DesktopMcpController {
	readonly #controls: ActivityControls;
	readonly #scope: DesktopMcpScope;
	readonly #redact: (text: string) => string;
	#disposed = false;

	constructor(result: FactoryResult, options: DesktopMcpOptions) {
		if (
			!options ||
			typeof options.connectionGeneration !== "string" ||
			!options.connectionGeneration ||
			options.connectionGeneration.length > 128 ||
			typeof options.redact !== "function"
		)
			throw new DesktopMcpError("invalid_input");
		try {
			this.#controls = createActivityControls(result);
		} catch (error) {
			throw failure(error);
		}
		this.#scope = {
			connectionGeneration: options.connectionGeneration,
			sessionGeneration: result.session.sessionLifecycle.generation,
		};
		this.#redact = options.redact;
	}

	#assertAttached(): void {
		if (this.#disposed) throw new DesktopMcpError("disposed");
	}

	#text(text: string): string {
		try {
			const redacted: unknown = this.#redact(text);
			if (typeof redacted !== "string") throw new DesktopMcpError("redaction_failed");
			// The host masks known secrets; also mask credential-shaped text and entire
			// URLs, since endpoints are private even without embedded credentials.
			const safe = redactCrashSecrets(redacted.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, "[redacted URL]"));
			const display = safe
				.toWellFormed()
				.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ");
			let result = "";
			let length = 0;
			for (const character of display) {
				if (length++ === DESKTOP_MCP_LIMITS.fieldChars) break;
				result += character;
			}
			return result;
		} catch {
			throw new DesktopMcpError("redaction_failed");
		}
	}

	getSnapshot(): DesktopMcpSnapshot {
		const base: DesktopMcpSnapshot = {
			...this.#scope,
			scope: "factory_manager_may_be_shared",
			available: false,
			servers: [],
			truncated: false,
		};
		try {
			this.#assertAttached();
			const snapshot = this.#controls.getMcpSnapshot();
			const servers: DesktopMcpServer[] = snapshot.servers.slice(0, DESKTOP_MCP_LIMITS.servers).map(server => ({
				ref: { ...this.#scope, key: server.ref },
				// Public SDK labels are display-only; opaque refs retain control authority.
				label: this.#text(server.label),
				state: server.state,
				transport: server.transport,
				sharing: server.sharing,
				toolCount: Math.max(0, Math.min(1_000_000, server.toolCount)),
				controls: [...server.controls],
			}));
			this.#assertAttached();
			// Redaction is caller code: repeat the SDK read to fence reentrant lifecycle changes.
			const current = this.#controls.getMcpSnapshot();
			for (const server of servers) {
				const live = current.servers.find(row => row.ref === server.ref.key);
				if (!live) throw new DesktopMcpError("stale_target");
				server.controls = [...live.controls];
			}
			return {
				...base,
				available: true,
				servers,
				truncated: snapshot.truncated || snapshot.servers.length > servers.length,
			};
		} catch (error) {
			const sanitized = failure(error);
			return { ...base, error: { code: sanitized.code, message: sanitized.message } };
		}
	}

	async operate(value: unknown, requestedAction: unknown): Promise<DesktopMcpOperationResult> {
		try {
			const ref = reference(value);
			const operation = action(requestedAction);
			this.#assertAttached();
			if (ref.connectionGeneration !== this.#scope.connectionGeneration)
				throw new DesktopMcpError("stale_connection");
			if (ref.sessionGeneration !== this.#scope.sessionGeneration) throw new DesktopMcpError("stale_session");
			const result = await this.#controls.operateMcp({ ref: ref.key }, operation);
			this.#assertAttached();
			return { status: result.status, cleanup: result.cleanup, snapshot: this.getSnapshot() };
		} catch (error) {
			throw failure(error);
		}
	}

	onChange(listener: () => void): () => void {
		try {
			this.#assertAttached();
			return this.#controls.onChange(listener);
		} catch (error) {
			throw failure(error);
		}
	}

	/** SDK disposal aborts pending operations without disposing the shared factory manager. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#controls.dispose();
	}
}

export function createDesktopMcpController(result: FactoryResult, options: DesktopMcpOptions): DesktopMcpController {
	return new DesktopMcpController(result, options);
}
