import { prompt } from "@gajae-code/utils";
import btwRUserPrompt from "../../prompts/system/btw-r-user.md" with { type: "text" };
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import type { EphemeralTextExchange } from "../../session/agent-session";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

type RetainedFollowUpResult = "accepted" | "busy" | "closed";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController | undefined;
	question: string;
	mode: "one-shot" | "retained";
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

	hasOpenRetainedThread(): boolean {
		return this.#activeRequest?.mode === "retained";
	}

	isRetainedTurnInFlight(): boolean {
		return this.#activeRequest?.mode === "retained" && this.#activeRequest.inFlight;
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
		if (this.hasOpenRetainedThread()) {
			this.ctx.showStatus("A /btw-r thread is open. Type a follow-up or press Esc to dismiss it.");
			return;
		}

		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw <question>");
			return;
		}
		if (!this.#hasModel("/btw")) return;

		this.#closeActiveRequest();
		const request = this.#openRequest(trimmedQuestion, "one-shot");
		void this.#runOneShotRequest(request);
	}

	async startRetained(question: string): Promise<void> {
		if (this.hasOpenRetainedThread()) {
			this.ctx.showStatus("A /btw-r thread is already open. Type a follow-up or press Esc to dismiss it.");
			return;
		}

		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw-r <question>");
			return;
		}
		if (!this.#hasModel("/btw-r")) return;

		this.#closeActiveRequest();
		const request = this.#openRequest(trimmedQuestion, "retained");
		void this.#runRetainedRequest(request);
	}

	async submitRetainedFollowUp(question: string): Promise<RetainedFollowUpResult> {
		const request = this.#activeRequest;
		if (request?.mode !== "retained") {
			return "closed";
		}
		if (request.inFlight) {
			this.ctx.showStatus("The /btw-r thread is still answering. Wait for it to finish.");
			return "busy";
		}

		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) return "closed";
		if (!this.#hasModel("/btw-r")) return "closed";

		request.question = trimmedQuestion;
		request.abortController = new AbortController();
		request.inFlight = true;
		request.component.beginRetainedTurn(trimmedQuestion);
		void this.#runRetainedRequest(request);
		return "accepted";
	}

	#hasModel(command: "/btw" | "/btw-r"): boolean {
		if (this.ctx.session.model) return true;
		this.ctx.showError(`No active model available for ${command}.`);
		return false;
	}

	#openRequest(question: string, mode: BtwRequest["mode"]): BtwRequest {
		const request: BtwRequest = {
			component: new BtwPanelComponent({ question, retained: mode === "retained", tui: this.ctx.ui }),
			abortController: new AbortController(),
			question,
			mode,
			inFlight: true,
			contextExchanges: [],
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		return request;
	}

	async #runOneShotRequest(request: BtwRequest): Promise<void> {
		const abortController = request.abortController;
		if (!abortController) return;
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const { replyText } = await this.ctx.session.runEphemeralTurn({
				purpose: "btw",
				promptText,
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) request.component.appendText(delta);
				},
				signal: abortController.signal,
			});
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			if (replyText) request.component.setAnswer(replyText);
			request.component.markComplete();
		} catch (error) {
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			if (abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(error instanceof Error ? error.message : String(error));
		}
	}

	async #runRetainedRequest(request: BtwRequest): Promise<void> {
		const abortController = request.abortController;
		if (!abortController) return;
		const question = request.question;
		try {
			const promptText = prompt.render(btwRUserPrompt, { question });
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
