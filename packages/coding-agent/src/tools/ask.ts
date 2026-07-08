/**
 * Ask Tool - Interactive user prompting during execution
 *
 * Use this tool when you need to ask the user questions during execution.
 * This allows you to:
 *   1. Gather user preferences or requirements
 *   2. Clarify ambiguous instructions
 *   3. Get decisions on implementation choices as you work
 *   4. Offer choices to the user about what direction to take
 *
 * Usage notes:
 *   - Users will always be able to select "Other" to provide custom text input
 *   - Use multi: true to allow multiple answers to be selected for a question
 *   - Use recommended: <index> to mark the default option; "(Recommended)" suffix is added automatically
 *   - Questions may time out and auto-select the recommended option (configurable, disabled in plan mode)
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import {
	type Component,
	Container,
	Markdown,
	renderInlineMarkdown,
	TERMINAL,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import { logger, prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import {
	formatDeepInterviewSelectorPrompt,
	isDeepInterviewAskQuestion,
	renderDeepInterviewAskQuestion,
} from "../deep-interview/render-middleware";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { appendOrMergeDeepInterviewRound, syncDeepInterviewRecorderHud } from "../gjc-runtime/deep-interview-recorder";
import { deepInterviewStatePath } from "../gjc-runtime/deep-interview-runtime";
import { gateAnswerToResult, questionToGate } from "../modes/shared/agent-wire/deep-interview-gate";
import { getMarkdownTheme, type Theme, theme } from "../modes/theme/theme";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { formatErrorMessage, formatMeta, formatTitle } from "./render-utils";
import { ToolAbortError } from "./tool-errors";
import { assertUltragoalAskAllowed } from "./ultragoal-ask-guard";

// =============================================================================
// Types
// =============================================================================

const OptionItem = z.object({
	label: z.string().describe("display label"),
});

/** Optional structured deep-interview round metadata; when present the round is recorded automatically. */
const DeepInterviewMeta = z.object({
	round_id: z.string().describe("stable optional round identity").optional(),
	round: z.number().int().nonnegative().describe("round number"),
	component: z.string().min(1).describe("targeted topology component"),
	dimension: z.string().min(1).describe("targeted clarity dimension"),
	ambiguity: z.number().min(0).max(1).describe("ambiguity at ask time (0..1)"),
});

const WorkflowGateMeta = z.object({
	stage: z.enum(["deep-interview", "ralplan", "ultragoal"]).describe("workflow gate stage"),
	kind: z.enum(["question", "approval", "execution"]).describe("workflow gate kind"),
});

const QuestionItem = z.object({
	id: z.string().describe("question id"),
	question: z.string().describe("question text"),
	options: z.array(OptionItem).describe("available options"),
	multi: z.boolean().describe("allow multiple selections").optional(),
	recommended: z.number().describe("recommended option index").optional(),
	deepInterview: DeepInterviewMeta.describe("optional deep-interview round metadata").optional(),
	workflowGate: WorkflowGateMeta.describe("optional workflow gate stage/kind override").optional(),
});

export const askSchema = z.object({
	questions: z.array(QuestionItem).min(1).describe("questions to ask"),
});

export type AskToolInput = z.infer<typeof askSchema>;

/** Result for a single question */
export interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	clarificationQuestion?: string;
}

export interface AskToolDetails {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	clarificationQuestion?: string;
	/** Multi-part question mode */
	results?: QuestionResult[];
}

// =============================================================================
// Constants
// =============================================================================

const OTHER_OPTION = "Other (type your own)";
const ASK_CLARIFICATION_OPTION = "Ask about these choices";
const RECOMMENDED_SUFFIX = " (Recommended)";
const DEEP_INTERVIEW_SELECTOR_SCROLL_TITLE_ROWS = Number.MAX_SAFE_INTEGER;
const DEEP_INTERVIEW_RECORDER_AWAIT_TIMEOUT_MS = 250;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function awaitDeepInterviewRecorderPersistence(persistence: Promise<void>): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			persistence,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`timed out after ${DEEP_INTERVIEW_RECORDER_AWAIT_TIMEOUT_MS}ms`)),
					DEEP_INTERVIEW_RECORDER_AWAIT_TIMEOUT_MS,
				);
			}),
		]);
	} catch (error) {
		logger.warn(`ask: deep-interview round recording failed: ${errorMessage(error)}`);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function getDoneOptionLabel(): string {
	return `${theme.status.success} Done selecting`;
}

/** Add "(Recommended)" suffix to the option at the given index if not already present */
function addRecommendedSuffix(labels: string[], recommendedIndex?: number): string[] {
	if (recommendedIndex === undefined || recommendedIndex < 0 || recommendedIndex >= labels.length) {
		return labels;
	}
	return labels.map((label, i) => {
		if (i === recommendedIndex && !label.endsWith(RECOMMENDED_SUFFIX)) {
			return label + RECOMMENDED_SUFFIX;
		}
		return label;
	});
}

function getAutoSelectionOnTimeout(optionLabels: string[], recommended?: number): string[] {
	if (optionLabels.length === 0) return [];
	if (typeof recommended === "number" && recommended >= 0 && recommended < optionLabels.length) {
		return [optionLabels[recommended]];
	}
	return [optionLabels[0]];
}

/** Strip "(Recommended)" suffix from a label */
function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

function formatNumberedOptionLabel(label: string, index: number): string {
	if (/^\s*\d+[.)]\s+/.test(label)) {
		return label;
	}
	return `${index + 1}. ${label}`;
}

