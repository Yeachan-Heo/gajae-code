import { prompt } from "@gajae-code/utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import type { EphemeralTextExchange } from "../../session/agent-session";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

type BtwFollowUpResult = "accepted" | "busy" | "closed";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController | undefined;
	question: string;
	inFlight: boolean;
	contextExchanges: EphemeralTextExchange[];
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
		if (!this.#hasModel()) return;

		const request = this.#openRequest(trimmedQuestion);
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
		if (!this.#hasModel()) return "closed";

		request.question = trimmedQuestion;
		request.abortController = new AbortController();
		request.inFlight = true;
		request.component.beginTurn(trimmedQuestion);
		void this.#runRequest(request);
		return "accepted";
	}

	#hasModel(): boolean {
		if (this.ctx.session.model) return true;
		this.ctx.showError("No active model available for /btw.");
		return false;
	}

	#openRequest(question: string): BtwRequest {
		const request: BtwRequest = {
			component: new BtwPanelComponent({ question, tui: this.ctx.ui }),
			abortController: new AbortController(),
			question,
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
		const abortController = request.abortController;
		if (!abortController) return;
		const question = request.question;
		try {
			const promptText = prompt.render(btwUserPrompt, { question });
			const { replyText } = await this.ctx.session.runEphemeralTurn({
				purpose: "btw",
				promptText,
				contextExchanges: request.contextExchanges.map(exchange => ({ ...exchange })),
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) request.component.appendText(delta);
				},
				signal: abortController.signal,
			});
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			request.contextExchanges.push({ question, answer: replyText });
			if (replyText) request.component.setAnswer(replyText);
			request.component.markComplete();
		} catch (error) {
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			if (abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			request.contextExchanges.push({ question, answer: `Error: ${message}` });
			request.component.markError(message);
		}
	}

	#closeActiveRequest(): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		const abortController = request.abortController;
		request.abortController = undefined;
		request.question = "";
		request.contextExchanges.splice(0);
		request.inFlight = false;
		abortController?.abort();
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
