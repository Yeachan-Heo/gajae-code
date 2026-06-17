import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import computerDescription from "../prompts/tools/computer.md" with { type: "text" };
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const buttonSchema = z.enum(["left", "right", "middle"]);
const shared = {
	timeout: z.number().positive().optional().describe("Maximum time in seconds for this action."),
	include_screenshot: z.boolean().optional().describe("Capture a bounded post-action screenshot when supported."),
};

const screenshotSchema = z.object({ action: z.literal("screenshot"), ...shared }).strict();
const clickSchema = z
	.object({ action: z.literal("click"), x: z.number(), y: z.number(), button: buttonSchema.optional(), ...shared })
	.strict();
const doubleClickSchema = z
	.object({
		action: z.literal("double_click"),
		x: z.number(),
		y: z.number(),
		button: buttonSchema.optional(),
		...shared,
	})
	.strict();
const moveSchema = z
	.object({ action: z.literal("move"), x: z.number(), y: z.number(), button: buttonSchema.optional(), ...shared })
	.strict();
const dragSchema = z
	.object({
		action: z.literal("drag"),
		x: z.number(),
		y: z.number(),
		to_x: z.number(),
		to_y: z.number(),
		button: buttonSchema.optional(),
		...shared,
	})
	.strict();
const scrollSchema = z
	.object({
		action: z.literal("scroll"),
		x: z.number(),
		y: z.number(),
		scroll_x: z.number(),
		scroll_y: z.number(),
		...shared,
	})
	.strict();
const typeSchema = z.object({ action: z.literal("type"), text: z.string(), ...shared }).strict();
const keypressSchema = z
	.object({ action: z.literal("keypress"), keys: z.array(z.string()).min(1), ...shared })
	.strict();
const waitSchema = z.object({ action: z.literal("wait"), ms: z.number().int().nonnegative(), ...shared }).strict();

export const computerSchema = z.discriminatedUnion("action", [
	screenshotSchema,
	clickSchema,
	doubleClickSchema,
	moveSchema,
	dragSchema,
	scrollSchema,
	typeSchema,
	keypressSchema,
	waitSchema,
]);

export type ComputerParams = z.infer<typeof computerSchema>;
export type ComputerActionName = ComputerParams["action"];

export interface ComputerScreenshotDetails {
	widthPx: number;
	heightPx: number;
	scaleX?: number;
	scaleY?: number;
	originX?: number;
	originY?: number;
	displayEpoch?: string;
	captureId?: string;
	pngBytes?: number;
}

export interface ComputerToolDetails {
	action: ComputerActionName;
	status: "success" | "disabled" | "error";
	code?: string;
	message?: string;
	x?: number;
	y?: number;
	toX?: number;
	toY?: number;
	scrollX?: number;
	scrollY?: number;
	button?: string;
	keys?: string[];
	ms?: number;
	screenshot?: ComputerScreenshotDetails;
	supervisor?: string;
	meta?: OutputMeta;
}

type NativeController = {
	screenshot?: () => Promise<NativeScreenshot> | NativeScreenshot;
	click?: (expectedEpoch: number | undefined, x: number, y: number, button?: string) => void;
	doubleClick?: (expectedEpoch: number | undefined, x: number, y: number, button?: string) => void;
	move?: (expectedEpoch: number | undefined, x: number, y: number) => void;
	drag?: (expectedEpoch: number | undefined, x: number, y: number, toX: number, toY: number, button?: string) => void;
	scroll?: (expectedEpoch: number | undefined, x: number, y: number, scrollX: number, scrollY: number) => void;
	type?: (expectedEpoch: number | undefined, text: string) => void;
	keypress?: (expectedEpoch: number | undefined, keys: string[]) => void;
	wait?: (expectedEpoch: number | undefined, ms: number) => void;
};

type NativeScreenshot = {
	png?: Uint8Array | Buffer | ArrayBuffer | string;
	widthPx?: number;
	heightPx?: number;
	scaleX?: number;
	scaleY?: number;
	originX?: number;
	originY?: number;
	displayEpoch?: string;
	captureId?: string;
};

export type ComputerControllerFactory = () => NativeController;

export const COMPUTER_DISABLED_CODE = "COMPUTER_DISABLED";

const NATIVE_ERROR_CODES = new Set([
	"COMPUTER_SUSPENDED",
	"COMPUTER_SUPERVISOR_NOT_LIVE",
	"COMPUTER_PERMISSION_REQUIRED",
	"COMPUTER_DISPLAY_STALE",
	"COMPUTER_COORD_INVALID",
	"COMPUTER_CANCELLED",
]);

