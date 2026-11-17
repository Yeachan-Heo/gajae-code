import type {
	ExtensionInteractionRequest,
	ExtensionInteractionState,
} from "@gajae-code/coding-agent/sdk";

/** A host-side question raised for one pending extension interaction. */
export interface NativeInteractionQuestion {
	readonly kind: "confirm" | "select" | "input" | "editor";
	readonly title: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly initialValue?: string;
	readonly signal: AbortSignal;
}

export type NativeInteractionAnswer = string | boolean | null;

/**
 * A native runtime answers only its registered interaction service, so the host
 * renders questions by reading the service's pending list instead of owning the UI.
 */
export function nativeInteractionQuestion(
	request: ExtensionInteractionRequest,
	signal: AbortSignal,
): NativeInteractionQuestion {
	const payload = request.payload;
	switch (payload.kind) {
		case "confirm":
			return { kind: "confirm", title: payload.title, message: payload.message, signal };
		case "select":
			return { kind: "select", title: payload.title, options: payload.options, signal };
		case "input":
			return {
				kind: "input",
				title: payload.title,
				...(payload.placeholder === undefined ? {} : { initialValue: payload.placeholder }),
				signal,
			};
		case "editor":
			return {
				kind: "editor",
				title: payload.title,
				...(payload.prefill === undefined ? {} : { initialValue: payload.prefill }),
				signal,
			};
	}
}

/** The registered service plus the connection the runtime publishes its requests on. */
export interface NativeInteractionEndpoint {
	readonly service: {
		readonly snapshot: () => ExtensionInteractionState;
		readonly subscribe: (listener: (state: ExtensionInteractionState) => void) => () => void;
		readonly respond: (address: { sessionId: string; connectionId: string; requestId: string }, value: string | boolean) => unknown;
		readonly cancel: (address: { sessionId: string; connectionId: string; requestId: string }) => void;
	};
	readonly connectionId: string;
}

export interface BridgeNativeInteractionInput {
	readonly interaction: NativeInteractionEndpoint;
	readonly ask: (question: NativeInteractionQuestion) => Promise<NativeInteractionAnswer>;
	readonly notify?: (message: string, type: "info" | "warning" | "error") => void;
}

/**
 * Render pending interactions one at a time. A question is asked only after the
 * service reports it, so a stale snapshot can never answer a newer request.
 */
export function bridgeNativeInteraction(input: BridgeNativeInteractionInput): { dispose(): void } {
	const { interaction } = input;
	let disposed = false;
	let queue: Promise<void> = Promise.resolve();
	const answered = new Set<string>();
	const askOne = async (request: ExtensionInteractionRequest): Promise<void> => {
		if (disposed || answered.has(request.requestId)) return;
		answered.add(request.requestId);
		const controller = new AbortController();
		const address = {
			sessionId: request.sessionId,
			connectionId: interaction.connectionId,
			requestId: request.requestId,
		};
		try {
			const answer = await input.ask(nativeInteractionQuestion(request, controller.signal));
			if (disposed) return;
			if (answer === null) interaction.service.cancel(address);
			else interaction.service.respond(address, answer);
		} catch {
			if (!disposed) interaction.service.cancel(address);
		}
	};
	const pump = (state: ExtensionInteractionState): void => {
		if (disposed) return;
		for (const request of state.pending) {
			if (answered.has(request.requestId)) continue;
			queue = queue.then(() => askOne(request));
		}
		if (state.lastNotification && state.lastNotification.sequence !== lastNotification) {
			lastNotification = state.lastNotification.sequence;
			input.notify?.(state.lastNotification.message, state.lastNotification.type);
		}
	};
	let lastNotification = 0;
	const unsubscribe = interaction.service.subscribe(pump);
	pump(interaction.service.snapshot());
	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribe();
		},
	};
}