function numberOptionLabels(labels: string[]): string[] {
	return labels.map(formatNumberedOptionLabel);
}

// =============================================================================
// Question Selection Logic
// =============================================================================

interface SelectionResult {
	selectedOptions: string[];
	customInput?: string;
	clarificationQuestion?: string;
	timedOut: boolean;
	navigation?: "back" | "forward";
	cancelled?: boolean;
}

interface NavigationControls {
	allowBack: boolean;
	allowForward: boolean;
	progressText?: string;
}
interface AskSingleQuestionOptions {
	recommended?: number;
	timeout?: number;
	signal?: AbortSignal;
	initialSelection?: Pick<SelectionResult, "selectedOptions" | "customInput">;
	navigation?: NavigationControls;
	scrollTitleRows?: number;
	otherOptionLabel?: string;
	clarificationOptionLabel?: string;
}

interface UIContext {
	select(
		prompt: string,
		options: string[],
		options_?: {
			initialIndex?: number;
			timeout?: number;
			signal?: AbortSignal;
			outline?: boolean;
			wrapFocused?: boolean;
			scrollTitleRows?: number;
			onTimeout?: () => void;
			onLeft?: () => void;
			onRight?: () => void;
			helpText?: string;
			customInput?: { optionLabel: string; onSubmit: (text: string) => void };
			clarificationInput?: { optionLabel: string; onSubmit: (text: string) => void; allowEmpty?: boolean };
		},
	): Promise<string | undefined>;
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
}

