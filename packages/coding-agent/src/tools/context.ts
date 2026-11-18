import type { AgentToolContext, ToolCallContext } from "@gajae-code/agent-core";
import type { Settings } from "../config/settings";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";

export type InternalToolContext = Omit<CustomToolContext, "settings"> & { settings: Settings };

declare module "@gajae-code/agent-core" {
	interface AgentToolContext extends Omit<CustomToolContext, "settings"> {
		settings?: Settings;
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
		toolCall?: ToolCallContext;
	}
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];

	constructor(private readonly getBaseContext: () => InternalToolContext) {}

	getContext(toolCall?: ToolCallContext): AgentToolContext {
		return {
			...this.getBaseContext(),
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
		};
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = uiContext;
		this.#hasUI = hasUI;
	}

	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}
}
