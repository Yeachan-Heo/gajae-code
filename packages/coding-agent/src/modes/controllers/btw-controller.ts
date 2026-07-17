import type { AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { prompt } from "@gajae-code/utils";
import btwRUserPrompt from "../../prompts/system/btw-r-user.md" with { type: "text" };
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

type RetainedFollowUpResult = "accepted" | "busy" | "closed";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	mode: "one-shot" | "retained";
	inFlight: boolean;
	contextMessages: AgentMessage[];
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
		this.#closeActiveRequest({ abort: this.#activeRequest.inFlight });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
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

		this.#closeActiveRequest({ abort: true });
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

		this.#closeActiveRequest({ abort: true });
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
			contextMessages: [],
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		return request;
	}

	async #runOneShotRequest(request: BtwRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const { replyText } = await this.ctx.session.runEphemeralTurn({
				purpose: "btw",
				promptText,
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) request.component.appendText(delta);
				},
				signal: request.abortController.signal,
			});
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			if (replyText) request.component.setAnswer(replyText);
			request.component.markComplete();
		} catch (error) {
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(error instanceof Error ? error.message : String(error));
		}
	}

	async #runRetainedRequest(request: BtwRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwRUserPrompt, { question: request.question });
			const { replyText, assistantMessage } = await this.ctx.session.runEphemeralTurn({
				promptText,
				contextMessages: [...request.contextMessages],
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) request.component.appendText(delta);
				},
				signal: request.abortController.signal,
			});
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			this.#appendRetainedExchange(request, assistantMessage);
			if (replyText) request.component.setAnswer(replyText);
			request.component.markComplete();
		} catch (error) {
			if (!this.#isActiveRequest(request)) return;
			request.inFlight = false;
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			// Keep the failed user turn visible to later follow-ups so "try again"
			// still sees the question that remains on the retained panel.
			this.#appendRetainedExchange(request, this.#errorAssistantMessage(message));
			request.component.markError(message);
		}
	}

	#appendRetainedExchange(request: BtwRequest, assistantMessage: AgentMessage): void {
		request.contextMessages.push(
			{
				role: "user",
				content: [{ type: "text", text: request.question }],
				attribution: "user",
				timestamp: Date.now(),
			},
			assistantMessage,
		);
	}

	#errorAssistantMessage(message: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: `Error: ${message}` }],
			api: "btw-r",
			provider: "btw-r",
			model: "btw-r",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
			errorMessage: message,
		};
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		if (options.abort) request.abortController.abort();
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
