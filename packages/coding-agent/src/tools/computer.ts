import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { ImageContent } from "@gajae-code/ai";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import computerDescription from "../prompts/tools/computer.md" with { type: "text" };
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import { markScreenshotFallbackDirCreatedForGc } from "./computer-gc";
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

const singleActionSchemas = [
	screenshotSchema,
	clickSchema,
	doubleClickSchema,
	moveSchema,
	dragSchema,
	scrollSchema,
	typeSchema,
	keypressSchema,
	waitSchema,
] as const;

export const singleComputerSchema = z.discriminatedUnion("action", singleActionSchemas);

const batchSchema = z
	.object({
		action: z.literal("batch"),
		actions: z.array(singleComputerSchema).min(1).describe("Sequence of computer actions to execute in order."),
		...shared,
	})
	.strict();

export const computerSchema = z.union([singleComputerSchema, batchSchema]);

export type SingleComputerParams = z.infer<typeof singleComputerSchema>;
export type ComputerParams = z.infer<typeof computerSchema>;
export type ComputerActionName = ComputerParams["action"];

export interface ComputerScreenshotDetails {
	widthPx: number;
	heightPx: number;
	scaleX?: number;
	scaleY?: number;
	originX?: number;
	originY?: number;
	displayEpoch?: number;
	captureId?: string;
	pngBytes?: number;
	path?: string;
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
	steps?: ComputerToolDetails[];
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
	displayEpoch?: number;
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
const screenshotFallbackDirs = new WeakMap<ToolSession, Promise<string>>();
const latestScreenshotContexts = new WeakMap<ToolSession, ScreenshotContext>();

const COMPUTER_INLINE_SCREENSHOT_MAX_WIDTH = 1568;
const COMPUTER_INLINE_SCREENSHOT_MAX_HEIGHT = 1568;
const COMPUTER_INLINE_SCREENSHOT_PROVIDER_MAX_BYTES = 5 * 1024 * 1024;
const COMPUTER_INLINE_SCREENSHOT_JPEG_QUALITY = 70;

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
	if (session.settings.get("computer.enabled")) return true;
	if (session.settings.has("computer.enabled")) return false;
	if (session.settings.has("computer.alwaysOn")) return Boolean(session.settings.get("computer.alwaysOn"));
	return true;
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
		const hotkey = this.session.settings.get("computer.killSwitchHotkey") as string | undefined;
		if (!isComputerCallable(this.session)) {
			details.status = "disabled";
			details.code = COMPUTER_DISABLED_CODE;
			details.message =
				"The computer tool is disabled or unsupported. It requires Apple Silicon macOS; set computer.alwaysOn=false to disable, or computer.enabled=true to manually enable on a supported host.";
			await writeComputerAuditLog(this.session, details);
			return { ...toolResult(details).text(`${COMPUTER_DISABLED_CODE}: ${details.message}`).done(), isError: true };
		}

		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("computer", params.timeout);
			const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
			const controller = controllerFactory();
			const deadline = createComputerDeadline(timeoutMs);
			if (params.action === "batch") {
				const batchResult = await dispatchBatchComputerActions(
					controller,
					params.actions,
					timeoutMs,
					hotkey,
					latestScreenshotContexts.get(this.session),
					shouldCapturePostActionScreenshot(params, this.session),
					Boolean(this.session.settings.get("computer.autoScreenshot")),
					signal,
					deadline,
				);
				details.steps = batchResult.steps;
				if (batchResult.screenshot) {
					details.screenshot = batchResult.screenshot;
					rememberLatestScreenshot(this.session, batchResult.screenshot);
				}
				details.status = batchResult.failedStep ? "error" : "success";
				if (batchResult.failedStep) {
					details.code = batchResult.failedStep.code;
					details.message = batchResult.failedStep.message;
					if (batchResult.screenshotSource !== undefined) {
						await persistScreenshotFallback(batchResult.screenshotSource, details.screenshot, this.session);
					}
					await writeComputerAuditLog(this.session, details);
					return {
						...toolResult(details).text(`${details.code}: ${details.message}`).done(),
						isError: true,
					};
				}
				details.message = describeComputerSuccess(details);
				if (batchResult.screenshotSource !== undefined) {
					await persistScreenshotFallback(batchResult.screenshotSource, details.screenshot, this.session);
					details.message = describeComputerSuccess(details);
				}
				const image = await inlineImageContentFromNativeResult(batchResult.screenshotSource, details, this.session);
				await writeComputerAuditLog(this.session, details);
				return image
					? toolResult(details)
							.content([{ type: "text", text: details.message }, image])
							.done()
					: toolResult(details).text(details.message).done();
			}
			let result = await dispatchComputerAction(
				controller,
				params,
				deadline,
				latestScreenshotContexts.get(this.session),
				signal,
			);
			if (shouldCapturePostActionScreenshot(params, this.session)) {
				result = await captureScreenshot(controller, deadline, signal);
			}
			const screenshot = normalizeScreenshot(result);
			if (screenshot) {
				details.screenshot = screenshot;
				rememberLatestScreenshot(this.session, screenshot);
			}
			details.status = "success";
			details.message = describeComputerSuccess(details);
			if (screenshot) {
				await persistScreenshotFallback(result, details.screenshot, this.session);
				details.message = describeComputerSuccess(details);
			}
			const image = await inlineImageContentFromNativeResult(result, details, this.session);
			await writeComputerAuditLog(this.session, details);
			return image
				? toolResult(details)
						.content([{ type: "text", text: details.message }, image])
						.done()
				: toolResult(details).text(details.message).done();
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			const mapped = mapComputerError(error, hotkey);
			details.status = mapped.code === COMPUTER_DISABLED_CODE ? "disabled" : "error";
			details.code = mapped.code;
			details.message = mapped.message;
			await writeComputerAuditLog(this.session, details);
			return { ...toolResult(details).text(`${mapped.code}: ${mapped.message}`).done(), isError: true };
		}
	}
}

