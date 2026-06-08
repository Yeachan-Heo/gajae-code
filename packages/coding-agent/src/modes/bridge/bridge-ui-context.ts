import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
} from "../../extensibility/extensions";
import type { UiRequestBroker, UiRequestCancelled, UiRequestResolution } from "../shared/agent-wire/ui-request-broker";
import type { BridgeUiResult } from "../shared/agent-wire/ui-result";
import { isUiUnsupported, isUiValue } from "../shared/agent-wire/ui-result";
import { type Theme, theme } from "../theme/theme";

export type BridgeUiRequestPayload =
	| { kind: "select"; title: string; options: string[]; timeout?: number }
	| { kind: "confirm"; title: string; message: string; timeout?: number }
	| { kind: "input"; title: string; placeholder?: string; timeout?: number }
	| { kind: "editor"; title: string; prefill?: string; promptStyle?: boolean }
	| { kind: "notify"; message: string; type?: "info" | "warning" | "error" }
	| { kind: "status"; key: string; text: string | undefined }
	| { kind: "widget"; key: string; lines: string[] | undefined; placement?: "aboveEditor" | "belowEditor" }
	| { kind: "title"; title: string }
	| { kind: "set_editor_text"; text: string }
	| { kind: "unsupported"; capability: string; reason: string };

export type BridgeUiBroker = UiRequestBroker<BridgeUiRequestPayload, BridgeUiResult<unknown>>;
export type BridgeUiEmitter = (payload: BridgeUiRequestPayload) => void;

function isBrokerCancelled(resolution: UiRequestResolution<BridgeUiResult<unknown>>): resolution is UiRequestCancelled {
	return resolution.status === "cancelled";
}

function timeoutFor(dialogOptions: ExtensionUIDialogOptions | undefined): number | undefined {
	return dialogOptions?.timeout;
}

export class BridgeExtensionUIContext implements ExtensionUIContext {
	readonly #broker: BridgeUiBroker;
	readonly #emit: BridgeUiEmitter;

	constructor(options: { broker: BridgeUiBroker; emit: BridgeUiEmitter }) {
		this.#broker = options.broker;
		this.#emit = options.emit;
	}

	#emitUnsupported(capability: string, reason: string): void {
		this.#emit({ kind: "unsupported", capability, reason });
	}

	async select(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const result = await this.#broker.request(
			{ kind: "select", title, options, timeout: timeoutFor(dialogOptions) },
			{ timeoutMs: timeoutFor(dialogOptions), signal: dialogOptions?.signal },
		);
		if (isBrokerCancelled(result)) {
			if (result.reason === "timeout") dialogOptions?.onTimeout?.();
			return undefined;
		}
		if (isUiValue(result) && typeof result.value === "string") return result.value;
		return undefined;
	}

	async confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		const result = await this.#broker.request(
			{ kind: "confirm", title, message, timeout: timeoutFor(dialogOptions) },
			{ timeoutMs: timeoutFor(dialogOptions), signal: dialogOptions?.signal },
		);
		if (isBrokerCancelled(result)) {
			if (result.reason === "timeout") dialogOptions?.onTimeout?.();
			return false;
		}
		if (isUiValue(result) && typeof result.value === "boolean") return result.value;
		return false;
	}

	async input(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const result = await this.#broker.request(
			{ kind: "input", title, placeholder, timeout: timeoutFor(dialogOptions) },
			{ timeoutMs: timeoutFor(dialogOptions), signal: dialogOptions?.signal },
		);
		if (isBrokerCancelled(result)) {
			if (result.reason === "timeout") dialogOptions?.onTimeout?.();
			return undefined;
		}
		if (isUiValue(result) && typeof result.value === "string") return result.value;
		return undefined;
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.#emit({ kind: "notify", message, type });
	}

	onTerminalInput(_handler: TerminalInputHandler): () => void {
		this.#emitUnsupported("ui.terminal_input", "Raw terminal input is not supported by the bridge protocol yet");
		return () => {};
	}

	setStatus(key: string, text: string | undefined): void {
		this.#emit({ kind: "status", key, text });
	}

	setWorkingMessage(message?: string): void {
		this.#emit({ kind: "status", key: "working", text: message });
	}

	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		if (content === undefined || Array.isArray(content)) {
			this.#emit({ kind: "widget", key, lines: content, placement: options?.placement });
			return;
		}
		this.#emitUnsupported("ui.widget.component", "Component factory widgets are local-only and not serializable");
	}

	setFooter(_factory?: unknown): void {
		this.#emitUnsupported("ui.footer.component", "Footer component factories are local-only and not serializable");
	}

	setHeader(_factory?: unknown): void {
		this.#emitUnsupported("ui.header.component", "Header component factories are local-only and not serializable");
	}

	setTitle(title: string): void {
		this.#emit({ kind: "title", title });
	}

	async custom<T>(): Promise<T> {
		this.#emitUnsupported("ui.custom.component", "Custom focused components are local-only and not serializable");
		throw new Error("Custom focused components are local-only and not serializable through bridge UI context");
	}

	setEditorText(text: string): void {
		this.#emit({ kind: "set_editor_text", text });
	}

	pasteToEditor(text: string): void {
		this.setEditorText(text);
	}

	getEditorText(): string {
		this.#emitUnsupported(
			"ui.editor.get_text",
			"Synchronous editor reads are local-only and not supported by bridge UI context",
		);
		throw new Error("Synchronous editor reads are local-only and not supported by bridge UI context");
	}

	async editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		const result = await this.#broker.request(
			{ kind: "editor", title, prefill, promptStyle: editorOptions?.promptStyle },
			{ timeoutMs: timeoutFor(dialogOptions), signal: dialogOptions?.signal },
		);
		if (isBrokerCancelled(result)) {
			if (result.reason === "timeout") dialogOptions?.onTimeout?.();
			return undefined;
		}
		if (isUiUnsupported(result)) return undefined;
		if (isUiValue(result) && typeof result.value === "string") return result.value;
		return undefined;
	}

	setEditorComponent(_factory?: unknown): void {
		this.#emitUnsupported("ui.editor.component", "Custom editor components are local-only and not serializable");
	}

	get theme(): Theme {
		return theme;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<Theme | undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		return Promise.resolve({ success: false, error: "Theme switching is not supported by bridge UI context yet" });
	}

	getToolsExpanded(): boolean {
		return false;
	}

	setToolsExpanded(_expanded: boolean): void {
		this.#emitUnsupported("ui.tools_expanded", "Tool expansion state is not supported by bridge UI context yet");
	}
}