async function askSingleQuestion(
	ui: UIContext,
	question: string,
	optionLabels: string[],
	multi: boolean,
	options: AskSingleQuestionOptions = {},
): Promise<SelectionResult> {
	const { recommended, timeout, signal, initialSelection, navigation, scrollTitleRows } = options;
	const doneLabel = getDoneOptionLabel();
	const otherOptionLabel = options.otherOptionLabel ?? OTHER_OPTION;
	const clarificationOptionLabel = options.clarificationOptionLabel;
	let selectedOptions = [...(initialSelection?.selectedOptions ?? [])];
	let customInput = initialSelection?.customInput;
	let timedOut = false;

	const selectOption = async (
		prompt: string,
		optionsToShow: string[],
		initialIndex?: number,
	): Promise<{
		choice: string | undefined;
		timedOut: boolean;
		navigation?: "back" | "forward";
		inlineInput?: string;
		inlineClarification?: string;
	}> => {
		let timeoutTriggered = false;
		const onTimeout = () => {
			timeoutTriggered = true;
		};
		// Inline custom/clarification input: the TUI selector keeps the question
		// and option list on screen and collects text below the list, instead of
		// swapping to a separate editor screen that hides the question.
		let inlineInput: string | undefined;
		let inlineClarification: string | undefined;
		let navigationAction: "back" | "forward" | undefined;
		const baseHelpText = navigation
			? "up/down navigate  enter select  ←/→ question  esc cancel"
			: "up/down navigate  enter select  esc cancel";
		const helpText =
			scrollTitleRows === undefined
				? baseHelpText
				: navigation
					? "↑/↓ select  enter  ←/→ question  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript"
					: "↑/↓ select  enter  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript";
		const dialogOptions = {
			initialIndex,
			timeout,
			signal,
			outline: true,
			wrapFocused: true,
			scrollTitleRows,
			onTimeout,
			helpText,
			customInput: {
				optionLabel: otherOptionLabel,
				onSubmit: (text: string) => {
					inlineInput = text;
				},
			},
			clarificationInput: clarificationOptionLabel
				? {
						optionLabel: clarificationOptionLabel,
						allowEmpty: false,
						onSubmit: (text: string) => {
							inlineClarification = text;
						},
					}
				: undefined,
			onLeft: navigation?.allowBack
				? () => {
						navigationAction = "back";
					}
				: undefined,
			onRight: navigation?.allowForward
				? () => {
						navigationAction = "forward";
					}
				: undefined,
		};
		const startMs = Date.now();
		const choice = signal
			? await untilAborted(signal, () => ui.select(prompt, optionsToShow, dialogOptions))
			: await ui.select(prompt, optionsToShow, dialogOptions);
		if (!timeoutTriggered && choice === undefined && typeof timeout === "number") {
			timeoutTriggered = Date.now() - startMs >= timeout;
		}
		return { choice, timedOut: timeoutTriggered, navigation: navigationAction, inlineInput, inlineClarification };
	};

	// Fallback for UI contexts that don't support inline custom input (they
	// resolve the "Other" label without invoking customInput.onSubmit).
	const promptForCustomInput = async (): Promise<{ input: string | undefined }> => {
		const dialogOptions = signal ? { signal } : undefined;
		const showCustomInput = () => ui.editor("Enter your response:", undefined, dialogOptions, { promptStyle: true });
		const input = signal ? await untilAborted(signal, showCustomInput) : await showCustomInput();
		return { input };
	};
	const promptForClarificationInput = async (): Promise<{ input: string | undefined }> => {
		const dialogOptions = signal ? { signal } : undefined;
		const showClarificationInput = () =>
			ui.editor("Ask a clarification question:", undefined, dialogOptions, { promptStyle: true });
		const input = signal ? await untilAborted(signal, showClarificationInput) : await showClarificationInput();
		return { input: input !== undefined && input.trim() === "" ? undefined : input };
	};

	const promptWithProgress = navigation?.progressText ? `${question} (${navigation.progressText})` : question;
	if (multi) {
		const selected = new Set<string>(selectedOptions);
		let cursorIndex = Math.min(Math.max(recommended ?? 0, 0), Math.max(optionLabels.length - 1, 0));
		const firstSelected = selectedOptions[0];
		if (firstSelected) {
			const selectedIndex = optionLabels.indexOf(firstSelected);
			if (selectedIndex >= 0) cursorIndex = selectedIndex;
		}
		while (true) {
			const opts: string[] = [];

			for (const opt of optionLabels) {
				const checkbox = selected.has(opt) ? theme.checkbox.checked : theme.checkbox.unchecked;
				opts.push(`${checkbox} ${opt}`);
			}

			if (!navigation?.allowForward && selected.size > 0) {
				opts.push(doneLabel);
			}
			opts.push(otherOptionLabel);
			if (clarificationOptionLabel) {
				opts.push(clarificationOptionLabel);
			}

			const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
			const {
				choice,
				timedOut: selectTimedOut,
				navigation: arrowNavigation,
				inlineInput,
				inlineClarification,
			} = await selectOption(`${prefix}${promptWithProgress}`, opts, cursorIndex);

			if (arrowNavigation) {
				return { selectedOptions: Array.from(selected), customInput, timedOut, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				return { selectedOptions: Array.from(selected), customInput, timedOut, cancelled: true };
			}
			if (choice === doneLabel) break;

			if (choice === otherOptionLabel) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				const input = inlineInput !== undefined ? inlineInput : (await promptForCustomInput()).input;
				if (input === undefined) {
					break;
				}
				customInput = input;
				break;
			}
			if (clarificationOptionLabel && choice === clarificationOptionLabel) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				const input =
					inlineClarification !== undefined ? inlineClarification : (await promptForClarificationInput()).input;
				if (input === undefined) {
					break;
				}
				return { selectedOptions: [], clarificationQuestion: input, timedOut };
			}

			const selectedIdx = opts.indexOf(choice);
			if (selectedIdx >= 0) {
				cursorIndex = selectedIdx;
			}

			const checkedPrefix = `${theme.checkbox.checked} `;
			const uncheckedPrefix = `${theme.checkbox.unchecked} `;
			let opt: string | undefined;
			if (choice.startsWith(checkedPrefix)) {
				opt = choice.slice(checkedPrefix.length);
			} else if (choice.startsWith(uncheckedPrefix)) {
				opt = choice.slice(uncheckedPrefix.length);
			}
			if (opt) {
				if (selected.has(opt)) {
					selected.delete(opt);
				} else {
					selected.add(opt);
				}
			}

			if (selectTimedOut) {
				timedOut = true;
				break;
			}
		}
		selectedOptions = Array.from(selected);
	} else {
		const displayLabels = addRecommendedSuffix(optionLabels, recommended);
		const optionsWithNavigation = clarificationOptionLabel
			? [...displayLabels, otherOptionLabel, clarificationOptionLabel]
			: [...displayLabels, otherOptionLabel];

		let initialIndex = recommended;
		const previouslySelected = selectedOptions[0];
		if (previouslySelected) {
			const selectedIndex = optionLabels.indexOf(previouslySelected);
			if (selectedIndex >= 0) initialIndex = selectedIndex;
		} else if (customInput !== undefined) {
			initialIndex = displayLabels.length;
		}
		if (initialIndex !== undefined) {
			const maxIndex = Math.max(optionsWithNavigation.length - 1, 0);
			initialIndex = Math.max(0, Math.min(initialIndex, maxIndex));
		}

		const {
			choice,
			timedOut: selectTimedOut,
			navigation: arrowNavigation,
			inlineInput,
			inlineClarification,
		} = await selectOption(promptWithProgress, optionsWithNavigation, initialIndex);
		timedOut = selectTimedOut;

		if (arrowNavigation) {
			return { selectedOptions, customInput, timedOut, navigation: arrowNavigation };
		}
		if (choice === undefined) {
			if (!timedOut) {
				return { selectedOptions, customInput, timedOut, cancelled: true };
			}
		} else if (choice === otherOptionLabel) {
			if (!selectTimedOut) {
				const input = inlineInput !== undefined ? inlineInput : (await promptForCustomInput()).input;
				if (input !== undefined) {
					customInput = input;
					selectedOptions = [];
				}
				// If input was dismissed (undefined), keep prior selectedOptions/customInput intact
			}
		} else if (clarificationOptionLabel && choice === clarificationOptionLabel) {
			if (!selectTimedOut) {
				const input =
					inlineClarification !== undefined ? inlineClarification : (await promptForClarificationInput()).input;
				if (input !== undefined) {
					return { selectedOptions: [], clarificationQuestion: input, timedOut };
				}
				// If input was dismissed (undefined), keep prior selectedOptions/customInput intact
			}
		} else {
			const stripped = stripRecommendedSuffix(choice);
			if (optionLabels.includes(stripped)) {
				selectedOptions = [stripped];
				customInput = undefined;
			} else {
				// A remote answer (e.g. a typed Telegram reply) that is not one of the
				// listed options is the "provide my own" custom input — recorded the same
				// as picking Other and typing it. The local selector can only ever return
				// a listed entry, so this branch is reached only for free-text answers.
				customInput = choice;
				selectedOptions = [];
			}
		}
		if (navigation?.allowForward) {
			return { selectedOptions, customInput, timedOut, navigation: "forward" };
		}
	}

	if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
		selectedOptions = getAutoSelectionOnTimeout(optionLabels, recommended);
	}

	return { selectedOptions, customInput, timedOut };
}

