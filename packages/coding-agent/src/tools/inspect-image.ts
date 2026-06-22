import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@gajae-code/agent-core";
import { type Api, completeSimple, type Model } from "@gajae-code/ai";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { extractTextContent } from "../commit/utils";
import { expandRoleAlias, resolveModelFromString } from "../config/model-resolver";
import inspectImageDescription from "../prompts/tools/inspect-image.md" with { type: "text" };
import inspectImageSystemPromptTemplate from "../prompts/tools/inspect-image-system.md" with { type: "text" };
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
} from "../utils/image-loading";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const inspectImageSchema = z
	.object({
		path: z.string().describe("image path"),
		question: z.string().describe("question about image"),
	})
	.strict();

export type InspectImageParams = z.infer<typeof inspectImageSchema>;

export interface InspectImageToolDetails {
	model: string;
	imagePath: string;
	mimeType: string;
}

export class InspectImageTool implements AgentTool<typeof inspectImageSchema, InspectImageToolDetails> {
	readonly name = "inspect_image";
	readonly label = "InspectImage";
	readonly loadMode = "discoverable";
	readonly summary = "Describe or analyze an image file";
	readonly description: string;
	readonly parameters = inspectImageSchema;
	readonly strict = false;

	constructor(
		private readonly session: ToolSession,
		private readonly completeImageRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(inspectImageDescription);
	}

	async execute(
		_toolCallId: string,
		params: InspectImageParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectImageToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectImageToolDetails>> {
		if (this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.",
			);
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for inspect_image.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for inspect_image.");
		}

		const matchPreferences = { usageOrder: this.session.settings.getStorage()?.getModelUsageOrder() };
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences, modelRegistry);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		const configuredVisionPattern = this.session.settings.getModelRole("vision")?.trim();
		const configuredVisionModel = configuredVisionPattern ? resolvePattern("pi/vision") : undefined;
		if (configuredVisionPattern && !configuredVisionModel) {
			throw new ToolError(
				`Configured modelRoles.vision (${configuredVisionPattern}) did not resolve to an available model. Configure modelRoles.vision with a vision-capable model.`,
			);
		}
		const model = configuredVisionModel ?? resolvePattern("pi/default") ?? resolvePattern(activeModelPattern);
		if (!model) {
			throw new ToolError(
				"Unable to resolve a model for inspect_image. Configure modelRoles.vision with a vision-capable model or select a vision-capable active/default model.",
			);
		}

		// inspect_image requires image input. A text-only selected model must be
		// paired with an explicit vision role so the model/cost boundary is visible.
		if (!model.input.includes("image")) {
			throw new ToolError(
				`Resolved model ${model.provider}/${model.id} does not support image input. Configure modelRoles.vision with a vision-capable model.`,
			);
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
			);
		}

		let imageInput: LoadedImageInput | null;
		try {
			imageInput = await loadImageInput({
				path: params.path,
				cwd: this.session.cwd,
				autoResize: this.session.settings.get("images.autoResize"),
				maxBytes: MAX_IMAGE_INPUT_BYTES,
			});
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!imageInput) {
			throw new ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.");
		}

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [prompt.render(inspectImageSystemPromptTemplate)],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
							{ type: "text", text: params.question },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, signal },
			{ telemetry, oneshotKind: "inspect_image", completeImpl: this.completeImageRequest },
		);

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "inspect_image request failed.");
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("inspect_image request aborted.");
		}

		const text = extractTextContent(response);
		if (!text) {
			throw new ToolError("inspect_image model returned no text output.");
		}

		return {
			content: [{ type: "text", text }],
			details: {
				model: `${model.provider}/${model.id}`,
				imagePath: imageInput.resolvedPath,
				mimeType: imageInput.mimeType,
			},
		};
	}
}

export { inspectImageToolRenderer } from "./inspect-image-renderer";