function createNativeComputerController(): NativeController {
	const natives = require("@gajae-code/natives") as { ComputerController?: new () => NativeController };
	if (!natives.ComputerController) {
		throw new ToolError("ComputerController is unavailable in @gajae-code/natives.", {
			code: "COMPUTER_UNAVAILABLE",
		});
	}
	return new natives.ComputerController();
}

let controllerFactory: ComputerControllerFactory = createNativeComputerController;
let platformOverrideForTests: NodeJS.Platform | undefined;
let archOverrideForTests: NodeJS.Architecture | undefined;

export function setComputerControllerFactoryForTests(factory: ComputerControllerFactory | undefined): void {
	controllerFactory = factory ?? createNativeComputerController;
}

export function setComputerPlatformForTests(platform: NodeJS.Platform | undefined): void {
	platformOverrideForTests = platform;
}

export function setComputerArchForTests(arch: NodeJS.Architecture | undefined): void {
	archOverrideForTests = arch;
}

function currentComputerPlatform(): NodeJS.Platform {
	return platformOverrideForTests ?? process.platform;
}

function currentComputerArch(): NodeJS.Architecture {
	return archOverrideForTests ?? process.arch;
}

export function isComputerSupportedPlatform(
	platform: NodeJS.Platform = currentComputerPlatform(),
	arch: NodeJS.Architecture = currentComputerArch(),
): boolean {
	return platform === "darwin" && arch === "arm64";
}

/**
 * Whether the computer capability is loaded/advertised at all on this platform.
 * macOS is callable; Linux is listable (support planned); Windows is fully absent.
 */
export function isComputerLoadablePlatform(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

export function isComputerEnabled(session: Pick<ToolSession, "settings">): boolean {
	return Boolean(session.settings.get("computer.enabled") || session.settings.get("computer.alwaysOn"));
}

export function isComputerCallable(
	session: Pick<ToolSession, "settings">,
	platform: NodeJS.Platform = currentComputerPlatform(),
	arch: NodeJS.Architecture = currentComputerArch(),
): boolean {
	return isComputerSupportedPlatform(platform, arch) && isComputerEnabled(session);
}

export class ComputerTool implements AgentTool<typeof computerSchema, ComputerToolDetails> {
	readonly name = "computer";
	readonly label = "Computer";
	readonly loadMode = "discoverable";
	readonly summary =
		"Control the macOS desktop (Apple Silicon) with screenshot, pointer, keyboard, scroll, and wait actions; available by default on supported hosts and supervisor-gated";
	readonly parameters = computerSchema;
	readonly strict = true;
	#description?: string;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ComputerTool | null {
		return isComputerCallable(session) ? new ComputerTool(session) : null;
	}

	get description(): string {
		this.#description ??= prompt.render(computerDescription, {});
		return this.#description;
	}

	async execute(
		_toolCallId: string,
		params: ComputerParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ComputerToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		const details = detailsFromParams(params);
		if (!isComputerCallable(this.session)) {
			details.status = "disabled";
			details.code = COMPUTER_DISABLED_CODE;
			details.message =
				"The computer tool is disabled or unsupported. It requires Apple Silicon macOS; set computer.alwaysOn=false to disable, or computer.enabled=true to manually enable on a supported host.";
			return { ...toolResult(details).text(`${COMPUTER_DISABLED_CODE}: ${details.message}`).done(), isError: true };
		}

		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("computer", params.timeout);
			const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
			// Native ComputerController methods are synchronous and accept no AbortSignal,
			// so cancellation is honored before dispatch and wait() is bounded by timeoutMs.
			const result = await dispatchComputerAction(controllerFactory(), params, timeoutMs);
			const screenshot = normalizeScreenshot(result);
			if (screenshot) details.screenshot = screenshot;
			details.status = "success";
			details.message = describeComputerSuccess(details);
			return toolResult(details).text(details.message).done();
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			const mapped = mapComputerError(error);
			details.status = mapped.code === COMPUTER_DISABLED_CODE ? "disabled" : "error";
			details.code = mapped.code;
			details.message = mapped.message;
			return { ...toolResult(details).text(`${mapped.code}: ${mapped.message}`).done(), isError: true };
		}
	}
}

