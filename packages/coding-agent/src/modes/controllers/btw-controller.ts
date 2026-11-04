import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import type { BtwConversationScope, BtwTurnCapture } from "../../session/agent-session";
import {
	BTW_HANDOFF_MESSAGE_TYPE,
	BTW_MAX_QUESTION_UTF8_BYTES,
	type BtwHandoffDetails,
	type BtwTextExchange,
	boundBtwExchanges,
	renderBtwHandoffMessage,
	sanitizeBtwError,
	utf8ByteLength,
} from "../../session/btw-contract";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

type BtwFollowUpResult = "accepted" | "busy" | "closed" | "rejected";

const RETURNED_HANDOFF_HINT =
	"Use /btw to reopen that side chat (Esc there discards it), or /btw-handoff to send it again.";
const RETURNED_BESIDE_OPEN_CHAT_STEPS =
	"Esc closes this chat (it is discarded); then /btw reopens the earlier one and /btw-handoff sends it again.";
const RETURNED_BESIDE_OPEN_CHAT_HINT = `An earlier /btw handoff came back and is still waiting. ${RETURNED_BESIDE_OPEN_CHAT_STEPS}`;

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

/**
 * A side chat handed off to the main session but not yet taken by it. The full
 * panel state is kept so nothing is lost if the handoff never reaches the main
 * session. `pending` waits in the main queue or admission; `returned` left the
 * queue unconsumed (or was refused) and waits for the user to reopen it with
 * `/btw` or send it again with `/btw-handoff`. A returned chat is never
 * reopened automatically: the composer may belong to the main session then.
 * It is bound to the session it came from and dropped after a session switch.
 */
