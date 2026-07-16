import type { RenderResultOptions as AgentRenderResultOptions } from "@gajae-code/agent-core";
import type { RenderResultOptions as CustomToolRenderResultOptions } from "../../src/extensibility/custom-tools/types";
import type { ToolRenderResultOptions } from "../../src/extensibility/extensions/types";

export const agentPublicOptions: AgentRenderResultOptions = { expanded: false, isPartial: false };
export const customToolPublicOptions: CustomToolRenderResultOptions = { expanded: false, isPartial: false };
export const extensionPublicOptions: ToolRenderResultOptions = { expanded: false, isPartial: false };