function formatQuestionResult(result: QuestionResult): string {
	if (result.clarificationQuestion !== undefined) {
		return `${result.id}: clarification requested: ${result.clarificationQuestion}`;
	}
	if (result.customInput !== undefined) {
		return `${result.id}: "${result.customInput}"`;
	}
	if (result.selectedOptions.length > 0) {
		return result.multi
			? `${result.id}: [${result.selectedOptions.join(", ")}]`
			: `${result.id}: ${result.selectedOptions[0]}`;
	}
	return `${result.id}: (cancelled)`;
}

// =============================================================================
// Tool Class
// =============================================================================

type AskParams = AskToolInput;

/**
 * Ask tool for interactive user prompting during execution.
 *
 * Allows gathering user preferences, clarifying instructions, and getting decisions
 * on implementation choices as the agent works.
 */
export class AskTool implements AgentTool<typeof askSchema, AskToolDetails> {
	readonly name = "ask";
	readonly label = "Ask";
	readonly summary = "Ask the user a clarifying question";
	readonly description: string;
	readonly parameters = askSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(askDescription);
	}

	static createIf(session: ToolSession): AskTool | null {
		return session.hasUI || session.getWorkflowGateEmitter?.() ? new AskTool(session) : null;
	}

	/** Send terminal notification when ask tool is waiting for input */
	#sendAskNotification(): void {
		const method = this.session.settings.get("ask.notify");
		if (method === "off") return;
		TERMINAL.sendNotification("Waiting for input");
	}

	/**
	 * Record a resolved deep-interview round when the question carries structured
	 * metadata. The runtime owns durable record/merge semantics; this tool is only the
	 * caller. Best-effort: a state-write hiccup must not break the user's answer flow.
	 */
	async #recordDeepInterviewRound(
		q: AskParams["questions"][number],
		selectedOptions: string[],
		customInput: string | undefined,
	): Promise<void> {
		const meta = q.deepInterview;
		if (!meta) return;
		const activeSkill = this.session.getActiveSkillState?.()?.skill?.trim();
		if (activeSkill !== "deep-interview") return;
		const cwd = this.session.cwd;
		const sessionId = this.session.getSessionId?.() ?? undefined;
		const statePath = deepInterviewStatePath(cwd, sessionId);
		await awaitDeepInterviewRecorderPersistence(
			appendOrMergeDeepInterviewRound(
				cwd,
				statePath,
				{
					round: meta.round,
					round_id: meta.round_id,
					questionId: q.id,
					questionText: q.question,
					component: meta.component,
					dimension: meta.dimension,
					ambiguity: meta.ambiguity,
					selectedOptions,
					customInput,
				},
				{ sessionId },
			).then(async () => {
				await syncDeepInterviewRecorderHud(cwd, statePath, sessionId);
			}),
		);
	}

	async execute(
		_toolCallId: string,
		params: AskParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AskToolDetails>> {
		await assertUltragoalAskAllowed(this.session.cwd, {
			activeSkillState: this.session.getActiveSkillState?.(),
			sessionId: this.session.getSessionId?.() ?? null,
		});
		const gateEmitter = this.session.getWorkflowGateEmitter?.();
		const canUseWorkflowGate = gateEmitter?.isUnattended() === true;

		// Headless fallback: unattended workflow gates are the non-TUI answer path.
		if (!canUseWorkflowGate && (!context?.hasUI || !context.ui)) {
			context?.abort();
			throw new ToolAbortError("Ask tool requires interactive mode");
		}

		const extensionUi = context?.ui;
		const ui: UIContext = {
			select: (prompt, options, dialogOptions) => {
				if (!extensionUi) throw new ToolAbortError("Ask tool requires interactive mode");
				const source = this.session.getAskAnswerSource?.();
				if (!source) return extensionUi.select(prompt, options, dialogOptions);
				// Race the local UI against a remote answer (e.g. a Telegram reply via the
				// notifications SDK) so asks can be answered without RPC mode. When the
				// local UI wins, abort the remote source so it stops waiting and marks the
				// action resolved-locally. First valid answer wins.
				// Race the local UI against a remote answer (e.g. a Telegram reply via the
				// notifications SDK) so asks can be answered without RPC mode. First valid
				// answer wins; the loser is aborted so neither side is left hanging:
				//   - local wins  -> abort the remote source (marks the action resolved-locally)
				//   - remote wins -> abort the local selector so the TUI dialog actually closes
				const remoteController = new AbortController();
				const localController = new AbortController();
				// Propagate an external cancel (the tool's signal) to the local selector too.
				const toolSignal = dialogOptions?.signal;
				if (toolSignal) {
					if (toolSignal.aborted) localController.abort();
					else toolSignal.addEventListener("abort", () => localController.abort(), { once: true });
				}
				const remote = source.awaitAnswer(prompt, options, remoteController.signal).then(answer => {
					// undefined is not a valid remote answer (registration failed, or the local
					// UI already won and aborted us): never settle the race, let the local
					// selector decide instead of cancelling the ask.
					if (answer === undefined) return new Promise<string | undefined>(() => {});
					localController.abort();
					return answer;
				});
				const local = extensionUi
					.select(prompt, options, { ...dialogOptions, signal: localController.signal })
					.then(answer => {
						remoteController.abort();
						return answer;
					});
				// The losing selector may reject when aborted after the race already settled;
				// swallow that so it is not an unhandled rejection (the race result is unaffected).
				void local.catch(() => undefined);
				return Promise.race([local, remote]);
			},
			editor: (title, prefill, dialogOptions, editorOptions) => {
				if (!extensionUi) throw new ToolAbortError("Ask tool requires interactive mode");
				const source = this.session.getAskAnswerSource?.();
				if (!source) return extensionUi.editor(title, prefill, dialogOptions, editorOptions);
				// Race the local editor against a remote free-text answer so "Other / type
				// your own" custom input can be provided remotely (e.g. a typed Telegram
				// reply) instead of blocking on the local-only editor. Mirrors `select`.
				const remoteController = new AbortController();
				const localController = new AbortController();
				const toolSignal = dialogOptions?.signal;
				if (toolSignal) {
					if (toolSignal.aborted) localController.abort();
					else toolSignal.addEventListener("abort", () => localController.abort(), { once: true });
				}
				const remote = source.awaitAnswer(title, [], remoteController.signal).then(answer => {
					if (answer === undefined) return new Promise<string | undefined>(() => {});
					localController.abort();
					return answer;
				});
				const local = extensionUi
					.editor(title, prefill, { ...(dialogOptions ?? {}), signal: localController.signal }, editorOptions)
					.then(answer => {
						remoteController.abort();
						return answer;
					});
				void local.catch(() => undefined);
				return Promise.race([local, remote]);
			},
		};

		// Determine timeout based on settings and plan mode
		const planModeEnabled = this.session.getPlanModeState?.()?.enabled ?? false;
		// Settings.get("ask.timeout") returns seconds (0 = disabled), convert to ms
		const timeoutSeconds = this.session.settings.get("ask.timeout");
		const settingsTimeout = timeoutSeconds === 0 ? null : timeoutSeconds * 1000;
		const timeout = planModeEnabled ? null : settingsTimeout;

		// Send notification if waiting and not suppressed
		this.#sendAskNotification();

		if (params.questions.length === 0) {
			return {
				content: [{ type: "text" as const, text: "Error: questions must not be empty" }],
				details: {},
			};
		}

		const askQuestion = async (
			q: AskParams["questions"][number],
			options?: { previous?: QuestionResult; navigation?: NavigationControls },
		) => {
			const rawOptionLabels = q.options.map(o => o.label);
			// Unattended (#316/#323/G011): route the question through the workflow-gate
			// emitter instead of the interactive UI; the external agent answers over RPC.
			if (gateEmitter && canUseWorkflowGate) {
				const gateQuestion = {
					id: q.id,
					question: q.question,
					options: q.options,
					multi: q.multi,
					recommended: q.recommended,
					deepInterview: q.deepInterview,
					workflowGate: q.workflowGate,
				};
				const answer = await gateEmitter.emitGate(questionToGate(gateQuestion));
				const decoded = gateAnswerToResult(gateQuestion, answer);
				return {
					optionLabels: rawOptionLabels,
					selectedOptions: decoded.selectedOptions,
					customInput: decoded.customInput,
					clarificationQuestion: decoded.clarificationQuestion,
					navigation: undefined as NavigationControls | undefined,
					cancelled: false,
					timedOut: false,
				};
			}
			try {
			const deepInterviewPrompt = formatDeepInterviewSelectorPrompt(q.question);
			const activeSkill = this.session.getActiveSkillState?.()?.skill?.trim();
			const isDeepInterviewActive = activeSkill === "deep-interview";
			const isDeepInterviewQuestion = isDeepInterviewActive && (deepInterviewPrompt !== null || q.deepInterview !== undefined);
				const displayQuestion = deepInterviewPrompt ?? q.question;
				const shouldNumberOptions = isDeepInterviewQuestion || isDeepInterviewAskQuestion(q.question);
				const optionLabels = shouldNumberOptions ? numberOptionLabels(rawOptionLabels) : rawOptionLabels;
				const clarificationOptionLabel = shouldNumberOptions
					? formatNumberedOptionLabel(ASK_CLARIFICATION_OPTION, optionLabels.length + 1)
					: undefined;
				const initialSelection =
					shouldNumberOptions && options?.previous
						? {
								...options.previous,
								selectedOptions: options.previous.selectedOptions.map(selected => {
									const rawIndex = rawOptionLabels.indexOf(selected);
									return rawIndex >= 0 ? (optionLabels[rawIndex] ?? selected) : selected;
								}),
							}
						: options?.previous;
				const {
					selectedOptions: displaySelectedOptions,
					customInput,
					clarificationQuestion,
					navigation,
					cancelled,
					timedOut,
				} = await askSingleQuestion(ui, displayQuestion, optionLabels, q.multi ?? false, {
					recommended: q.recommended,
					timeout: timeout ?? undefined,
					signal,
					initialSelection,
					navigation: options?.navigation,
					scrollTitleRows: isDeepInterviewQuestion ? DEEP_INTERVIEW_SELECTOR_SCROLL_TITLE_ROWS : undefined,
					otherOptionLabel: shouldNumberOptions
						? formatNumberedOptionLabel(OTHER_OPTION, optionLabels.length)
						: undefined,
					clarificationOptionLabel,
				});
				const selectedOptions = shouldNumberOptions
					? displaySelectedOptions.map(selected => {
							const displayIndex = optionLabels.indexOf(selected);
							return displayIndex >= 0 ? (rawOptionLabels[displayIndex] ?? selected) : selected;
						})
					: displaySelectedOptions;
				return {
					optionLabels: rawOptionLabels,
					selectedOptions,
					customInput,
					clarificationQuestion,
					navigation,
					cancelled,
					timedOut,
				};
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					throw new ToolAbortError("Ask input was cancelled");
				}
				throw error;
			}
		};

		if (params.questions.length === 1) {
			const [q] = params.questions;
			const { optionLabels, selectedOptions, customInput, clarificationQuestion, cancelled, timedOut } =
				await askQuestion(q);

			if (
				!timedOut &&
				(cancelled ||
					(selectedOptions.length === 0 && customInput === undefined && clarificationQuestion === undefined))
			) {
				context?.abort();
				throw new ToolAbortError("Ask tool was cancelled by the user");
			}
			if (clarificationQuestion === undefined) {
				await this.#recordDeepInterviewRound(q, selectedOptions, customInput);
			}
			const details: AskToolDetails = {
				question: q.question,
				options: optionLabels,
				multi: q.multi ?? false,
				selectedOptions,
				customInput,
				clarificationQuestion,
			};

			const responseParts: string[] = [];
			if (clarificationQuestion !== undefined) {
				responseParts.push(
					clarificationQuestion.includes("\n")
						? `User asked a clarification question about the choices:\n${clarificationQuestion
								.split("\n")
								.map(line => `  ${line}`)
								.join("\n")}`
						: `User asked a clarification question about the choices: ${clarificationQuestion}`,
				);
			}
			if (selectedOptions.length > 0) {
				responseParts.push(
					q.multi ? `User selected: ${selectedOptions.join(", ")}` : `User selected: ${selectedOptions[0]}`,
				);
			}
			if (customInput !== undefined) {
				responseParts.push(
					customInput.includes("\n")
						? `User provided custom input:\n${customInput
								.split("\n")
								.map(line => `  ${line}`)
								.join("\n")}`
						: `User provided custom input: ${customInput}`,
				);
			}
			const responseText = responseParts.length > 0 ? responseParts.join("\n") : "User cancelled the selection";

			return { content: [{ type: "text" as const, text: responseText }], details };
		}

		const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: params.questions.length });
		let questionIndex = 0;
		while (questionIndex < params.questions.length) {
			const q = params.questions[questionIndex]!;
			const previous = resultsByIndex[questionIndex];
			const navigation: NavigationControls = {
				allowBack: questionIndex > 0,
				allowForward: true,
				progressText: `${questionIndex + 1}/${params.questions.length}`,
			};
			const {
				optionLabels,
				selectedOptions,
				customInput,
				clarificationQuestion,
				navigation: navAction,
				cancelled,
				timedOut,
			} = await askQuestion(q, { previous, navigation });

			if (cancelled && !timedOut) {
				context?.abort();
				throw new ToolAbortError("Ask tool was cancelled by the user");
			}

			resultsByIndex[questionIndex] = {
				id: q.id,
				question: q.question,
				options: optionLabels,
				multi: q.multi ?? false,
				selectedOptions,
				customInput,
				clarificationQuestion,
			};

			if (clarificationQuestion === undefined) {
				await this.#recordDeepInterviewRound(q, selectedOptions, customInput);
			}

			if (navAction === "back") {
				questionIndex = Math.max(0, questionIndex - 1);
				continue;
			}

			questionIndex += 1;
		}

		const results = resultsByIndex.map((result, index) => {
			if (result) return result;
			const q = params.questions[index]!;
			return {
				id: q.id,
				question: q.question,
				options: q.options.map(o => o.label),
				multi: q.multi ?? false,
				selectedOptions: [],
			};
		});

		const details: AskToolDetails = { results };
		const responseLines = results.map(formatQuestionResult);
		const responseText = `User answers:\n${responseLines.join("\n")}`;

		return { content: [{ type: "text" as const, text: responseText }], details };
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AskRenderArgs {
	question?: string;
	options?: Array<{ label: string }>;
	multi?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		options: Array<{ label: string }>;
		multi?: boolean;
	}>;
}

