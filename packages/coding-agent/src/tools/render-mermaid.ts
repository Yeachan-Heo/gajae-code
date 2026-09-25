import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { type MermaidRenderOptions, prompt, renderMermaidAscii } from "@gajae-code/utils";
import * as z from "zod/v4";
import renderMermaidDescription from "../prompts/tools/render-mermaid.md" with { type: "text" };
import type { ToolSession } from "./index";

const renderMermaidSchema = z.object({
	mermaid: z.string().describe("mermaid source"),
	config: z
		.object({
			useAscii: z.boolean().optional(),
			paddingX: z.number().optional(),
			paddingY: z.number().optional(),
			boxBorderPadding: z.number().optional(),
		})
		.optional(),
});

type RenderMermaidParams = z.infer<typeof renderMermaidSchema>;

function sanitizeRenderConfig(config: MermaidRenderOptions | undefined): MermaidRenderOptions | undefined {
	if (!config) return undefined;
	return {
		useAscii: config.useAscii,
		boxBorderPadding:
			config.boxBorderPadding === undefined ? undefined : Math.max(0, Math.floor(config.boxBorderPadding)),
		paddingX: config.paddingX === undefined ? undefined : Math.max(0, Math.floor(config.paddingX)),
		paddingY: config.paddingY === undefined ? undefined : Math.max(0, Math.floor(config.paddingY)),
	};
}
export interface RenderMermaidToolDetails {
	artifactId?: string;
}

export class RenderMermaidTool implements AgentTool<typeof renderMermaidSchema, RenderMermaidToolDetails> {
	readonly name = "render_mermaid";
	readonly label = "RenderMermaid";
	readonly summary = "Render a Mermaid diagram to an image";
	readonly description: string;
	readonly parameters = renderMermaidSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(renderMermaidDescription);
	}

	async execute(
		_toolCallId: string,
		params: RenderMermaidParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RenderMermaidToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RenderMermaidToolDetails>> {
		const ascii = renderMermaidAscii(params.mermaid, sanitizeRenderConfig(params.config));
		const { path: artifactPath, id: artifactId } =
			(await this.session.allocateOutputArtifact?.("render_mermaid")) ?? {};
		if (artifactPath) {
			await Bun.write(artifactPath, ascii);
		}

		const artifactLine = artifactId ? `\n\nSaved artifact: artifact://${artifactId}` : "";
		return {
			content: [{ type: "text", text: `${ascii}${artifactLine}` }],
			details: { artifactId },
		};
	}
}
