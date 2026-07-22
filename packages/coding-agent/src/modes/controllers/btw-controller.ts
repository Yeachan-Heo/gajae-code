import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import type { BtwConversationScope, BtwTurnCapture } from "../../session/agent-session";
import {
	BTW_MAX_QUESTION_UTF8_BYTES,
	type BtwTextExchange,
	boundBtwExchanges,
	sanitizeBtwError,
	utf8ByteLength,
} from "../../session/btw-contract";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

type BtwFollowUpResult = "accepted" | "busy" | "closed" | "rejected";

interface ActiveBtwTurn extends BtwTurnCapture {
	abortController: AbortController | undefined;
	active: boolean;
}

interface BtwRequest {
	component: BtwPanelComponent;
	conversationScope: BtwConversationScope | undefined;
	activeTurn: ActiveBtwTurn | undefined;
	inFlight: boolean;
	contextExchanges: BtwTextExchange[];
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	hasOpenPanel(): boolean {
		return this.hasActiveRequest();
	}

	isTurnInFlight(): boolean {
		return this.#activeRequest?.inFlight ?? false;
	}

	handleEscape(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest();
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest();
	}

	async start(question: string): Promise<void> {
		if (this.hasOpenPanel()) {
			this.ctx.showStatus("A /btw chat is already open. Type a follow-up or press Esc to return to the main chat.");
			return;
		}
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw <question>");
			return;
		}
		if (!this.#acceptQuestion(trimmedQuestion) || !this.#hasModel()) return;
		const scope = this.ctx.session.createBtwConversationScope(btwUserPrompt);
		const request = this.#openRequest(trimmedQuestion, scope);
		void this.#runRequest(request);
	}

	async submitFollowUp(question: string): Promise<BtwFollowUpResult> {
		const request = this.#activeRequest;
		if (!request) return "closed";
		if (request.inFlight) {
			this.ctx.showStatus("The /btw chat is still answering. Wait for it to finish.");
			return "busy";
		}
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) return "closed";
		if (!this.#acceptQuestion(trimmedQuestion)) return "rejected";
		if (!request.conversationScope) return "closed";
		request.activeTurn = this.#createTurn(trimmedQuestion, request.conversationScope);
		request.inFlight = true;
		request.component.beginTurn(trimmedQuestion);
		void this.#runRequest(request);
		return "accepted";
	}

	#acceptQuestion(question: string): boolean {
		if (utf8ByteLength(question) <= BTW_MAX_QUESTION_UTF8_BYTES) return true;
		this.ctx.showError(`/btw questions are limited to ${BTW_MAX_QUESTION_UTF8_BYTES} UTF-8 bytes.`);
		return false;
	}

	#hasModel(): boolean {
		if (this.ctx.session.model) return true;
		this.ctx.showError("No active model available for /btw.");
		return false;
	}

	#createTurn(question: string, scope: BtwConversationScope): ActiveBtwTurn {
		return { question, scope, abortController: new AbortController(), active: true };
	}

	#openRequest(question: string, scope: BtwConversationScope): BtwRequest {
		const request: BtwRequest = {
			component: new BtwPanelComponent({ question, tui: this.ctx.ui }),
			conversationScope: scope,
			activeTurn: this.#createTurn(question, scope),
			inFlight: true,
			contextExchanges: [],
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		return request;
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		const turn = request.activeTurn;
		const abortController = turn?.abortController;
		if (!turn?.scope || !abortController) return;
		try {
			const { replyText } = await this.ctx.session.runEphemeralTurn({
				purpose: "btw",
				turn,
				contextExchanges: request.contextExchanges.map(exchange => ({ ...exchange })),
				onTextDelta: delta => {
					if (turn.active && this.#isActiveRequest(request)) request.component.appendText(delta);
				},
				signal: abortController.signal,
			});
			if (!turn.active || !this.#isActiveRequest(request)) return;
			request.inFlight = false;
			request.contextExchanges = boundBtwExchanges([
				...request.contextExchanges,
				{ question: turn.question, answer: replyText },
			]);
			if (replyText) request.component.setAnswer(replyText);
			request.component.markComplete();
		} catch {
			if (!turn.active || !this.#isActiveRequest(request)) return;
			request.inFlight = false;
			if (abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(sanitizeBtwError("Side-chat request failed."));
		} finally {
			if (request.activeTurn === turn) request.activeTurn = undefined;
			this.#scrubTurn(turn);
		}
	}

	#scrubTurn(turn: ActiveBtwTurn): void {
		turn.active = false;
		turn.question = "";
		turn.abortController = undefined;
		turn.scope = undefined;
	}

	#closeActiveRequest(): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		const turn = request.activeTurn;
		const abortController = turn?.abortController;
		if (turn) this.#scrubTurn(turn);
		request.activeTurn = undefined;
		request.contextExchanges.splice(0);
		request.inFlight = false;
		if (request.conversationScope) {
			request.conversationScope.messages.splice(0);
			request.conversationScope.systemPrompt.splice(0);
			request.conversationScope = undefined;
		}
		abortController?.abort();
		request.component.close();
		this.ctx.editor?.setText("");
		this.ctx.pendingImages = [];
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
