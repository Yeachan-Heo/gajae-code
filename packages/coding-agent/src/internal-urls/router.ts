/**
 * Internal URL router for internal protocols (agent://, artifact://, memory://, rule://, gjc://, local://).
 *
 * One process-global router with one handler per scheme. Access via
 * `InternalUrlRouter.instance()`. Handlers are stateless; per-session and
 * shared state lives in `./state.ts`.
 */
import { AgentProtocolHandler } from "./agent-protocol";
import { ArtifactProtocolHandler } from "./artifact-protocol";
import { EmbeddedProtocolHandler } from "./embedded-protocol";
import { GjcProtocolHandler } from "./gjc-protocol";
import { IssueProtocolHandler, PrProtocolHandler } from "./issue-pr-protocol";
import { LocalProtocolHandler } from "./local-protocol";
import { MemoryProtocolHandler } from "./memory-protocol";
import { normalizeInternalUrlInput, parseInternalUrl } from "./parse";
import { RuleProtocolHandler } from "./rule-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	#handlers = new Map<string, ProtocolHandler>();

	constructor() {
		this.register(new GjcProtocolHandler());
		this.register(new AgentProtocolHandler());
		this.register(new ArtifactProtocolHandler());
		this.register(new MemoryProtocolHandler());
		this.register(new LocalProtocolHandler());
		this.register(new RuleProtocolHandler());
		this.register(new IssueProtocolHandler());
		this.register(new PrProtocolHandler());
		this.register(new EmbeddedProtocolHandler());
	}

	/** Process-global router instance. */
	static instance(): InternalUrlRouter {
		InternalUrlRouter.#instance ??= new InternalUrlRouter();
		return InternalUrlRouter.#instance;
	}

	/** Reset the global instance in tests. */
	static resetForTests(): void {
		InternalUrlRouter.#instance = undefined;
	}

	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme.toLowerCase(), handler);
	}

	unregister(scheme: string): boolean {
		return this.#handlers.delete(scheme.toLowerCase());
	}

	getHandler(scheme: string): ProtocolHandler | undefined {
		return this.#handlers.get(scheme.toLowerCase());
	}

	canHandle(input: string): boolean {
		const match = normalizeInternalUrlInput(input).match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (!match) return false;
		return this.#handlers.has(match[1].toLowerCase());
	}

	async resolve(input: string, context?: ResolveContext): Promise<InternalResource> {
		const parsed = parseInternalUrl(input);
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler = this.#handlers.get(scheme);

		if (!handler) {
			const available = Array.from(this.#handlers.keys())
				.map(s => `${s}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}

		const resource = await handler.resolve(parsed as InternalUrl, context);
		return { ...resource, immutable: resource.immutable ?? handler.immutable };
	}
}
