import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { type BrowserActionStep, compileActionSteps } from "./browser/actions";
import { acquireBrowser, type BrowserHandle, type BrowserKind, type BrowserKindTag } from "./browser/registry";
import type { Observation, ScreenshotResult } from "./browser/tab-protocol";
import { acquireTab, dropHeadlessTabs, getTab, releaseAllTabs, releaseTab, runInTab } from "./browser/tab-supervisor";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";

const appSchema = z.object({
	path: z.string().describe("binary path to spawn").optional(),
	cdp_url: z.string().describe("existing cdp endpoint").optional(),
	browser: z.enum(["chrome"]).describe("existing browser profile mode").optional(),
	user_data_dir: z.string().describe("Chrome user data directory containing profiles").optional(),
	profile_directory: z.string().describe("Chrome profile directory name, e.g. Profile 10").optional(),
	background: z.boolean().describe("prefer background/hidden Chrome profile launch when supported").optional(),
	no_focus: z.boolean().describe("avoid focusing Chrome during profile launch when supported").optional(),
	cdp_port: z.number().int().positive().describe("local CDP port for launched Chrome profile").optional(),
	args: z.array(z.string()).describe("extra cli args").optional(),
	target: z.string().describe("substring to pick a window").optional(),
});

const actionStepSchema = z.object({
	verb: z
		.enum([
			"navigate",
			"click",
			"type",
			"fill",
			"select",
			"press",
			"scroll",
			"back",
			"wait",
			"observe",
			"extract",
			"screenshot",
		])
		.describe("structured action verb"),
	id: z.number().describe("element id from a prior observe").optional(),
	selector: z.string().describe("css/puppeteer selector").optional(),
	text: z.string().describe("text to type").optional(),
	value: z.string().describe("value for fill").optional(),
	values: z.array(z.string()).describe("option value(s) for select").optional(),
	url: z.string().describe("url for navigate").optional(),
	key: z.string().describe("key for press, e.g. Enter").optional(),
	dx: z.number().describe("horizontal scroll delta").optional(),
	dy: z.number().describe("vertical scroll delta").optional(),
	ms: z.number().describe("sleep ms for wait without selector").optional(),
	format: z.enum(["markdown", "text", "html"]).describe("extract format").optional(),
	wait_until: z
		.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
		.describe("navigation wait condition for navigate")
		.optional(),
	viewport_only: z.boolean().describe("observe: only viewport elements").optional(),
	include_all: z.boolean().describe("observe: include non-interactive elements").optional(),
});

const browserSchema = z.object({
	action: z.enum(["open", "close", "run", "act"] as const).describe("operation"),
	name: z.string().describe("tab id (default 'main')").optional(),
	url: z.string().describe("url to open").optional(),
	app: appSchema.optional(),
	viewport: z
		.object({
			width: z.number(),
			height: z.number(),
			scale: z.number().optional(),
		})
		.optional(),
	wait_until: z
		.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"] as const)
		.describe("navigation wait condition")
		.optional(),
	dialogs: z
		.enum(["accept", "dismiss"] as const)
		.describe("auto-handle dialogs")
		.optional(),
	code: z.string().describe("js body to run in tab").optional(),
	actions: z.array(actionStepSchema).describe("structured action steps for action 'act'").optional(),
	timeout: z.number().default(30).describe("timeout in seconds (default 30, max 300)").optional(),
	all: z.boolean().describe("close every tab").optional(),
	kill: z.boolean().describe("also kill spawned-app browsers").optional(),
});

/** Input schema for the browser tool. */
export type BrowserParams = z.infer<typeof browserSchema>;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	result?: string;
	meta?: OutputMeta;
}

export function resolveBrowserKindForTest(params: BrowserParams, session: ToolSession): BrowserKind {
	return resolveBrowserKind(params, session);
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.browser === "chrome") {
		if (!app.path) throw new ToolError('app.path is required when app.browser is "chrome".');
		if (!app.user_data_dir) throw new ToolError('app.user_data_dir is required when app.browser is "chrome".');
		if (!app.profile_directory)
			throw new ToolError('app.profile_directory is required when app.browser is "chrome".');
		const exe = resolveToCwd(app.path, session.cwd);
		return {
			kind: "chrome-profile",
			path: exe,
			userDataDir: resolveToCwd(app.user_data_dir, session.cwd),
			profileDirectory: app.profile_directory,
			background: app.background ?? false,
			noFocus: app.no_focus ?? false,
			cdpPort: app.cdp_port,
		};
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe };
	}
	const headless = session.settings.get("browser.headless") as boolean;
	return { kind: "headless", headless };
}

