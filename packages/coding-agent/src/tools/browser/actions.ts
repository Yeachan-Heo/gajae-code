/**
 * Structured browser action space.
 *
 * Adapts the SOTA computer-use / browser-use pattern: instead of authoring raw
 * JavaScript for every interaction, the model emits a list of structured verbs
 * (navigate / click / type / …) that reference elements by the numeric `id`
 * returned from {@link Observation}. Each verb is compiled onto the existing
 * in-tab `tab.*` helpers and executed through the same worker `run` path, so the
 * worker protocol is unchanged and the raw-JS `run` escape hatch still works.
 */

export type BrowserActionVerb =
	| "navigate"
	| "click"
	| "type"
	| "fill"
	| "select"
	| "press"
	| "scroll"
	| "back"
	| "wait"
	| "observe"
	| "extract"
	| "screenshot";

export interface BrowserActionStep {
	verb: BrowserActionVerb;
	/** Element id from a prior `observe` (preferred for click/type). */
	id?: number;
	/** CSS / puppeteer selector when not addressing by `id`. */
	selector?: string;
	/** Text to type. */
	text?: string;
	/** Value for `fill`. */
	value?: string;
	/** Option value(s) for `select`. */
	values?: string[];
	/** URL for `navigate`. */
	url?: string;
	/** Key for `press` (e.g. "Enter"). */
	key?: string;
	/** Horizontal scroll delta. */
	dx?: number;
	/** Vertical scroll delta. */
	dy?: number;
	/** Sleep duration for `wait` when no selector is given. */
	ms?: number;
	/** Extract format. */
	format?: "markdown" | "text" | "html";
	/** Navigation wait condition for `navigate`. */
	wait_until?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	/** Only return interactive/viewport elements for `observe`. */
	viewport_only?: boolean;
	include_all?: boolean;
}

const VERBS: ReadonlySet<BrowserActionVerb> = new Set([
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
]);

/**
 * Validate a single step's required fields. Returns an error string, or
 * `undefined` when the step is well-formed.
 */
export function validateActionStep(step: BrowserActionStep, index: number): string | undefined {
	const where = `actions[${index}] (${step.verb})`;
	if (!VERBS.has(step.verb)) return `${where}: unknown verb`;
	switch (step.verb) {
		case "navigate":
			if (!step.url?.trim()) return `${where}: 'url' is required`;
			return undefined;
		case "click":
			if (step.id === undefined && !step.selector?.trim()) return `${where}: 'id' or 'selector' is required`;
			return undefined;
		case "type":
			if (step.id === undefined && !step.selector?.trim()) return `${where}: 'id' or 'selector' is required`;
			if (step.text === undefined) return `${where}: 'text' is required`;
			return undefined;
		case "fill":
			if (!step.selector?.trim()) return `${where}: 'selector' is required`;
			if (step.value === undefined) return `${where}: 'value' is required`;
			return undefined;
		case "select":
			if (!step.selector?.trim()) return `${where}: 'selector' is required`;
			if (!step.values?.length) return `${where}: 'values' is required`;
			return undefined;
		case "press":
			if (!step.key?.trim()) return `${where}: 'key' is required`;
			return undefined;
		case "scroll":
			if (step.dx === undefined && step.dy === undefined) return `${where}: 'dx' or 'dy' is required`;
			return undefined;
		case "wait":
			if (!step.selector?.trim() && step.ms === undefined) return `${where}: 'selector' or 'ms' is required`;
			return undefined;
		default:
			// back / observe / extract / screenshot take no required fields
			return undefined;
	}
}

/** Validate the full step list. Throws on the first invalid step. */
export function validateActionSteps(steps: readonly BrowserActionStep[]): void {
	if (steps.length === 0) throw new Error("browser 'act' requires a non-empty 'actions' list");
	for (let i = 0; i < steps.length; i += 1) {
		const error = validateActionStep(steps[i]!, i);
		if (error) throw new Error(error);
	}
}

/**
 * Compile structured steps into a JS program for the in-tab `run` worker. Steps
 * are embedded as parsed JSON (no string interpolation, so values cannot inject
 * code) and dispatched by a fixed interpreter against the `tab` / `page` helpers.
 */
export function compileActionSteps(steps: readonly BrowserActionStep[]): string {
	validateActionSteps(steps);
	const stepsLiteral = JSON.stringify(JSON.stringify(steps));
	return `
const __steps = JSON.parse(${stepsLiteral});
const __results = [];
for (const s of __steps) {
	switch (s.verb) {
		case "navigate":
			await tab.goto(s.url, s.wait_until ? { waitUntil: s.wait_until } : undefined);
			__results.push({ verb: "navigate", url: s.url });
			break;
		case "click":
			if (s.id !== undefined && s.id !== null) { await (await tab.id(s.id)).click(); }
			else { await tab.click(s.selector); }
			__results.push({ verb: "click", id: s.id ?? null, selector: s.selector ?? null });
			break;
		case "type":
			if (s.id !== undefined && s.id !== null) { await (await tab.id(s.id)).type(s.text); }
			else { await tab.type(s.selector, s.text); }
			__results.push({ verb: "type", id: s.id ?? null, selector: s.selector ?? null });
			break;
		case "fill":
			await tab.fill(s.selector, s.value);
			__results.push({ verb: "fill", selector: s.selector });
			break;
		case "select":
			__results.push({ verb: "select", selected: await tab.select(s.selector, ...(s.values || [])) });
			break;
		case "press":
			await tab.press(s.key, s.selector ? { selector: s.selector } : undefined);
			__results.push({ verb: "press", key: s.key });
			break;
		case "scroll":
			await tab.scroll(s.dx || 0, s.dy || 0);
			__results.push({ verb: "scroll", dx: s.dx || 0, dy: s.dy || 0 });
			break;
		case "back":
			await page.goBack();
			__results.push({ verb: "back" });
			break;
		case "wait":
			if (s.selector) { await tab.waitFor(s.selector); }
			else { await new Promise(r => setTimeout(r, s.ms)); }
			__results.push({ verb: "wait", selector: s.selector ?? null, ms: s.ms ?? null });
			break;
		case "observe":
			__results.push({ verb: "observe", observation: await tab.observe({ viewportOnly: s.viewport_only === true, includeAll: s.include_all === true }) });
			break;
		case "extract":
			__results.push({ verb: "extract", content: await tab.extract(s.format || "markdown") });
			break;
		case "screenshot":
			await tab.screenshot({});
			__results.push({ verb: "screenshot" });
			break;
		default:
			throw new Error("Unknown browser action verb: " + s.verb);
	}
}
return __results;
`;
}