/** Render custom input as a single block with continuation lines (not one entry per line) */
function renderCustomInput(
	uiTheme: Theme,
	prefix: string,
	customInput: string,
	isLastEntry: boolean,
	includeLeadingNewline = true,
): string {
	const lines = customInput.split("\n");
	const branch = isLastEntry ? uiTheme.tree.last : uiTheme.tree.branch;
	const firstLine = lines[0] ?? "";
	let text = `${includeLeadingNewline ? "\n" : ""}${prefix}${uiTheme.fg("dim", branch)} ${uiTheme.styledSymbol("status.success", "success")} ${uiTheme.fg("toolOutput", firstLine)}`;
	const continuationIndent = isLastEntry ? "   " : `${uiTheme.fg("dim", uiTheme.tree.vertical)}  `;
	for (let i = 1; i < lines.length; i++) {
		text += `\n${prefix}${continuationIndent}   ${uiTheme.fg("toolOutput", lines[i])}`;
	}
	return text;
}

interface RenderOptionListEntry {
	prefix: string;
	label: string;
}

class AskOptionList implements Component {
	constructor(private readonly entries: RenderOptionListEntry[]) {}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const entry of this.entries) {
			const prefixWidth = visibleWidth(entry.prefix);
			const availableWidth = Math.max(1, width - prefixWidth);
			const wrapped = wrapTextWithAnsi(entry.label, availableWidth);
			const continuation = " ".repeat(prefixWidth);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? entry.prefix : continuation}${wrapped[i]}`);
			}
		}
		return lines;
	}

	invalidate(): void {}
}

export const askToolRenderer = {
	renderCall(args: AskRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const label = formatTitle("Ask", uiTheme);
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };

		// Multi-part questions
		if (args.questions && args.questions.length > 0) {
			const container = new Container();
			container.addChild(new Text(`${label} ${uiTheme.fg("muted", `${args.questions.length} questions`)}`, 0, 0));

			for (let i = 0; i < args.questions.length; i++) {
				const q = args.questions[i];
				const isLastQ = i === args.questions.length - 1;
				const qBranch = isLastQ ? uiTheme.tree.last : uiTheme.tree.branch;
				const continuation = isLastQ ? " " : uiTheme.tree.vertical;

				const meta: string[] = [];
				if (q.multi) meta.push("multi");
				if (q.options?.length) meta.push(`options:${q.options.length}`);
				const metaStr = meta.length > 0 ? uiTheme.fg("dim", ` · ${meta.join(" · ")}`) : "";

				container.addChild(
					new Text(` ${uiTheme.fg("dim", qBranch)} ${uiTheme.fg("dim", `[${q.id}]`)}${metaStr}`, 0, 0),
				);
				const deepInterviewQuestion = renderDeepInterviewAskQuestion(q.question, uiTheme);
				container.addChild(deepInterviewQuestion ?? new Markdown(q.question, 3, 0, mdTheme, accentStyle));

				const qOptions = q.options;
				if (qOptions?.length) {
					const entries = qOptions.map((opt, j) => {
						const isLastOpt = j === qOptions.length - 1;
						const optBranch = isLastOpt ? uiTheme.tree.last : uiTheme.tree.branch;
						const shouldNumberOption = deepInterviewQuestion !== null || isDeepInterviewAskQuestion(q.question);
						const displayLabel = shouldNumberOption ? formatNumberedOptionLabel(opt.label, j) : opt.label;
						const optLabel = renderInlineMarkdown(displayLabel, mdTheme, t => uiTheme.fg("muted", t));
						return {
							prefix: ` ${uiTheme.fg("dim", continuation)}   ${uiTheme.fg("dim", optBranch)} ${uiTheme.fg("dim", uiTheme.checkbox.unchecked)} `,
							label: optLabel,
						};
					});
					container.addChild(new AskOptionList(entries));
				}
			}
			return container;
		}

		// Single question
		if (!args.question) {
			return new Text(formatErrorMessage("No question provided", uiTheme), 0, 0);
		}
		const question = args.question;

		const container = new Container();
		const meta: string[] = [];
		if (args.multi) meta.push("multi");
		if (args.options?.length) meta.push(`options:${args.options.length}`);
		container.addChild(new Text(`${label}${formatMeta(meta, uiTheme)}`, 0, 0));
		const deepInterviewQuestion = renderDeepInterviewAskQuestion(question, uiTheme);
		container.addChild(deepInterviewQuestion ?? new Markdown(question, 1, 0, mdTheme, accentStyle));

		const options = args.options;
		if (options?.length) {
			const entries = options.map((opt, i) => {
				const isLast = i === options.length - 1;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				const shouldNumberOption = deepInterviewQuestion !== null || isDeepInterviewAskQuestion(question);
				const displayLabel = shouldNumberOption ? formatNumberedOptionLabel(opt.label, i) : opt.label;
				const optLabel = renderInlineMarkdown(displayLabel, mdTheme, t => uiTheme.fg("muted", t));
				return {
					prefix: ` ${uiTheme.fg("dim", branch)} ${uiTheme.fg("dim", uiTheme.checkbox.unchecked)} `,
					label: optLabel,
				};
			});
			container.addChild(new AskOptionList(entries));
		}

		return container;
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const { details } = result;
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };

		if (!details) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			const header = renderStatusLine({ icon: "warning", title: "Ask" }, uiTheme);
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		// Multi-part results
		if (details.results && details.results.length > 0) {
			const hasAnySelection = details.results.some(
				r =>
					r.clarificationQuestion !== undefined ||
					r.customInput !== undefined ||
					(r.selectedOptions && r.selectedOptions.length > 0),
			);
			const header = renderStatusLine(
				{
					icon: hasAnySelection ? "success" : "warning",
					title: "Ask",
					meta: [`${details.results.length} questions`],
				},
				uiTheme,
			);
			const container = new Container();
			container.addChild(new Text(header, 0, 0));

			for (let i = 0; i < details.results.length; i++) {
				const r = details.results[i];
				const isLastQuestion = i === details.results.length - 1;
				const branch = isLastQuestion ? uiTheme.tree.last : uiTheme.tree.branch;
				const continuation = isLastQuestion ? "   " : `${uiTheme.fg("dim", uiTheme.tree.vertical)}  `;
				const hasSelection =
					r.clarificationQuestion !== undefined || r.customInput !== undefined || r.selectedOptions.length > 0;
				const statusIcon = hasSelection
					? uiTheme.styledSymbol("status.success", "success")
					: uiTheme.styledSymbol("status.warning", "warning");

				container.addChild(
					new Text(` ${uiTheme.fg("dim", branch)} ${statusIcon} ${uiTheme.fg("dim", `[${r.id}]`)}`, 0, 0),
				);
				container.addChild(
					renderDeepInterviewAskQuestion(r.question, uiTheme) ??
						new Markdown(r.question, 3, 0, mdTheme, accentStyle),
				);

				const answerLines: string[] = [];
				for (let j = 0; j < r.selectedOptions.length; j++) {
					const isLast =
						j === r.selectedOptions.length - 1 &&
						r.customInput === undefined &&
						r.clarificationQuestion === undefined;
					const optBranch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
					const selectedLabel = renderInlineMarkdown(r.selectedOptions[j], mdTheme, t =>
						uiTheme.fg("toolOutput", t),
					);
					answerLines.push(
						`${continuation}${uiTheme.fg("dim", optBranch)} ${uiTheme.fg("success", uiTheme.checkbox.checked)} ${selectedLabel}`,
					);
				}
				if (answerLines.length > 0) {
					container.addChild(new Text(answerLines.join("\n"), 0, 0));
				}
				if (r.customInput !== undefined) {
					container.addChild(new Text(renderCustomInput(uiTheme, continuation, r.customInput, true, false), 0, 0));
				} else if (r.clarificationQuestion !== undefined) {
					container.addChild(
						new Text(
							renderCustomInput(uiTheme, continuation, `Clarification: ${r.clarificationQuestion}`, true, false),
							0,
							0,
						),
					);
				} else if (r.selectedOptions.length === 0) {
					container.addChild(
						new Text(
							`${continuation}${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.styledSymbol("status.warning", "warning")} ${uiTheme.fg("warning", "Cancelled")}`,
							0,
							0,
						),
					);
				}
			}
			return container;
		}

		// Single question result
		if (!details.question) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			return new Text(fallback, 0, 0);
		}

		const hasSelection =
			details.clarificationQuestion !== undefined ||
			details.customInput !== undefined ||
			(details.selectedOptions && details.selectedOptions.length > 0);
		const header = renderStatusLine({ icon: hasSelection ? "success" : "warning", title: "Ask" }, uiTheme);
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		container.addChild(
			renderDeepInterviewAskQuestion(details.question, uiTheme) ??
				new Markdown(details.question, 1, 0, mdTheme, accentStyle),
		);

		const answerLines: string[] = [];
		if (details.selectedOptions && details.selectedOptions.length > 0) {
			for (let i = 0; i < details.selectedOptions.length; i++) {
				const isLast =
					i === details.selectedOptions.length - 1 &&
					details.customInput === undefined &&
					details.clarificationQuestion === undefined;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				const selectedLabel = renderInlineMarkdown(details.selectedOptions[i], mdTheme, t =>
					uiTheme.fg("toolOutput", t),
				);
				answerLines.push(
					` ${uiTheme.fg("dim", branch)} ${uiTheme.fg("success", uiTheme.checkbox.checked)} ${selectedLabel}`,
				);
			}
		}
		if (answerLines.length > 0) {
			container.addChild(new Text(answerLines.join("\n"), 0, 0));
		}
		if (details.customInput !== undefined) {
			container.addChild(new Text(renderCustomInput(uiTheme, " ", details.customInput, true, false), 0, 0));
		} else if (details.clarificationQuestion !== undefined) {
			container.addChild(
				new Text(
					renderCustomInput(uiTheme, " ", `Clarification: ${details.clarificationQuestion}`, true, false),
					0,
					0,
				),
			);
		} else if (!details.selectedOptions || details.selectedOptions.length === 0) {
			container.addChild(
				new Text(
					` ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.styledSymbol("status.warning", "warning")} ${uiTheme.fg("warning", "Cancelled")}`,
					0,
					0,
				),
			);
		}

		return container;
	},
};