function dispatchComputerAction(
	controller: NativeController,
	params: ComputerParams,
	timeoutMs: number | undefined,
): Promise<unknown> | unknown {
	// expectedEpoch is undefined until lossless epoch transport lands (follow-up):
	// the native gate skips the stale-display check when the epoch is absent.
	switch (params.action) {
		case "screenshot":
			return controller.screenshot?.();
		case "click":
			return controller.click?.(undefined, params.x, params.y, params.button ?? "left");
		case "double_click":
			return controller.doubleClick?.(undefined, params.x, params.y, params.button ?? "left");
		case "move":
			return controller.move?.(undefined, params.x, params.y);
		case "drag":
			return controller.drag?.(undefined, params.x, params.y, params.to_x, params.to_y, params.button ?? "left");
		case "scroll":
			return controller.scroll?.(undefined, params.x, params.y, params.scroll_x, params.scroll_y);
		case "type":
			return controller.type?.(undefined, params.text);
		case "keypress":
			return controller.keypress?.(undefined, params.keys);
		case "wait":
			return controller.wait?.(undefined, capWaitMs(params.ms, timeoutMs));
	}
}

function detailsFromParams(params: ComputerParams): ComputerToolDetails {
	const details: ComputerToolDetails = { action: params.action, status: "success" };
	if ("x" in params) details.x = params.x;
	if ("y" in params) details.y = params.y;
	if ("to_x" in params) details.toX = params.to_x;
	if ("to_y" in params) details.toY = params.to_y;
	if ("scroll_x" in params) details.scrollX = params.scroll_x;
	if ("scroll_y" in params) details.scrollY = params.scroll_y;
	if ("button" in params) details.button = params.button;
	if ("keys" in params) details.keys = params.keys;
	if ("ms" in params) details.ms = params.ms;
	return details;
}

const MAX_COMPUTER_WAIT_MS = 60_000;

function capWaitMs(ms: number, timeoutMs: number | undefined): number {
	const ceiling = timeoutMs && timeoutMs > 0 ? timeoutMs : MAX_COMPUTER_WAIT_MS;
	return Math.min(Math.max(0, ms), ceiling);
}

function normalizeScreenshot(value: unknown): ComputerScreenshotDetails | undefined {
	const candidate =
		value && typeof value === "object" && "screenshot" in value
			? (value as { screenshot?: unknown }).screenshot
			: value;
	if (!candidate || typeof candidate !== "object") return undefined;
	const shot = candidate as NativeScreenshot;
	if (typeof shot.widthPx !== "number" || typeof shot.heightPx !== "number") return undefined;
	return {
		widthPx: shot.widthPx,
		heightPx: shot.heightPx,
		scaleX: shot.scaleX,
		scaleY: shot.scaleY,
		originX: shot.originX,
		originY: shot.originY,
		displayEpoch: shot.displayEpoch,
		captureId: shot.captureId,
		pngBytes: getPngByteLength(shot.png),
	};
}

function getPngByteLength(png: NativeScreenshot["png"]): number | undefined {
	if (png === undefined) return undefined;
	if (typeof png === "string") return Buffer.byteLength(png, "base64");
	if (png instanceof ArrayBuffer) return png.byteLength;
	return png.byteLength;
}

function mapComputerError(error: unknown): { code: string; message: string } {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return { code: "COMPUTER_CANCELLED", message: "Computer action was cancelled." };
	}
	const maybe = error as { code?: unknown; message?: unknown };
	const message =
		typeof maybe?.message === "string" && maybe.message.length > 0 ? maybe.message : "Computer action failed.";
	const rawCode = typeof maybe?.code === "string" ? maybe.code : undefined;
	const isComputerCode = (value: string | undefined): value is string =>
		value !== undefined && (NATIVE_ERROR_CODES.has(value) || value.startsWith("COMPUTER_"));
	// Native NAPI errors carry the stable code in the message ("CODE: reason") with
	// error.code set to the NAPI status, so fall back to the message prefix.
	const messageCode = /^(COMPUTER_[A-Z_]+):/.exec(message)?.[1];
	const code = isComputerCode(rawCode) ? rawCode : (messageCode ?? "COMPUTER_ERROR");
	return { code, message };
}

function describeComputerSuccess(details: ComputerToolDetails): string {
	if (details.screenshot) {
		return `Computer ${details.action} completed (${details.screenshot.widthPx}x${details.screenshot.heightPx}).`;
	}
	return `Computer ${details.action} completed.`;
}
