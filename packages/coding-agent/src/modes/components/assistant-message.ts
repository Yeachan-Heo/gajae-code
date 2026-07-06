import type { AssistantMessage, ImageContent, Usage } from "@gajae-code/ai";
import { type Component, Container, Image, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@gajae-code/tui";
import { formatNumber } from "@gajae-code/utils";
import { settings } from "../../config/settings";
import { renderDeepInterviewAssistantText } from "../../deep-interview/render-middleware";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { isSilentAbort } from "../../session/messages";
import { resolveImageOptions } from "../../tools/render-utils";

const THINKING_REPETITION_ELIDE_MIN_RUN = 24;
const THINKING_REPETITION_VISIBLE_TOKENS = 3;
const THINKING_REPETITION_TOKEN_PATTERN = /[\p{L}\p{N}_'-]{1,32}/gu;

interface ThinkingRepetitionToken {
	text: string;
	normalized: string;
	start: number;
	end: number;
}

function elideRunawayThinkingRepetition(text: string): string {
	const tokens: ThinkingRepetitionToken[] = [];
	for (const match of text.matchAll(THINKING_REPETITION_TOKEN_PATTERN)) {
		if (match.index === undefined) continue;
		tokens.push({
			text: match[0],
			normalized: match[0].toLocaleLowerCase("en-US"),
			start: match.index,
			end: match.index + match[0].length,
		});
	}

	let runStart = 0;
	for (let i = 1; i <= tokens.length; i++) {
		const current = tokens[i];
		const previous = tokens[i - 1];
		if (current && previous && current.normalized === previous.normalized) continue;

		const runLength = i - runStart;
		if (runLength >= THINKING_REPETITION_ELIDE_MIN_RUN) {
			const first = tokens[runStart];
			const last = tokens[i - 1];
			if (!first || !last) return text;

			const visibleCount = Math.min(THINKING_REPETITION_VISIBLE_TOKENS, runLength);
			const visible = Array.from({ length: visibleCount }, () => first.text).join(" ");
			const omitted = runLength - visibleCount;
			const marker = `${visible} … [thinking loop elided: "${first.text}" repeated ${omitted} more times]`;
			return `${text.slice(0, first.start)}${marker}${text.slice(last.end)}`.trim();
		}

		runStart = i;
	}

	return text;
}

interface AssistantMessageUpdateOptions {
	streaming?: boolean;
}

type AssistantChildDescriptor = {
	key: string;
	component: Component;
};

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#usageInfo?: Usage;
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#responseHeader = new Text(theme.bold(theme.fg("statusLineModel", "gajae")), 1, 0);
	#contentBlocksCache = new WeakMap<object, { source: string; component: Component }>();
	#lastStreaming = false;
	#childComponents = new Map<string, Component>();
	#contentBlockKeys = new WeakMap<object, string>();
	#nextContentBlockKey = 0;
	#reusableChildren = new WeakSet<Component>();

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
	) {
		super();

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { streaming: this.#lastStreaming });
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		for (const key of Array.from(this.#convertedKittyImages.keys())) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages.delete(key);
			}
		}
		for (const key of Array.from(this.#kittyConversionsInFlight)) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight.delete(key);
			}
		}
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
			this.#convertToolImagesForKitty(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { streaming: this.#lastStreaming });
		}
	}

	#convertToolImagesForKitty(toolCallId: string, images: ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (let index = 0; index < images.length; index++) {
			const image = images[index];
			if (!image || image.mimeType === "image/png") continue;
			const key = `${toolCallId}:${index}`;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			new Bun.Image(Buffer.from(image.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, {
						type: "image",
						data,
						mimeType: "image/png",
					});
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage, { streaming: this.#lastStreaming });
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
				});
		}
	}

	setUsageInfo(usage: Usage): void {
		this.#usageInfo = usage;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { streaming: this.#lastStreaming });
		}
	}

	#contentBlockKey(content: object): string {
		let key = this.#contentBlockKeys.get(content);
		if (!key) {
			key = `block:${this.#nextContentBlockKey++}`;
			this.#contentBlockKeys.set(content, key);
		}
		return key;
	}

	#cachedChild<T extends Component>(key: string, create: () => T): T {
		const cached = this.#childComponents.get(key);
		if (cached) return cached as T;
		const component = create();
		this.#childComponents.set(key, component);
		this.#reusableChildren.add(component);
		return component;
	}

	#renderTextBlock(content: { text: string }, streaming: boolean): Component {
		const cached = this.#contentBlocksCache.get(content);
		if (cached?.source === content.text) {
			if (cached.component instanceof Markdown) {
				cached.component.setOnStaleThrottle(this.onImageUpdate);
				cached.component.setStreaming(streaming);
			}
			return cached.component;
		}
		const trimmed = content.text.trim();
		const deepInterview = renderDeepInterviewAssistantText(trimmed, theme);
		// Reuse the same Markdown instance across streaming chunks (update text in place)
		// instead of constructing a new one each chunk; combined with the markdown
		// per-code-block highlight cache, appends no longer re-highlight the whole prefix.
		if (!deepInterview && cached && cached.component instanceof Markdown) {
			cached.component.setOnStaleThrottle(this.onImageUpdate);
			cached.component.setText(trimmed, { streaming });
			cached.source = content.text;
			return cached.component;
		}
		const component = deepInterview ?? new Markdown(trimmed, 1, 0, getMarkdownTheme());
		if (component instanceof Markdown) {
			component.setOnStaleThrottle(this.onImageUpdate);
			component.setStreaming(streaming);
		}
		this.#contentBlocksCache.set(content, { source: content.text, component });
		this.#reusableChildren.add(component);
		return component;
	}

	#renderThinkingBlock(content: { thinking: string }, streaming: boolean): Markdown {
		const cached = this.#contentBlocksCache.get(content);
		if (cached?.source === content.thinking) {
			if (cached.component instanceof Markdown) {
				cached.component.setOnStaleThrottle(this.onImageUpdate);
				cached.component.setStreaming(streaming);
			}
			return cached.component as Markdown;
		}
		const trimmed = elideRunawayThinkingRepetition(content.thinking.trim());
		if (cached?.component instanceof Markdown) {
			cached.component.setOnStaleThrottle(this.onImageUpdate);
			cached.component.setText(trimmed, { streaming });
			cached.source = content.thinking;
			return cached.component;
		}
		const component = new Markdown(trimmed, 1, 0, getMarkdownTheme(), {
			color: (text: string) => theme.fg("thinkingText", text),
			italic: true,
		});
		component.setOnStaleThrottle(this.onImageUpdate);
		component.setStreaming(streaming);
		this.#contentBlocksCache.set(content, { source: content.thinking, component });
		this.#reusableChildren.add(component);
		return component;
	}

	#toolImageDescriptors(): AssistantChildDescriptor[] {
		const imageEntries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		if (imageEntries.length === 0) return [];

		const descriptors: AssistantChildDescriptor[] = [
			{ key: "tool-images:spacer", component: this.#cachedChild("tool-images:spacer", () => new Spacer(1)) },
		];
		for (const { image, key } of imageEntries) {
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#convertedKittyImages.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				const imageKey = `tool-image:${key}:${displayImage.mimeType}:${displayImage.data}`;
				descriptors.push({
					key: imageKey,
					component: this.#cachedChild(
						imageKey,
						() =>
							new Image(
								displayImage.data,
								displayImage.mimeType,
								{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
								resolveImageOptions(),
							),
					),
				});
				continue;
			}
			const fallbackKey = `tool-image-fallback:${key}:${image.mimeType}`;
			descriptors.push({
				key: fallbackKey,
				component: this.#cachedChild(
					fallbackKey,
					() => new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0),
				),
			});
		}
		return descriptors;
	}

	#reconcileChildren(descriptors: AssistantChildDescriptor[]): void {
		const nextChildren = descriptors.map(descriptor => descriptor.component);
		if (
			nextChildren.length === this.#contentContainer.children.length &&
			nextChildren.every((child, index) => child === this.#contentContainer.children[index])
		) {
			return;
		}

		const nextSet = new Set(nextChildren);
		for (const child of this.#contentContainer.children) {
			if (!nextSet.has(child) && !this.#reusableChildren.has(child)) {
				child.dispose?.();
			}
		}
		this.#contentContainer.children = nextChildren;
	}

	updateContent(message: AssistantMessage, options?: AssistantMessageUpdateOptions): void {
		this.#lastMessage = message;
		this.#lastStreaming = options?.streaming ?? false;

		const visibleContentAfter = new Array<boolean>(message.content.length).fill(false);
		let hasVisibleContentAfter = false;
		let hasVisibleContent = false;
		let activeContentIndex = -1;
		for (let i = message.content.length - 1; i >= 0; i--) {
			visibleContentAfter[i] = hasVisibleContentAfter;
			const content = message.content[i];
			const isVisible =
				(content.type === "text" && Boolean(content.text.trim())) ||
				(content.type === "thinking" && Boolean(content.thinking.trim()));
			if (isVisible) {
				hasVisibleContent = true;
				hasVisibleContentAfter = true;
				if (this.#lastStreaming && activeContentIndex === -1) {
					activeContentIndex = i;
				}
			}
		}

		const streaming = this.#lastStreaming;
		const descriptors: AssistantChildDescriptor[] = [];
		if (hasVisibleContent) {
			descriptors.push({
				key: "response-header:spacer",
				component: this.#cachedChild("response-header:spacer", () => new Spacer(1)),
			});
			descriptors.push({ key: "response-header", component: this.#responseHeader });
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			const blockKey = this.#contentBlockKey(content);
			if (content.type === "text" && content.text.trim()) {
				descriptors.push({
					key: `${blockKey}:text`,
					component: this.#renderTextBlock(content, streaming && i === activeContentIndex),
				});
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					descriptors.push({
						key: `${blockKey}:thinking-hidden`,
						component: this.#cachedChild(
							`${blockKey}:thinking-hidden`,
							() => new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0),
						),
					});
				} else {
					descriptors.push({
						key: `${blockKey}:thinking`,
						component: this.#renderThinkingBlock(content, streaming && i === activeContentIndex),
					});
				}
				if (visibleContentAfter[i]) {
					descriptors.push({
						key: `${blockKey}:thinking-spacer`,
						component: this.#cachedChild(`${blockKey}:thinking-spacer`, () => new Spacer(1)),
					});
				}
			}
		}

		descriptors.push(...this.#toolImageDescriptors());

		const isTerminal = !streaming || Boolean(message.stopReason);
		if (isTerminal) {
			// Check if aborted - show after partial content
			// But only if there are no tool calls (tool execution components will show the error)
			const hasToolCalls = message.content.some(c => c.type === "toolCall");
			if (!hasToolCalls) {
				if (message.stopReason === "aborted" && !isSilentAbort(message.errorMessage)) {
					const abortMessage =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Operation aborted";
					descriptors.push({
						key: "abort:spacer",
						component: this.#cachedChild("abort:spacer", () => new Spacer(1)),
					});
					descriptors.push({
						key: `abort:text:${abortMessage}`,
						component: this.#cachedChild(
							`abort:text:${abortMessage}`,
							() => new Text(theme.fg("error", abortMessage), 1, 0),
						),
					});
				} else if (message.stopReason === "error") {
					const errorMsg = message.errorMessage || "Unknown error";
					descriptors.push({
						key: "error:spacer",
						component: this.#cachedChild("error:spacer", () => new Spacer(1)),
					});
					descriptors.push({
						key: `error:text:${errorMsg}`,
						component: this.#cachedChild(
							`error:text:${errorMsg}`,
							() => new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0),
						),
					});
				}
			}
			if (
				message.errorMessage &&
				!isSilentAbort(message.errorMessage) &&
				message.stopReason !== "aborted" &&
				message.stopReason !== "error"
			) {
				descriptors.push({
					key: "message-error:spacer",
					component: this.#cachedChild("message-error:spacer", () => new Spacer(1)),
				});
				descriptors.push({
					key: `message-error:text:${message.errorMessage}`,
					component: this.#cachedChild(
						`message-error:text:${message.errorMessage}`,
						() => new Text(theme.fg("error", `Error: ${message.errorMessage}`), 1, 0),
					),
				});
			}

			// Token usage metadata
			if (settings.get("display.showTokenUsage") && this.#usageInfo) {
				const usage = this.#usageInfo;
				const totalInput = usage.input + usage.cacheWrite;
				const parts: string[] = [];
				parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
				parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
				if (usage.cacheRead > 0) {
					parts.push(`cache: ${formatNumber(usage.cacheRead)}`);
				}
				const usageText = parts.join("  ");
				descriptors.push({
					key: "usage:spacer",
					component: this.#cachedChild("usage:spacer", () => new Spacer(1)),
				});
				descriptors.push({
					key: `usage:text:${usageText}`,
					component: this.#cachedChild(
						`usage:text:${usageText}`,
						() => new Text(theme.fg("dim", usageText), 1, 0),
					),
				});
			}
		}

		this.#reconcileChildren(descriptors);
	}
}
