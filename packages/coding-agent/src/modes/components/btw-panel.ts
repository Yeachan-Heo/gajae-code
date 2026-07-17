import { type Component, Container, Markdown, Spacer, Text, type TUI } from "@gajae-code/tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type BtwPanelState = "running" | "complete" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	retained?: boolean;
	tui: TUI;
}

interface RetainedTurn {
	question: string;
	answer: string;
	state: BtwPanelState;
	errorMessage?: string;
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#retained: boolean;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#completedTurns: RetainedTurn[] = [];
	#streamingContent = new Container();
	#closed = false;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#retained = options.retained ?? false;
		this.#tui = options.tui;
		this.#rebuild();
	}

	beginRetainedTurn(question: string): void {
		if (!this.#retained || this.#closed) return;
		this.#completedTurns.push(this.#currentTurn());
		this.#question = question;
		this.#answer = "";
		this.#errorMessage = undefined;
		this.#state = "running";
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		if (this.#retained) {
			this.#updateStreamingContent();
			return;
		}
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		if (this.#retained) {
			this.#updateStreamingContent();
			return;
		}
		this.#rebuild();
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
		this.#errorMessage = message;
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
		this.#completedTurns = [];
		this.#answer = "";
		this.#errorMessage = undefined;
		this.#streamingContent.clear();
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder(str => theme.fg("dim", str)));
		this.addChild(new Spacer(1));
		if (this.#retained) {
			for (const turn of this.#completedTurns) {
				this.addChild(this.#turnComponent(turn));
				this.addChild(new Spacer(1));
			}
			this.addChild(new Text(theme.fg("accent", replaceTabs(this.#question)), 1, 0));
			this.addChild(new Spacer(1));
			this.#updateStreamingContent(false);
			this.addChild(this.#streamingContent);
		} else {
			this.addChild(new Text(theme.fg("accent", replaceTabs(this.#question)), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.#contentComponent(this.#state, this.#answer, this.#errorMessage));
		}
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

	#currentTurn(): RetainedTurn {
		return {
			question: this.#question,
			answer: this.#answer,
			state: this.#state,
			errorMessage: this.#errorMessage,
		};
	}

	#turnComponent(turn: RetainedTurn): Component {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", replaceTabs(turn.question)), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(this.#contentComponent(turn.state, turn.answer, turn.errorMessage));
		return container;
	}

	#footerLine(): string {
		if (this.#retained) {
			switch (this.#state) {
				case "running":
					return theme.fg("muted", "Esc cancel /btw-r");
				case "complete":
					return theme.fg("muted", "Type a follow-up · Esc dismiss");
				case "aborted":
					return theme.fg("warning", `${theme.status.warning} Cancelled · Type a follow-up · Esc dismiss`);
				case "error":
					return theme.fg("error", `${theme.status.error} Error · Type a follow-up · Esc dismiss`);
			}
		}
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc cancel /btw");
			case "complete":
				return theme.fg("muted", "Esc dismiss");
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc dismiss`);
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
		return new Markdown(text, 1, 0, getMarkdownTheme());
	}
}