/**
 * Browser tool: stateful, multi-tab. Three actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly label = "Browser";
	readonly loadMode = "discoverable";
	readonly summary = "Control a headless browser to navigate and interact with web pages";
	readonly parameters = browserSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(browserDescription, {});
		return this.#description;
	}

	/** Restart browser to apply mode changes (e.g. headless toggle). Drops only headless browsers. */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout);
			const timeoutMs = timeoutSeconds * 1000;
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };

			switch (params.action) {
				case "open":
					return await this.#open(name, params, details, timeoutMs, signal);
				case "close":
					return await this.#close(name, params, details, timeoutMs, signal);
				case "run":
					return await this.#run(name, params, details, timeoutMs, signal);
				case "act":
					return await this.#act(name, params, details, timeoutMs, signal);
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kind = resolveBrowserKind(params, this.session);
		details.browser = kind.kind;

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
			);
		}

		const browser = await untilAborted(signal, () =>
			acquireBrowser(kind, {
				cwd: this.session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				appArgs: params.app?.args,
				profileReuse:
					(this.session.settings.get("browser.profileReuse") as "auto" | "opt-in" | undefined) ?? "auto",
				signal,
			}),
		);

		const result = await untilAborted(signal, () =>
			acquireTab(name, browser, {
				ownerId: this.session.getSessionId?.() ?? undefined,
				url: params.url,
				waitUntil: params.wait_until,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				target: params.app?.target,
				timeoutMs,
				dialogs: params.dialogs,
				signal,
			}),
		);
		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
		].filter((l): l is string => typeof l === "string");
		details.result = lines.join("\n");
		return toolResult(details).text(lines.join("\n")).done();
	}

	async #close(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kill = !!params.kill;
		// One end-to-end budget across the whole close/close-all teardown chain (#2027):
		// releaseAllTabs → waitForClosed → worker.terminate → releaseBrowser stay bounded so
		// a CDP target dying mid-teardown cannot hang the tool call or the agent turn.
		const deadlineAt = Date.now() + timeoutMs;
		if (params.all) {
			const count = await untilAborted(signal, () => releaseAllTabs({ kill, deadlineAt }));
			details.result = `Closed ${count} tab(s)`;
			return toolResult(details).text(details.result).done();
		}
		const closed = await untilAborted(signal, () => releaseTab(name, { kill, deadlineAt }));
		details.result = closed ? `Closed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
		return toolResult(details).text(details.result).done();
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("Missing required parameter 'code' for action 'run'.");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		const { displays, returnValue, screenshots } = await runInTab(name, {
			code: params.code,
			timeoutMs,
			signal,
			session: this.session,
		});

		if (screenshots.length) details.screenshots = screenshots;

		const content = [...displays];
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran code on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		details.result = textOnly;
		return toolResult(details).content(content).done();
	}

	async #act(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const steps = (params.actions ?? []) as BrowserActionStep[];
		if (steps.length === 0) {
			throw new ToolError("Missing required parameter 'actions' for action 'act'.");
		}
		const tab = getTab(name);
		if (!tab) {
			throw new ToolError(`No tab named ${JSON.stringify(name)}. Open it first with action 'open'.`);
		}
		details.browser = tab.browser.kind.kind;
		details.url = tab.info.url;

		// compileActionSteps validates each step and produces injection-safe code
		// (steps embedded as parsed JSON) for the existing in-tab run worker.
		let code: string;
		try {
			code = compileActionSteps(steps);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}

		const { displays, returnValue, screenshots } = await runInTab(name, {
			code,
			timeoutMs,
			signal,
			session: this.session,
		});

		if (screenshots.length) details.screenshots = screenshots;
		const content = [...displays];
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran ${steps.length} action(s) on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		details.result = textOnly;
		return toolResult(details).content(content).done();
	}
}

function describeBrowser(handle: BrowserHandle): string {
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "chrome-profile":
			return `Chrome profile ${handle.kind.profileDirectory} at ${handle.kind.userDataDir} (${handle.subprocess ? `pid ${handle.pid ?? "?"}` : "external CDP"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "chrome-profile":
			return `chrome-profile:${kind.path}:${kind.userDataDir}:${kind.profileDirectory}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "chrome-profile" && b.kind === "chrome-profile") {
		return a.path === b.path && a.userDataDir === b.userDataDir && a.profileDirectory === b.profileDirectory;
	}
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	return false;
}

/** Max chars of a browser return value surfaced into the tool result (F22). */
const MAX_BROWSER_RETURN_CHARS = 256 * 1024;

const BROWSER_RETURN_BUDGET_EXCEEDED = Symbol("browser-return-budget-exceeded");

/** Hard-cap any surfaced browser return string at the byte/char limit with a notice. */
function capBrowserReturn(text: string): string {
	if (text.length <= MAX_BROWSER_RETURN_CHARS) return text;
	return `${text.slice(0, MAX_BROWSER_RETURN_CHARS)}\n\n[Browser return value truncated: ${text.length} chars exceeds the ${MAX_BROWSER_RETURN_CHARS}-char cap.]`;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return capBrowserReturn(value);
	// F22: bound the serialization itself — the replacer tracks running size and aborts early so a
	// huge object/array cannot build megabytes before truncation — AND hard-cap the final string,
	// since pretty-print structural overhead (indent/braces/commas) is not counted by the budget.
	let budget = MAX_BROWSER_RETURN_CHARS;
	try {
		const text = JSON.stringify(
			value,
			(_key, val) => {
				if (typeof val === "string") budget -= val.length + 4;
				else if (typeof val === "number" || typeof val === "boolean") budget -= 8;
				else budget -= 2;
				if (budget < 0) throw BROWSER_RETURN_BUDGET_EXCEEDED;
				return val;
			},
			2,
		);
		return text === undefined ? capBrowserReturn(String(value)) : capBrowserReturn(text);
	} catch (error) {
		if (error === BROWSER_RETURN_BUDGET_EXCEEDED) {
			return `[Browser return value too large to serialize (exceeds the ${MAX_BROWSER_RETURN_CHARS}-char cap). Return a smaller or summarized value from the page script.]`;
		}
		try {
			return capBrowserReturn(String(value));
		} catch {
			return "[unserializable browser return value]";
		}
	}
}
