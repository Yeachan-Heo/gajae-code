import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../extensibility/extensions/types";

export type ExtensionInteractionKind = "select" | "confirm" | "input" | "editor";
export type ExtensionInteractionPurpose = "interaction" | "workflow-approval";
export type ExtensionInteractionPayload =
	| { kind: "select"; title: string; options: readonly string[]; initialIndex?: number; helpText?: string }
	| { kind: "confirm"; title: string; message: string }
	| { kind: "input"; title: string; placeholder?: string }
	| { kind: "editor"; title: string; prefill?: string; promptStyle?: boolean };

export interface ExtensionInteractionRequest {
	readonly sessionId: string;
	readonly requestId: string;
	readonly purpose: ExtensionInteractionPurpose;
	readonly payload: ExtensionInteractionPayload;
}

export type ExtensionInteractionResult =
	| { status: "answered"; value: string | boolean }
	| { status: "cancelled"; reason: "user" | "aborted" | "timeout" | "disposed" };

export interface ExtensionInteractionNotification {
	readonly sequence: number;
	readonly message: string;
	readonly type: "info" | "warning" | "error";
}

export interface ExtensionInteractionState {
	readonly sessionId: string;
	readonly connected: boolean;
	readonly disposed: boolean;
	readonly revision: number;
	readonly pending: readonly ExtensionInteractionRequest[];
	/** Notifications are transient. Reconnect restores only the most recent notification. */
	readonly lastNotification?: ExtensionInteractionNotification;
}

export interface ExtensionInteractionAddress {
	sessionId: string;
	connectionId: string;
	requestId: string;
}

export type ExtensionInteractionErrorCode =
	| "unavailable"
	| "disposed"
	| "wrong-session"
	| "stale-connection"
	| "stale-request"
	| "invalid-result"
	| "invalid-request"
	| "terminal-only"
	| "capacity-exceeded";

export class ExtensionInteractionError extends Error {
	constructor(
		readonly code: ExtensionInteractionErrorCode,
		message: string,
		readonly alternative?: string,
	) {
		super(message);
		this.name = "ExtensionInteractionError";
	}
}

/** Admission limits reject work explicitly; pending interactions are never evicted. */
export const EXTENSION_INTERACTION_LIMITS = Object.freeze({
	pending: 64,
	listeners: 256,
	payloadBytes: 64 * 1024,
	textBytes: 64 * 1024,
	selectOptions: 1024,
});

const terminalMethods = [
	"onTerminalInput",
	"setStatus",
	"setWorkingMessage",
	"setWidget",
	"setFooter",
	"setHeader",
	"setTitle",
	"custom",
	"setEditorText",
	"pasteToEditor",
	"getEditorText",
	"setEditorComponent",
	"theme",
	"getAllThemes",
	"getTheme",
	"setTheme",
	"getToolsExpanded",
	"setToolsExpanded",
] as const;

interface PendingInteraction {
	request: ExtensionInteractionRequest;
	resolve: (result: ExtensionInteractionResult) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
}

/**
 * A host-owned bridge, not an execution authorization provider. Keep connection IDs private
 * to the admitted renderer. Hosts must dispose before awaiting session.dispose(), so shutdown
 * handlers cannot wait for a departed renderer. Registered session cleanup is only an idempotent
 * safety net. Dispose on session switch; never rebind an instance to a session.
 * Hosts install `ui` using the existing extension/hook/tool UI initialization hooks.
 */
export class ExtensionInteractionService {
	readonly #sessionId: string;
	#connectionId: string | undefined;
	#disposed = false;
	#revision = 0;
	#notificationSequence = 0;
	#lastNotification: ExtensionInteractionNotification | undefined;
	readonly #pending = new Map<string, PendingInteraction>();
	readonly #listeners = new Set<(state: ExtensionInteractionState) => void>();
	readonly ui: ExtensionUIContext;

