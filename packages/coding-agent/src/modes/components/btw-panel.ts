import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@gajae-code/tui";
import {
	BTW_MAX_ANSWER_UTF8_BYTES,
	BTW_MAX_CONTEXT_TURNS,
	sanitizeBtwError,
	truncateUtf8,
} from "../../session/btw-contract";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type BtwPanelState = "running" | "complete" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
}

interface BtwTurn {
	question: string;
	answer: string;
	state: BtwPanelState;
	errorMessage?: string;
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#completedTurns: BtwTurn[] = [];
	#streamingContent = new Container();
	#closed = false;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#tui = options.tui;
		this.#rebuild();
	}

	beginTurn(question: string): void {
		if (this.#closed) return;
		if (this.#state === "complete") {
			this.#completedTurns.push(this.#currentTurn());
			if (this.#completedTurns.length > BTW_MAX_CONTEXT_TURNS) this.#completedTurns.shift();
		}
		this.#question = question;
		this.#answer = "";
		this.#errorMessage = undefined;
		this.#state = "running";
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer = truncateUtf8(this.#answer + delta, BTW_MAX_ANSWER_UTF8_BYTES);
		this.#updateStreamingContent();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = truncateUtf8(text, BTW_MAX_ANSWER_UTF8_BYTES);
		this.#updateStreamingContent();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#answer = "";
		this.#errorMessage = sanitizeBtwError(message);
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
		this.#question = "";
		this.#completedTurns = [];
		this.#answer = "";
		this.#errorMessage = undefined;
		this.#streamingContent.clear();
		this.clear();
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		for (const turn of this.#completedTurns) {
			this.addChild(this.#turnComponent(turn));
			this.addChild(new Spacer(1));
		}
		this.addChild(new Text(theme.fg("accent", replaceTabs(this.#question)), 1, 0));
		this.addChild(new Spacer(1));
		this.#updateStreamingContent(false);
		this.addChild(this.#streamingContent);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.#footerLine(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.#tui.requestRender();
	}

	#updateStreamingContent(requestRender = true): void {
		this.#streamingContent.clear();
		this.#streamingContent.addChild(this.#contentComponent(this.#state, this.#answer, this.#errorMessage));
		if (requestRender) this.#tui.requestRender();
	}

	#currentTurn(): BtwTurn {
		return {
			question: this.#question,
			answer: this.#answer,
			state: this.#state,
			errorMessage: this.#errorMessage,
		};
	}

	#turnComponent(turn: BtwTurn): Component {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", replaceTabs(turn.question)), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(this.#contentComponent(turn.state, turn.answer, turn.errorMessage));
		return container;
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc cancel /btw and return to main chat");
			case "complete":
				return theme.fg("muted", "Type a follow-up · Esc return to main chat");
			case "aborted":
				return theme.fg(
					"warning",
					`${theme.status.warning} Cancelled · Type a follow-up · Esc return to main chat`,
				);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Type a follow-up · Esc return to main chat`);
		}
	}

	#contentComponent(state: BtwPanelState, answer: string, errorMessage: string | undefined): Component {
		if (state === "error") {
			return new Text(theme.fg("error", replaceTabs(errorMessage ?? "Unknown error")), 1, 0);
		}
		const text = replaceTabs(answer).trim();
		if (!text) {
			const waiting = state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), 1, 0);
		}
		if (state === "running") return new Text(text, 1, 0);
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