interface CoordinateBounds {
	widthPx: number;
	heightPx: number;
	originX?: number;
	originY?: number;
}

interface ScreenshotContext extends CoordinateBounds {
	displayEpoch?: number;
}

function validatePointerCoordinates(action: string, x: number, y: number, bounds: CoordinateBounds | undefined): void {
	if (!bounds) return;
	const minX = bounds.originX ?? 0;
	const minY = bounds.originY ?? 0;
	const maxX = minX + bounds.widthPx;
	const maxY = minY + bounds.heightPx;
	if (x < minX || x >= maxX || y < minY || y >= maxY) {
		throw new Error(
			`COMPUTER_COORD_INVALID: ${action} coordinates (${x},${y}) are outside the latest screenshot bounds [${minX},${minY})..[${maxX},${maxY}). Capture a fresh screenshot and use coordinates within its frame.`,
		);
	}
}

function expectedEpochFromContext(context: ScreenshotContext | undefined): number | undefined {
	return typeof context?.displayEpoch === "number" &&
		Number.isFinite(context.displayEpoch) &&
		context.displayEpoch >= 0
		? context.displayEpoch
		: undefined;
}

function rememberLatestScreenshot(session: ToolSession, screenshot: ComputerScreenshotDetails): void {
	latestScreenshotContexts.set(session, {
		widthPx: screenshot.widthPx,
		heightPx: screenshot.heightPx,
		originX: screenshot.originX,
		originY: screenshot.originY,
		displayEpoch: screenshot.displayEpoch,
	});
}

function captureScreenshot(
	controller: NativeController,
	deadline: ComputerDeadline | undefined,
	signal?: AbortSignal,
): Promise<unknown> {
	return runComputerOperation(
		() => {
			if (!controller.screenshot) missingNativeMethod("screenshot", "screenshot");
			return controller.screenshot();
		},
		deadline,
		signal,
	);
}

function missingNativeMethod(action: string, method: string): never {
	throw new ToolError(`COMPUTER_UNAVAILABLE: Native ComputerController.${method} is unavailable for ${action}.`, {
		code: "COMPUTER_UNAVAILABLE",
	});
}

function shouldCapturePostActionScreenshot(
	params: Pick<ComputerParams, "action" | "include_screenshot">,
	session: Pick<ToolSession, "settings">,
): boolean {
	return (
		params.action !== "screenshot" &&
		(params.include_screenshot === true || Boolean(session.settings.get("computer.autoScreenshot")))
	);
}

interface ComputerDeadline {
	expiresAtMs: number;
}