interface ParkedHandoff {
	request: BtwRequest;
	state: "pending" | "returned";
	sessionId: string;
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#parkedHandoff: ParkedHandoff | undefined;

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
		const parked = this.#parkedHandoff;
		this.#parkedHandoff = undefined;
		if (parked) this.#scrubRequest(parked.request);
		this.#closeActiveRequest();
	}

	async start(question: string): Promise<void> {
		if (this.hasOpenPanel()) {
			this.ctx.showStatus("A /btw chat is already open. Type a follow-up or press Esc to return to the main chat.");
			return;
		}
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			const parked = this.#currentParkedHandoff();
			if (parked?.state === "returned") {
				this.#parkedHandoff = undefined;
				this.#showRequest(parked.request);
			} else if (parked) {
				this.ctx.showStatus("A /btw handoff is waiting in the main queue.");
			} else {
				this.ctx.showStatus("Usage: /btw <question>");
			}
			return;
		}
		if (!this.#acceptQuestion(trimmedQuestion) || !this.#hasModel()) return;
		const scope = this.ctx.session.createBtwConversationScope(btwUserPrompt);
		const request = this.#openRequest(trimmedQuestion, scope);
		if (this.#currentParkedHandoff()?.state === "returned") {
			this.ctx.showStatus(
				`An earlier /btw handoff is still waiting, so this chat cannot be handed off. ${RETURNED_BESIDE_OPEN_CHAT_STEPS}`,
			);
		}
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

	/**
	 * Hand the open side chat to the main session as one `btw-handoff` message.
	 * Only completed exchanges are sent, verbatim. A busy main session receives
	 * the handoff as a sequential follow-up so the running turn and its tools are
	 * not interrupted. The panel is hidden but its state is kept until the main
	 * session takes the message. If the message is refused or leaves the queue
	 * unconsumed (Esc, dequeue, queue edit), the chat is kept as returned: `/btw`
	 * reopens it and `/btw-handoff` with no open panel sends it again.
	 */
	async handoff(): Promise<void> {
		const parkedBefore = this.#currentParkedHandoff();
		if (parkedBefore?.state === "pending") {
			this.ctx.showStatus("An earlier /btw handoff has not reached the main session yet. Try again after it does.");
			return;
		}
		if (parkedBefore && this.#activeRequest) {
			this.ctx.showStatus(RETURNED_BESIDE_OPEN_CHAT_HINT);
			return;
		}
		// With no panel open, /btw-handoff sends a returned chat again.
		const fromParked = parkedBefore?.request;
		const request = fromParked ?? this.#activeRequest;
		if (!request) {
			this.ctx.showStatus("No /btw chat is open.");
			return;
		}
		if (request.inFlight) {
			this.ctx.showStatus("The /btw chat is still answering. Wait for it to finish, then hand it off.");
			return;
		}
		if (request.contextExchanges.length === 0) {
			this.ctx.showStatus("This /btw chat has no completed answer to hand off.");
			return;
		}
		if (this.ctx.session.isCompacting) {
			this.ctx.showStatus("Compaction in progress. Hand off the /btw chat after it completes.");
			return;
		}
		const exchanges = request.contextExchanges.map(exchange => ({ ...exchange }));
		const parked: ParkedHandoff = { request, state: "pending", sessionId: this.ctx.sessionManager.getSessionId() };
		this.#parkedHandoff = parked;
		if (!fromParked) this.#hideActiveRequest();

		let accepted = false;
		const accept = () => {
			accepted = true;
			this.#releaseParkedHandoff(parked);
		};
		const details: BtwHandoffDetails = { exchangeCount: exchanges.length };
		const streaming = this.ctx.session.isStreaming;
		try {
			if (streaming) {
				// The chip text is the command itself: when a queue restore puts it
				// back in the editor on its own, it can be submitted again as-is.
				details.__pendingDisplayTag = this.ctx.session.enqueueCustomMessageDisplay("/btw-handoff", "followUp");
			}
			await this.ctx.session.promptCustomMessage<BtwHandoffDetails>(
				{
					customType: BTW_HANDOFF_MESSAGE_TYPE,
					content: renderBtwHandoffMessage(exchanges),
					display: true,
					details,
					attribution: "user",
				},
				{
					streamingBehavior: "followUp",
					followUpQueuePolicy: "sequential",
					// Only the idle path (the handoff runs as its own turn) takes
					// acceptance from here. A queued follow-up is accepted only when the
					// main session takes it from the queue, via `onQueuedPromoted`, so an
					// enqueue-time acceptance can never release the kept side chat.
					...(streaming ? {} : { onPreflightAccepted: accept }),
					// Called when the queued message is taken from the main queue, or
					// with `removed` when it leaves the queue unconsumed.
					onQueuedPromoted: promotion => {
						if (promotion.removed) {
							this.#returnParkedHandoff(
								parked,
								"The /btw handoff was taken out of the main queue before it ran.",
							);
						} else {
							accept();
						}
					},
				},
			);
			if (streaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			} else {
				// An idle session ran the handoff as its own turn.
				accept();
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (accepted) {
				this.ctx.showError(`The /btw handoff turn failed: ${reason}`);
			} else {
				this.#returnParkedHandoff(parked, `Failed to hand off the /btw chat: ${reason}`, true);
			}
		}
	}

	/** The kept handoff, or undefined; a handoff from another session is dropped. */
	#currentParkedHandoff(): ParkedHandoff | undefined {
		const parked = this.#parkedHandoff;
		if (!parked || parked.sessionId === this.ctx.sessionManager.getSessionId()) return parked;
		this.#parkedHandoff = undefined;
		this.#scrubRequest(parked.request);
		return undefined;
	}

	/** The main session took the handoff: wipe the kept side-chat state. */
	#releaseParkedHandoff(parked: ParkedHandoff): void {
		if (this.#parkedHandoff !== parked) return;
		this.#parkedHandoff = undefined;
		this.#scrubRequest(parked.request);
	}

	/** The handoff did not reach the main session: keep it for the user to reopen or resend. */
	#returnParkedHandoff(parked: ParkedHandoff, reason: string, isError = false): void {
		if (this.#parkedHandoff !== parked || parked.state === "returned") return;
		parked.state = "returned";
		const hint = this.#activeRequest ? RETURNED_BESIDE_OPEN_CHAT_STEPS : RETURNED_HANDOFF_HINT;
		this.#notify(`${reason} ${hint}`, isError);
	}

	#notify(message: string, isError: boolean): void {
		if (isError) this.ctx.showError(message);
		else this.ctx.showStatus(message);
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
		this.#showRequest(request);
		return request;
	}

	#showRequest(request: BtwRequest): void {
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
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
		this.#hideActiveRequest();
		this.#scrubRequest(request);
		this.ctx.editor?.setText("");
	}

	/** Remove the panel from view without touching the request's state. */
	#hideActiveRequest(): void {
		this.#activeRequest = undefined;
		this.ctx.pendingImages = [];
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#scrubRequest(request: BtwRequest): void {
		const turn = request.activeTurn;
		const abortController = turn?.abortController;
		if (turn) this.#scrubTurn(turn);
		request.activeTurn = undefined;
		request.contextExchanges.splice(0);
		request.inFlight = false;
		const scope = request.conversationScope;
		request.conversationScope = undefined;
		// The session owns the scrub contract: visible-text snapshot and any provider-prefix material.
		if (scope) this.ctx.session.releaseBtwConversationScope(scope);
		abortController?.abort();
		request.component.close();
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