	constructor(sessionId: string) {
		if (typeof sessionId !== "string" || !sessionId.trim() || Buffer.byteLength(sessionId) > 1024)
			throw new ExtensionInteractionError("invalid-request", "A session ID of at most 1024 bytes is required");
		this.#sessionId = sessionId;
		const terminal = (method: string): never => {
			throw new ExtensionInteractionError(
				"terminal-only",
				`${method} requires a terminal renderer`,
				"Use select, confirm, input, editor or notify, or provide a terminal-owned UI context",
			);
		};
		this.ui = {
			select: async (title, options, dialogOptions) => {
				this.#validateDialogOptions(dialogOptions);
				const result = await this.request(
					{
						kind: "select",
						title,
						options,
						initialIndex: dialogOptions?.initialIndex,
						helpText: dialogOptions?.helpText,
					},
					dialogOptions,
				);
				return result.status === "answered" ? (result.value as string) : undefined;
			},
			confirm: async (title, message, dialogOptions) => {
				this.#validateDialogOptions(dialogOptions);
				const result = await this.request({ kind: "confirm", title, message }, dialogOptions);
				return result.status === "answered" ? (result.value as boolean) : false;
			},
			input: async (title, placeholder, dialogOptions) => {
				this.#validateDialogOptions(dialogOptions);
				const result = await this.request({ kind: "input", title, placeholder }, dialogOptions);
				return result.status === "answered" ? (result.value as string) : undefined;
			},
			editor: async (title, prefill, dialogOptions, editorOptions) => {
				this.#validateDialogOptions(dialogOptions);
				const result = await this.request(
					{ kind: "editor", title, prefill, promptStyle: editorOptions?.promptStyle },
					dialogOptions,
				);
				return result.status === "answered" ? (result.value as string) : undefined;
			},
			notify: (message, type = "info") => this.notify(message, type),
			onTerminalInput: () => terminal("onTerminalInput"),
			setStatus: () => terminal("setStatus"),
			setWorkingMessage: () => terminal("setWorkingMessage"),
			setWidget: () => terminal("setWidget"),
			setFooter: () => terminal("setFooter"),
			setHeader: () => terminal("setHeader"),
			setTitle: () => terminal("setTitle"),
			custom: async () => terminal("custom"),
			setEditorText: () => terminal("setEditorText"),
			pasteToEditor: () => terminal("pasteToEditor"),
			getEditorText: () => terminal("getEditorText"),
			setEditorComponent: () => terminal("setEditorComponent"),
			get theme() {
				return terminal("theme");
			},
			getAllThemes: async () => terminal("getAllThemes"),
			getTheme: async () => terminal("getTheme"),
			setTheme: async () => terminal("setTheme"),
			getToolsExpanded: () => terminal("getToolsExpanded"),
			setToolsExpanded: () => terminal("setToolsExpanded"),
		};
	}

	capabilities() {
		return {
			portable: ["select", "confirm", "input", "editor", "notify"] as const,
			available: !this.#disposed && this.#connectionId !== undefined,
			unavailableReason: this.#disposed ? "disposed" : this.#connectionId ? undefined : "renderer-disconnected",
			terminalOnly: terminalMethods.map(method => ({
				method,
				reason: "terminal-only" as const,
				alternative: "Use portable interactions or a terminal-owned UI context",
			})),
			grantsExecutionPermission: false as const,
		};
	}

	/** Rotates responder authority; pending requests survive transport reconnection. */
	connect(): { connectionId: string; state: ExtensionInteractionState } {
		this.#assertAlive();
		const connectionId = crypto.randomUUID();
		this.#connectionId = connectionId;
		this.#changed();
		return { connectionId, state: this.snapshot() };
	}

	disconnect(connectionId: string): void {
		this.#assertConnection(connectionId);
		this.#connectionId = undefined;
		this.#changed();
	}