class ComputerTimeoutError extends Error {
	constructor() {
		super("Computer action timed out.");
		this.name = "TimeoutError";
	}
}

function createComputerDeadline(
	timeoutMs: number | undefined,
	parent?: ComputerDeadline,
): ComputerDeadline | undefined {
	const localExpiresAt = timeoutMs && timeoutMs > 0 ? performance.now() + timeoutMs : undefined;
	const parentExpiresAt = parent?.expiresAtMs;
	const expiresAtMs =
		localExpiresAt === undefined
			? parentExpiresAt
			: parentExpiresAt === undefined
				? localExpiresAt
				: Math.min(localExpiresAt, parentExpiresAt);
	return expiresAtMs === undefined ? undefined : { expiresAtMs };
}

function remainingComputerTimeoutMs(deadline: ComputerDeadline | undefined): number | undefined {
	if (!deadline) return undefined;
	const remaining = Math.ceil(deadline.expiresAtMs - performance.now());
	if (remaining <= 0) throw new ComputerTimeoutError();
	return remaining;
}

function assertComputerDeadline(deadline: ComputerDeadline | undefined): void {
	remainingComputerTimeoutMs(deadline);
}

async function runComputerOperation<T>(
	operation: () => Promise<T> | T,
	deadline: ComputerDeadline | undefined,
	signal?: AbortSignal,
): Promise<T> {
	throwIfAborted(signal);
	const timeoutMs = remainingComputerTimeoutMs(deadline);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;
	const operationPromise = Promise.resolve().then(operation);
	operationPromise.catch(() => undefined);
	const guards: Array<Promise<never>> = [];
	if (timeoutMs !== undefined) {
		guards.push(
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new ComputerTimeoutError()), timeoutMs);
			}),
		);
	}
	if (signal) {
		guards.push(
			new Promise((_, reject) => {
				const onAbort = () => reject(new ToolAbortError());
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}),
		);
	}
	try {
		const result = await (guards.length > 0 ? Promise.race([operationPromise, ...guards]) : operationPromise);
		throwIfAborted(signal);
		assertComputerDeadline(deadline);
		return result;
	} finally {
		if (timeout) clearTimeout(timeout);
		removeAbortListener?.();
	}
}

function dispatchComputerAction(
	controller: NativeController,
	params: SingleComputerParams,
	deadline: ComputerDeadline | undefined,
	context?: ScreenshotContext,
	signal?: AbortSignal,
): Promise<unknown> {
	const expectedEpoch = expectedEpochFromContext(context);
	return runComputerOperation(
		() => {
			switch (params.action) {
				case "screenshot":
					if (!controller.screenshot) missingNativeMethod("screenshot", "screenshot");
					return controller.screenshot();
				case "click":
					validatePointerCoordinates("click", params.x, params.y, context);
					if (!controller.click) missingNativeMethod("click", "click");
					return controller.click(expectedEpoch, params.x, params.y, params.button ?? "left");
				case "double_click":
					validatePointerCoordinates("double_click", params.x, params.y, context);
					if (!controller.doubleClick) missingNativeMethod("double_click", "doubleClick");
					return controller.doubleClick(expectedEpoch, params.x, params.y, params.button ?? "left");
				case "move":
					validatePointerCoordinates("move", params.x, params.y, context);
					if (!controller.move) missingNativeMethod("move", "move");
					return controller.move(expectedEpoch, params.x, params.y);
				case "drag":
					validatePointerCoordinates("drag start", params.x, params.y, context);
					validatePointerCoordinates("drag end", params.to_x, params.to_y, context);
					if (!controller.drag) missingNativeMethod("drag", "drag");
					return controller.drag(
						expectedEpoch,
						params.x,
						params.y,
						params.to_x,
						params.to_y,
						params.button ?? "left",
					);
				case "scroll":
					validatePointerCoordinates("scroll", params.x, params.y, context);
					if (!controller.scroll) missingNativeMethod("scroll", "scroll");
					return controller.scroll(expectedEpoch, params.x, params.y, params.scroll_x, params.scroll_y);
				case "type":
					if (!controller.type) missingNativeMethod("type", "type");
					return controller.type(undefined, params.text);
				case "keypress":
					if (!controller.keypress) missingNativeMethod("keypress", "keypress");
					return controller.keypress(undefined, params.keys);
				case "wait":
					if (!controller.wait) missingNativeMethod("wait", "wait");
					return controller.wait(undefined, capWaitMs(params.ms, remainingComputerTimeoutMs(deadline)));
			}
		},
		deadline,
		signal,
	);
}

interface BatchDispatchResult {
	steps: ComputerToolDetails[];
	screenshot?: ComputerScreenshotDetails;
	screenshotSource?: unknown;
	failedStep?: { code: string; message: string };
}

async function dispatchBatchComputerActions(
	controller: NativeController,
	actions: readonly SingleComputerParams[],
	timeoutMs: number | undefined,
	hotkey?: string,
	initialContext?: ScreenshotContext,
	includeBatchScreenshot = false,
	autoScreenshot = false,
	signal?: AbortSignal,
	deadline?: ComputerDeadline,
): Promise<BatchDispatchResult> {
	const steps: ComputerToolDetails[] = [];
	let lastScreenshot: ComputerScreenshotDetails | undefined;
	let lastScreenshotSource: unknown;
	let context = initialContext;
	for (const single of actions) {
		const stepDetails = detailsFromParams(single);
		try {
			throwIfAborted(signal);
			assertComputerDeadline(deadline);
			const stepTimeoutMs = stepTimeoutFromParams(single, timeoutMs);
			const stepDeadline = createComputerDeadline(stepTimeoutMs, deadline);
			let result = await dispatchComputerAction(controller, single, stepDeadline, context, signal);
			if (single.action !== "screenshot" && (single.include_screenshot === true || autoScreenshot)) {
				result = await captureScreenshot(controller, stepDeadline, signal);
			}

			const screenshot = normalizeScreenshot(result);
			if (screenshot) {
				stepDetails.screenshot = screenshot;
				lastScreenshot = screenshot;
				lastScreenshotSource = result;
				context = screenshot;
			}
			stepDetails.status = "success";
			stepDetails.message = describeComputerSuccess(stepDetails);
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			const mapped = mapComputerError(error, hotkey);
			stepDetails.status = mapped.code === COMPUTER_DISABLED_CODE ? "disabled" : "error";
			stepDetails.code = mapped.code;
			stepDetails.message = mapped.message;
			steps.push(stepDetails);
			return {
				steps,
				screenshot: lastScreenshot,
				screenshotSource: lastScreenshotSource,
				failedStep: { code: mapped.code, message: mapped.message },
			};
		}
		steps.push(stepDetails);
	}
	if (includeBatchScreenshot) {
		lastScreenshotSource = await captureScreenshot(controller, deadline, signal);
		lastScreenshot = normalizeScreenshot(lastScreenshotSource) ?? lastScreenshot;
	}
	return { steps, screenshot: lastScreenshot, screenshotSource: lastScreenshotSource };
}

function stepTimeoutFromParams(params: SingleComputerParams, batchTimeoutMs: number | undefined): number | undefined {
	if (params.timeout === undefined) return batchTimeoutMs;
	const timeoutSeconds = clampTimeout("computer", params.timeout);
	return timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
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
		displayEpoch: normalizeDisplayEpoch(shot.displayEpoch),
		captureId: shot.captureId,
		pngBytes: getPngByteLength(shot.png),
	};
}