	snapshot(): ExtensionInteractionState {
		return structuredClone({
			sessionId: this.#sessionId,
			connected: this.#connectionId !== undefined,
			disposed: this.#disposed,
			revision: this.#revision,
			pending: [...this.#pending.values()].map(item => item.request),
			lastNotification: this.#lastNotification,
		});
	}

	/** Listeners observe state only, never responder credentials. Throwing listeners are removed. */
	subscribe(listener: (state: ExtensionInteractionState) => void): () => void {
		this.#assertAlive();
		if (!this.#listeners.has(listener) && this.#listeners.size >= EXTENSION_INTERACTION_LIMITS.listeners)
			throw new ExtensionInteractionError("capacity-exceeded", "Too many interaction listeners");
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	request(
		payload: ExtensionInteractionPayload,
		options: Pick<ExtensionUIDialogOptions, "signal" | "timeout" | "onTimeout"> = {},
		purpose: ExtensionInteractionPurpose = "interaction",
	): Promise<ExtensionInteractionResult> {
		this.#assertAvailable();
		const detachedPayload = this.#detachPayload(payload);
		// Cloning can invoke caller getters, which may reenter and disconnect or dispose the service.
		this.#assertAvailable();
		if (!["interaction", "workflow-approval"].includes(purpose)) {
			throw new ExtensionInteractionError("invalid-request", "Interactions cannot grant execution permission");
		}
		let timeout: number | undefined;
		let signal: AbortSignal | undefined;
		let onTimeout: (() => void) | undefined;
		let aborted = false;
		const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
		try {
			// Each caller-controlled option is read exactly once, before the final admission check.
			timeout = options.timeout;
			signal = options.signal;
			onTimeout = options.onTimeout;
			if (signal !== undefined) aborted = abortedGetter.call(signal);
		} catch {
			throw new ExtensionInteractionError("invalid-request", "Invalid interaction options");
		}
		if (
			timeout !== undefined &&
			(typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647)
		) {
			throw new ExtensionInteractionError("invalid-request", "Timeout must be a finite nonnegative timer duration");
		}
		if (onTimeout !== undefined && typeof onTimeout !== "function")
			throw new ExtensionInteractionError("invalid-request", "Invalid interaction options");
		this.#assertAvailable();
		if (aborted) return Promise.resolve({ status: "cancelled", reason: "aborted" });
		if (this.#pending.size >= EXTENSION_INTERACTION_LIMITS.pending)
			throw new ExtensionInteractionError("capacity-exceeded", "Too many pending interactions");
		const requestId = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<ExtensionInteractionResult>();
		const abort = () => this.#finish(requestId, { status: "cancelled", reason: "aborted" });
		let timer: Timer | undefined;
		const item: PendingInteraction = {
			request: { sessionId: this.#sessionId, requestId, purpose, payload: detachedPayload },
			resolve,
			reject,
			cleanup: () => {
				if (timer !== undefined) clearTimeout(timer);
				if (signal) EventTarget.prototype.removeEventListener.call(signal, "abort", abort);
			},
		};
		this.#pending.set(requestId, item);
		if (signal) {
			// Use native EventTarget methods rather than caller-overridden signal methods.
			try {
				EventTarget.prototype.addEventListener.call(signal, "abort", abort, { once: true });
			} catch {
				const removed = this.#pending.delete(requestId);
				EventTarget.prototype.removeEventListener.call(signal, "abort", abort);
				if (removed) this.#changed();
				throw new ExtensionInteractionError("invalid-request", "Invalid interaction signal");
			}
			if (!this.#pending.has(requestId)) {
				// Settlement can reenter while a host wraps registration, before it actually attaches.
				EventTarget.prototype.removeEventListener.call(signal, "abort", abort);
				return promise;
			}
			if (abortedGetter.call(signal)) {
				abort();
				return promise;
			}
			try {
				this.#assertAvailable();
			} catch (error) {
				this.#pending.delete(requestId);
				item.cleanup();
				this.#changed();
				throw error;
			}
		}
		if (timeout !== undefined) {
			timer = setTimeout(() => {
				this.#finish(requestId, { status: "cancelled", reason: "timeout" }, onTimeout);
			}, timeout);
		}
		this.#changed();
		return promise;
	}

	respond(address: ExtensionInteractionAddress, value: string | boolean): { grantsExecutionPermission: false } {
		const item = this.#lookup(address);
		const payload = item.request.payload;
		if (
			payload.kind === "confirm"
				? typeof value !== "boolean"
				: typeof value !== "string" ||
					Buffer.byteLength(value) > EXTENSION_INTERACTION_LIMITS.textBytes ||
					(payload.kind === "select" && !payload.options.includes(value))
		) {
			throw new ExtensionInteractionError("invalid-result", "Response does not match the pending interaction");
		}
		this.#finish(item.request.requestId, { status: "answered", value });
		return { grantsExecutionPermission: false };
	}

	cancel(address: ExtensionInteractionAddress): void {
		const item = this.#lookup(address);
		this.#finish(item.request.requestId, { status: "cancelled", reason: "user" });
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		this.#assertAvailable();
		if (
			typeof message !== "string" ||
			Buffer.byteLength(message) > EXTENSION_INTERACTION_LIMITS.textBytes ||
			!["info", "warning", "error"].includes(type)
		) {
			throw new ExtensionInteractionError("invalid-request", "Notification requires text and a supported severity");
		}
		this.#lastNotification = { sequence: ++this.#notificationSequence, message, type };
		this.#changed();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#connectionId = undefined;
		for (const [id, item] of this.#pending) {
			this.#pending.delete(id);
			item.cleanup();
			item.resolve({ status: "cancelled", reason: "disposed" });
		}
		this.#lastNotification = undefined;
		this.#changed();
		this.#listeners.clear();
	}

	#detachPayload(input: ExtensionInteractionPayload): ExtensionInteractionPayload {
		const invalid = (): never => {
			throw new ExtensionInteractionError("invalid-request", "Invalid portable interaction payload");
		};
		let payload: ExtensionInteractionPayload;
		try {
			payload = structuredClone(input);
		} catch {
			return invalid();
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid();
		const own = (key: string) => Object.hasOwn(payload, key);
		if (!own("title") || typeof payload.title !== "string" || !own("kind")) return invalid();
		let allowed: readonly string[] = [];
		switch (payload.kind) {
			case "select":
				allowed = ["kind", "title", "options", "initialIndex", "helpText"];
				if (
					!own("options") ||
					!Array.isArray(payload.options) ||
					payload.options.length === 0 ||
					payload.options.length > EXTENSION_INTERACTION_LIMITS.selectOptions ||
					Object.keys(payload.options).length !== payload.options.length
				)
					return invalid();
				for (let i = 0; i < payload.options.length; i++) {
					if (!Object.hasOwn(payload.options, i) || typeof payload.options[i] !== "string") return invalid();
				}
				if (
					own("initialIndex") &&
					payload.initialIndex !== undefined &&
					(!Number.isInteger(payload.initialIndex) ||
						payload.initialIndex < 0 ||
						payload.initialIndex >= payload.options.length)
				)
					invalid();
				if (own("helpText") && payload.helpText !== undefined && typeof payload.helpText !== "string") invalid();
				break;
			case "confirm":
				allowed = ["kind", "title", "message"];
				if (!own("message") || typeof payload.message !== "string") invalid();
				break;
			case "input":
				allowed = ["kind", "title", "placeholder"];
				if (own("placeholder") && payload.placeholder !== undefined && typeof payload.placeholder !== "string")
					invalid();
				break;
			case "editor":
				allowed = ["kind", "title", "prefill", "promptStyle"];
				if (own("prefill") && payload.prefill !== undefined && typeof payload.prefill !== "string") invalid();
				if (own("promptStyle") && payload.promptStyle !== undefined && typeof payload.promptStyle !== "boolean")
					invalid();
				break;
			default:
				invalid();
		}
		// Serialize only validated own data, without invoking inherited toJSON or array iterators.
		const fields: string[] = [];
		for (const key of Object.keys(payload)) {
			if (!allowed.includes(key)) return invalid();
			const value = (payload as unknown as Record<string, unknown>)[key];
			if (value === undefined) continue;
			let encoded: string;
			if (key === "options" && Array.isArray(value)) {
				const entries: string[] = [];
				for (let i = 0; i < value.length; i++) entries.push(JSON.stringify(value[i]));
				encoded = `[${entries.join(",")}]`;
			} else {
				encoded = JSON.stringify(value)!;
			}
			fields.push(`${JSON.stringify(key)}:${encoded}`);
		}
		if (Buffer.byteLength(`{${fields.join(",")}}`) > EXTENSION_INTERACTION_LIMITS.payloadBytes) return invalid();
		return payload;
	}

	#validateDialogOptions(options?: ExtensionUIDialogOptions): void {
		if (
			options?.onLeft ||
			options?.onRight ||
			options?.onExternalEditor ||
			options?.customInput ||
			options?.clarificationInput
		) {
			throw new ExtensionInteractionError(
				"terminal-only",
				"Dialog callbacks require a terminal renderer",
				"Use a follow-up portable input or select request",
			);
		}
	}

	#assertAlive(): void {
		if (this.#disposed) throw new ExtensionInteractionError("disposed", "Interaction session is disposed");
	}

	#assertAvailable(): void {
		this.#assertAlive();
		if (!this.#connectionId) throw new ExtensionInteractionError("unavailable", "No admitted renderer is connected");
	}

	#assertConnection(connectionId: string): void {
		this.#assertAlive();
		if (!this.#connectionId || connectionId !== this.#connectionId)
			throw new ExtensionInteractionError("stale-connection", "Renderer connection is stale");
	}

	#lookup(address: ExtensionInteractionAddress): PendingInteraction {
		this.#assertAlive();
		if (address.sessionId !== this.#sessionId)
			throw new ExtensionInteractionError("wrong-session", "Interaction belongs to another session");
		this.#assertConnection(address.connectionId);
		const item = this.#pending.get(address.requestId);
		if (!item) throw new ExtensionInteractionError("stale-request", "Interaction is no longer pending");
		return item;
	}

	#finish(requestId: string, result: ExtensionInteractionResult, onTimeout?: () => void): void {
		const item = this.#pending.get(requestId);
		if (!item) return;
		this.#pending.delete(requestId);
		item.cleanup();
		try {
			onTimeout?.();
			item.resolve(result);
		} catch (error) {
			item.reject(error);
		}
		this.#changed();
	}

	#changed(): void {
		const revision = ++this.#revision;
		for (const listener of [...this.#listeners]) {
			// A reentrant mutation already delivered a newer state. Never replay that state
			// as the old event, or invoke a listener removed during another callback.
			if (this.#revision !== revision) break;
			if (!this.#listeners.has(listener)) continue;
			try {
				listener(this.snapshot());
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}
}