function normalizeDisplayEpoch(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function fullResolutionImageContentFromNativeResult(value: unknown): ImageContent | undefined {
	const candidate =
		value && typeof value === "object" && "screenshot" in value
			? (value as { screenshot?: unknown }).screenshot
			: value;
	if (!candidate || typeof candidate !== "object") return undefined;
	const png = (candidate as NativeScreenshot).png;
	const data = pngToBase64(png);
	return data ? { type: "image", data, mimeType: "image/png" } : undefined;
}

async function inlineImageContentFromNativeResult(
	value: unknown,
	details: ComputerToolDetails,
	session: ToolSession,
): Promise<ImageContent | undefined> {
	// Anthropic rejects requests carrying more than 20 images when any image
	// exceeds 2000px per dimension ("many-image requests"), so gating on bytes
	// alone is not enough: an in-budget full-resolution capture can still brick
	// the session once enough screenshots accumulate in history. Always route
	// through resizeImage (its fast path returns already-small images
	// untouched) and tell the model how to map coordinates back to the native
	// screenshot frame when the inline image was scaled.
	const image = fullResolutionImageContentFromNativeResult(value);
	if (!image) return undefined;
	const maxBytes = getInlineScreenshotMaxBytes(session);

	try {
		const resized = await resizeImage(image, {
			maxWidth: COMPUTER_INLINE_SCREENSHOT_MAX_WIDTH,
			maxHeight: COMPUTER_INLINE_SCREENSHOT_MAX_HEIGHT,
			maxBytes,
			jpegQuality: COMPUTER_INLINE_SCREENSHOT_JPEG_QUALITY,
		});
		if (resized.buffer.length <= maxBytes) {
			const note = formatDimensionNote(resized);
			if (note) details.message = `${details.message} ${note}`;
			return { type: "image", data: resized.data, mimeType: resized.mimeType };
		}
	} catch {
		// Keep the action successful and rely on the full-resolution artifact path below.
	}

	details.message = `${details.message} Inline screenshot omitted because it could not be bounded below ${formatByteCount(maxBytes)}; use the saved screenshot artifact instead.`;
	return undefined;
}

async function persistScreenshotFallback(
	value: unknown,
	screenshot: ComputerScreenshotDetails | undefined,
	session: ToolSession,
): Promise<void> {
	if (!screenshot || screenshot.path) return;
	const image = fullResolutionImageContentFromNativeResult(value);
	if (!image) return;
	const dir = await getScreenshotFallbackDir(session);
	const filePath = path.join(dir, `computer-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
	await fs.writeFile(filePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
	screenshot.path = filePath;
}

function getScreenshotFallbackDir(session: ToolSession): Promise<string> {
	let dir = screenshotFallbackDirs.get(session);
	if (!dir) {
		dir = createScreenshotFallbackDir();
		screenshotFallbackDirs.set(session, dir);
	}
	return dir;
}

async function createScreenshotFallbackDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-computer-screenshots-"));
	await fs.chmod(dir, 0o700);
	markScreenshotFallbackDirCreatedForGc();
	return dir;
}

function pngToBase64(png: NativeScreenshot["png"]): string | undefined {
	if (png === undefined) return undefined;
	if (typeof png === "string") return png;
	if (png instanceof ArrayBuffer) return Buffer.from(png).toString("base64");
	return Buffer.from(png).toString("base64");
}

function getPngByteLength(png: NativeScreenshot["png"]): number | undefined {
	if (png === undefined) return undefined;
	if (typeof png === "string") return Buffer.byteLength(png, "base64");
	if (png instanceof ArrayBuffer) return png.byteLength;
	return png.byteLength;
}

function getInlineScreenshotMaxBytes(session: Pick<ToolSession, "settings">): number {
	const configured = Number(session.settings.get("computer.screenshotMaxBytes"));
	const finiteConfigured =
		Number.isFinite(configured) && configured > 0
			? Math.floor(configured)
			: COMPUTER_INLINE_SCREENSHOT_PROVIDER_MAX_BYTES;
	return Math.min(finiteConfigured, COMPUTER_INLINE_SCREENSHOT_PROVIDER_MAX_BYTES);
}

function formatByteCount(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${Math.round(kib)} KiB`;
	return `${(kib / 1024).toFixed(1)} MiB`;
}

function mapComputerError(error: unknown, hotkey?: string): { code: string; message: string } {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return {
			code: "COMPUTER_CANCELLED",
			message: `Computer action was cancelled. Stop and wait for the user${hotkey ? ` (kill-switch hotkey: ${hotkey})` : ""}.`,
		};
	}
	const maybe = error as { code?: unknown; message?: unknown };
	const rawMessage =
		typeof maybe?.message === "string" && maybe.message.length > 0 ? maybe.message : "Computer action failed.";
	const rawCode = typeof maybe?.code === "string" ? maybe.code : undefined;
	const isComputerCode = (value: string | undefined): value is string =>
		value !== undefined && (NATIVE_ERROR_CODES.has(value) || value.startsWith("COMPUTER_"));
	// Native NAPI errors carry the stable code in the message ("CODE: reason") with
	// error.code set to the NAPI status, so fall back to the message prefix.
	const messageCode = /^(COMPUTER_[A-Z_]+):/.exec(rawMessage)?.[1];
	const code = isComputerCode(rawCode) ? rawCode : (messageCode ?? "COMPUTER_ERROR");
	const reason = messageCode ? rawMessage.slice(messageCode.length + 1).trim() : rawMessage;
	const recoveryHints: Record<string, string> = {
		COMPUTER_COORD_INVALID: "Capture a fresh screenshot and use coordinates within its frame.",
		COMPUTER_DISPLAY_STALE:
			"Capture a fresh screenshot before acting; the display changed since the last screenshot.",
		COMPUTER_SUPERVISOR_NOT_LIVE: `Stop and wait for the user${hotkey ? ` (kill-switch hotkey: ${hotkey})` : ""}.`,
		COMPUTER_SUSPENDED: `Stop and wait for the user${hotkey ? ` (kill-switch hotkey: ${hotkey})` : ""}.`,
		COMPUTER_CANCELLED: `Stop and wait for the user${hotkey ? ` (kill-switch hotkey: ${hotkey})` : ""}.`,
		COMPUTER_PERMISSION_REQUIRED:
			"The host needs screen-recording or accessibility permission. Ask the user to grant it.",
		COMPUTER_DISABLED:
			"The computer tool is disabled or unsupported. Do not retry without enabling it on Apple Silicon macOS.",
	};
	const hint = recoveryHints[code];
	const message = hint ? `${code}: ${reason} ${hint}` : `${code}: ${reason}`;
	return { code, message };
}

interface ComputerAuditRecord {
	timestamp: string;
	action: ComputerActionName;
	status: "success" | "error" | "disabled";
	code?: string;
	x?: number;
	y?: number;
	toX?: number;
	toY?: number;
	scrollX?: number;
	scrollY?: number;
	button?: string;
	keys?: string[];
	ms?: number;
	screenshotWidthPx?: number;
	screenshotHeightPx?: number;
	message?: string;
}

function auditRecordFromDetails(details: ComputerToolDetails): ComputerAuditRecord {
	const record: ComputerAuditRecord = {
		timestamp: new Date().toISOString(),
		action: details.action,
		status: details.status,
	};
	if (details.code) record.code = details.code;
	if (details.x !== undefined) record.x = details.x;
	if (details.y !== undefined) record.y = details.y;
	if (details.toX !== undefined) record.toX = details.toX;
	if (details.toY !== undefined) record.toY = details.toY;
	if (details.scrollX !== undefined) record.scrollX = details.scrollX;
	if (details.scrollY !== undefined) record.scrollY = details.scrollY;
	if (details.button) record.button = details.button;
	if (details.keys) record.keys = details.keys;
	if (details.ms !== undefined) record.ms = details.ms;
	if (details.screenshot) {
		record.screenshotWidthPx = details.screenshot.widthPx;
		record.screenshotHeightPx = details.screenshot.heightPx;
	}
	if (details.message) record.message = details.message;
	return record;
}

async function writeComputerAuditLog(session: ToolSession, details: ComputerToolDetails): Promise<void> {
	if (!session.settings.get("computer.auditLog.enabled")) return;
	const sessionFile = session.getSessionFile();
	if (!sessionFile) return;
	const auditPath = path.join(path.dirname(sessionFile), ".computer-audit.jsonl");
	const record = auditRecordFromDetails(details);
	if (details.steps) {
		for (const step of details.steps) {
			await writeComputerAuditLog(session, step);
		}
	}
	try {
		await fs.appendFile(auditPath, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Audit logging is best-effort; do not let it fail the action.
	}
}

function describeComputerSuccess(details: ComputerToolDetails): string {
	if (details.action === "batch" && details.steps) {
		const successCount = details.steps.filter(s => s.status === "success").length;
		const summary = `${successCount}/${details.steps.length} batch steps completed`;
		if (details.screenshot) {
			const location = details.screenshot.path ? `; saved ${details.screenshot.path}` : "";
			return `Computer batch completed (${summary}; final screenshot ${details.screenshot.widthPx}x${details.screenshot.heightPx}${location}).`;
		}
		return `Computer batch completed (${summary}).`;
	}
	if (details.screenshot) {
		const location = details.screenshot.path ? `; saved ${details.screenshot.path}` : "";
		return `Computer ${details.action} completed (${details.screenshot.widthPx}x${details.screenshot.heightPx}${location}).`;
	}
	return `Computer ${details.action} completed.`;
}
