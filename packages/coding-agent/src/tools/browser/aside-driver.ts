import { ToolAbortError, ToolError } from "../tool-errors";
import { type BrowserActionStep, validateActionSteps } from "./actions";
import { probeAsideCli, resolveAsideCliPath } from "./aside-cli";
import type { BrowserTabInfo, RunResultOk, ScreenshotResult } from "./tab-protocol";

/**
 * Aside REPL driver.
 *
 * Empirically-validated contract (aside CLI 1.26.x, mapped locally):
 * - `aside repl` state does NOT survive across separate invocations and has no
 *   `--session` flag, so each GJC tab owns ONE persistent interactive `aside repl`
 *   child process (= one JS context = one live Playwright `page`).
 * - The child echoes a `repl > ` prompt, runs one submitted line, prints output on
 *   stdout, and terminates each command with a footer line `[ok | <N>ms]` or
 *   `[error | <N>ms]`. The process exit code is ALWAYS 0 — success/failure is read
 *   from the footer, never `$?`.
 * - Return values are NOT auto-printed and `display()` is image-only, so results are
 *   surfaced by a nonce-framed JSON payload the wrapper emits via `console.log`.
 * - Aside globals in scope: `page`, `openTab`, `closeTab`, `snapshot`, `cua`,
 *   `chrome`, `aside`, `listBrowserTabs`. No Puppeteer `browser`/`tab` shim.
 */

const BEGIN = "__GJC_ASIDE_BEGIN__";
const END = "__GJC_ASIDE_END__";
const DEFAULT_TAIL_BYTES = 64 * 1024;

/** Per-command completion footer emitted by the Aside REPL. */
const FOOTER_RE = /^\[(ok|error) \| \d+ms\]\s*$/;

export function isAsideFooter(line: string): "ok" | "error" | null {
	const m = FOOTER_RE.exec(line.trim());
	return m ? (m[1] as "ok" | "error") : null;
}

export interface AsideRunPayload {
	ok: boolean;
	returnValue?: unknown;
	displays?: string[];
	error?: { name?: string; message?: string; stack?: string };
	tabInfo?: BrowserTabInfo;
	asideSessionId?: string;
}

/**
 * Build the single-line REPL program that runs `code` inside an async wrapper and
 * emits exactly one nonce-framed base64(JSON) payload. `code` is base64-encoded so
 * arbitrary newlines/quotes cannot break the single submitted line or collide with
 * the frame sentinels.
 */
export function buildAsideRunWrapper(code: string, nonce: string): string {
	const b64 = Buffer.from(code, "utf8").toString("base64");
	const begin = BEGIN + nonce;
	const end = END + nonce;
	// One physical line. `page` may be null until a tab is open; user code decides.
	return (
		`(async () => {` +
		`const __src = (typeof atob === 'function' ? atob : (s)=>Buffer.from(s,'base64').toString('utf8'))(${JSON.stringify(b64)});` +
		`const __displays = [];` +
		`const __origLog = console.log;` +
		`console.log = (...a) => { try { __displays.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); } catch { __displays.push(String(a[0])); } };` +
		`let __r, __e;` +
		`try { const __fn = (0, eval)('(async () => {\\n' + __src + '\\n})'); __r = await __fn(); } catch (e) { __e = e; }` +
		`console.log = __origLog;` +
		`const __payload = __e` +
		` ? { ok:false, error:{ name: __e && __e.name, message: String((__e && __e.message) || __e), stack: __e && __e.stack }, displays: __displays }` +
		` : { ok:true, returnValue: (__r === undefined ? null : __r), displays: __displays };` +
		`const __json = JSON.stringify(__payload);` +
		`const __enc = (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(__json))) : Buffer.from(__json,'utf8').toString('base64'));` +
		`__origLog(${JSON.stringify(begin)}); __origLog(__enc); __origLog(${JSON.stringify(end)});` +
		`})()`
	);
}

/**
 * Extract the nonce-framed payload from accumulated REPL stdout. Returns null when
 * the frame is absent or malformed. Only the region between the matching BEGIN/END
 * sentinels is parsed; all surrounding daemon/user output is ignored.
 */
export function parseAsideFrame(stdout: string, nonce: string): AsideRunPayload | null {
	const begin = BEGIN + nonce;
	const end = END + nonce;
	const lines = stdout.split("\n");
	const beginIdx = lines.findIndex(l => l.trim() === begin);
	if (beginIdx < 0) return null;
	const endIdx = lines.findIndex((l, i) => i > beginIdx && l.trim() === end);
	if (endIdx < 0) return null;
	const b64 = lines
		.slice(beginIdx + 1, endIdx)
		.join("")
		.trim();
	if (!b64) return null;
	try {
		const json = Buffer.from(b64, "base64").toString("utf8");
		const parsed = JSON.parse(json) as AsideRunPayload;
		if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Keep only the last `maxBytes` of a diagnostic tail, with a truncation notice. */
export function boundedTail(text: string, maxBytes = DEFAULT_TAIL_BYTES): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return text;
	const sliced = buf.subarray(buf.byteLength - maxBytes).toString("utf8");
	return `[…${buf.byteLength - maxBytes} earlier bytes truncated…]\n${sliced}`;
}

/** Minimal child-process surface the session needs; injectable for tests. */
export interface AsideReplProcess {
	writeLine(line: string): void;
	onStdout(cb: (chunk: string) => void): void;
	onExit(cb: (code: number | null) => void): void;
	kill(): void;
}

export type AsideReplSpawn = (cliPath: string) => AsideReplProcess;

/** Default spawner backed by Bun.spawn against the persistent interactive REPL. */
export const defaultAsideReplSpawn: AsideReplSpawn = (cliPath: string): AsideReplProcess => {
	const child = Bun.spawn([cliPath, "repl"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const decoder = new TextDecoder();
	let stdoutCb: ((c: string) => void) | undefined;
	let exitCb: ((c: number | null) => void) | undefined;
	(async () => {
		for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
			stdoutCb?.(decoder.decode(chunk));
		}
	})();
	child.exited.then(code => exitCb?.(code)).catch(() => exitCb?.(null));
	return {
		writeLine(line: string) {
			child.stdin.write(`${line}\n`);
			child.stdin.flush?.();
		},
		onStdout(cb) {
			stdoutCb = cb;
		},
		onExit(cb) {
			exitCb = cb;
		},
		kill() {
			try {
				child.kill();
			} catch {
				// already dead
			}
		},
	};
};

export interface AsideReplSessionOptions {
	cliPath: string;
	spawn?: AsideReplSpawn;
	/** Per-command timeout in ms. */
	timeoutMs?: number;
	tailBytes?: number;
}

interface PendingRun {
	nonce: string;
	resolve: (payload: AsideRunPayload) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

let nonceCounter = 0;
function nextNonce(): string {
	nonceCounter += 1;
	return `n${Date.now().toString(36)}_${nonceCounter}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A persistent interactive `aside repl` child bound to a single GJC tab. Commands are
 * serialized (one pending run at a time, matching the native busy-tab invariant) and
 * completed when the matching nonce frame arrives; the `[ok|error]` footer bounds each
 * command. Abort/timeout kills only this child — never Aside.app or the daemon.
 */
export class AsideReplSession {
	readonly cliPath: string;
	#proc: AsideReplProcess;
	#buf = "";
	#pending: PendingRun | null = null;
	#dead = false;
	#timeoutMs: number;
	#tailBytes: number;

	constructor(opts: AsideReplSessionOptions) {
		this.cliPath = opts.cliPath;
		this.#timeoutMs = opts.timeoutMs ?? 60_000;
		this.#tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
		const spawn = opts.spawn ?? defaultAsideReplSpawn;
		this.#proc = spawn(opts.cliPath);
		this.#proc.onStdout(chunk => this.#onStdout(chunk));
		this.#proc.onExit(() => this.#onExit());
	}

	get dead(): boolean {
		return this.#dead;
	}

	/** Update the per-command timeout used by subsequent runs. */
	setTimeout(ms: number): void {
		this.#timeoutMs = ms;
	}

	#onStdout(chunk: string): void {
		this.#buf += chunk;
		if (this.#tailBytes > 0 && Buffer.byteLength(this.#buf) > this.#tailBytes * 4) {
			this.#buf = boundedTail(this.#buf, this.#tailBytes * 4);
		}
		const pending = this.#pending;
		if (!pending) return;
		const payload = parseAsideFrame(this.#buf, pending.nonce);
		if (payload) {
			this.#settle(payload);
			return;
		}
		// If the command finished (footer) without a frame, it is a protocol error.
		const sawFooter = this.#buf
			.split("\n")
			.some(l => isAsideFooter(l) !== null && this.#buf.includes(pending.nonce) === false);
		if (sawFooter && !this.#buf.includes(BEGIN + pending.nonce)) {
			pending.reject(
				new ToolError(
					`Aside REPL completed without a result frame. Output tail:\n${boundedTail(this.#buf, this.#tailBytes)}`,
				),
			);
			this.#clearPending();
		}
	}

	#settle(payload: AsideRunPayload): void {
		const pending = this.#pending;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.#pending = null;
		this.#buf = "";
		pending.resolve(payload);
	}

	#clearPending(): void {
		if (this.#pending) clearTimeout(this.#pending.timer);
		this.#pending = null;
		this.#buf = "";
	}

	#onExit(): void {
		this.#dead = true;
		if (this.#pending) {
			this.#pending.reject(new ToolError("Aside REPL process exited before returning a result."));
			this.#clearPending();
		}
	}

	/** Run user code in the live REPL context and resolve the framed payload. */
	async run(code: string, signal?: AbortSignal): Promise<AsideRunPayload> {
		if (this.#dead) throw new ToolError("Aside REPL session is closed. Reopen the tab.");
		if (this.#pending) throw new ToolError("Aside tab is busy with another run.");
		if (signal?.aborted) throw new ToolAbortError();
		const nonce = nextNonce();
		const wrapper = buildAsideRunWrapper(code, nonce);
		return await new Promise<AsideRunPayload>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#clearPending();
				this.kill();
				reject(new ToolError(`Aside REPL run timed out after ${this.#timeoutMs}ms (nonce ${nonce}).`));
			}, this.#timeoutMs);
			const onAbort = () => {
				this.#clearPending();
				this.kill();
				reject(new ToolAbortError());
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.#pending = {
				nonce,
				timer,
				resolve: p => {
					signal?.removeEventListener("abort", onAbort);
					resolve(p);
				},
				reject: e => {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
			};
			this.#buf = "";
			try {
				this.#proc.writeLine(wrapper);
			} catch (err) {
				this.#clearPending();
				reject(new ToolError(`Failed to write to Aside REPL: ${(err as Error).message}`));
			}
		});
	}

	/** Terminate only this REPL child. Never touches Aside.app or the daemon. */
	kill(): void {
		this.#dead = true;
		this.#proc.kill();
	}
}

/** Resolve the Aside CLI or throw an actionable ToolError (never auto-installs). */
export function requireAsideCli(): string {
	const probe = probeAsideCli();
	if (probe.ok) return probe.path;
	throw new ToolError(
		`Aside CLI not found (searched: ${probe.searched.join(", ")}). Install it with \`${probe.manualInstallCommand}\` or run /browser, then retry.`,
	);
}

export { resolveAsideCliPath };

/**
 * Compile structured action steps into an Aside REPL program. Mirrors the native
 * `compileActionSteps` verb set but targets Aside's Playwright-style `page` +
 * coordinate `cua` globals (no native `tab` helper, no Puppeteer shim). Steps are
 * embedded as parsed JSON so values cannot inject code.
 */
export function compileAsideActionSteps(steps: readonly BrowserActionStep[]): string {
	validateActionSteps(steps);
	for (let i = 0; i < steps.length; i += 1) {
		const step = steps[i]!;
		if ((step.verb === "click" || step.verb === "type") && step.id !== undefined && step.id !== null) {
			throw new ToolError(
				`Aside browser act does not support observed numeric ids for actions[${i}] (${step.verb}); use a selector instead.`,
			);
		}
	}
	const stepsLiteral = JSON.stringify(JSON.stringify(steps));
	return `
const __steps = JSON.parse(${stepsLiteral});
const __results = [];
for (const s of __steps) {
	switch (s.verb) {
		case "navigate":
			await page.goto(s.url, s.wait_until ? { waitUntil: s.wait_until } : undefined);
			__results.push({ verb: "navigate", url: s.url });
			break;
		case "click":
			await page.locator(s.selector).click();
			__results.push({ verb: "click", selector: s.selector ?? null });
			break;
		case "type":
			await page.locator(s.selector).pressSequentially(s.text);
			__results.push({ verb: "type", selector: s.selector ?? null });
			break;
		case "fill":
			await page.locator(s.selector).fill(s.value);
			__results.push({ verb: "fill", selector: s.selector });
			break;
		case "select":
			__results.push({ verb: "select", selected: await page.locator(s.selector).selectOption(s.values || []) });
			break;
		case "press":
			if (s.selector) { await page.locator(s.selector).press(s.key); }
			else { await page.keyboard.press(s.key); }
			__results.push({ verb: "press", key: s.key });
			break;
		case "scroll":
			await cua.scroll({ x: 0, y: 0, scrollX: s.dx || 0, scrollY: s.dy || 0 });
			__results.push({ verb: "scroll", dx: s.dx || 0, dy: s.dy || 0 });
			break;
		case "back":
			await page.goBack();
			__results.push({ verb: "back" });
			break;
		case "wait":
			if (s.selector) { await page.waitForSelector(s.selector); }
			else { await new Promise(r => setTimeout(r, s.ms)); }
			__results.push({ verb: "wait", selector: s.selector ?? null, ms: s.ms ?? null });
			break;
		case "observe":
			__results.push({ verb: "observe", observation: (await snapshot(page)).tree });
			break;
		case "extract":
			__results.push({ verb: "extract", content: await page.content() });
			break;
		case "screenshot":
			__results.push({ verb: "screenshot", pngBase64: await cua.getVisibleScreenshot() });
			break;
		default:
			throw new Error("Unknown browser action verb: " + s.verb);
	}
}
return __results;
`;
}

/** Map an Aside REPL payload to the shared RunResultOk shape used by the browser tool. */
export function asidePayloadToRunResult(payload: AsideRunPayload): RunResultOk {
	if (!payload.ok) {
		const e = payload.error;
		const err = new ToolError(e?.message || "Aside REPL run failed");
		if (e?.stack) (err as { stack?: string }).stack = e.stack;
		throw err;
	}
	const displays = (payload.displays ?? []).map(text => ({ type: "text" as const, text }));
	const screenshots: ScreenshotResult[] = [];
	return { displays, returnValue: payload.returnValue, screenshots };
}

/** Result of opening/reusing an Aside tab. */
export interface AsideOpenResult {
	info: BrowserTabInfo;
	created: boolean;
}

/**
 * Owns per-name persistent Aside REPL sessions for the browser tool. This is the
 * "outer seam" for the Aside backend: it keeps Aside entirely out of the native
 * Puppeteer/CDP tab-supervisor, confining Aside lifecycle to new code.
 */
export class AsideTabManager {
	#tabs = new Map<string, AsideReplSession>();
	#spawn?: AsideReplSpawn;

	constructor(spawn?: AsideReplSpawn) {
		this.#spawn = spawn;
	}

	get(name: string): AsideReplSession | undefined {
		return this.#tabs.get(name);
	}

	has(name: string): boolean {
		const s = this.#tabs.get(name);
		return !!s && !s.dead;
	}

	async open(
		name: string,
		cliPath: string,
		opts: { url?: string; timeoutMs: number; signal?: AbortSignal },
	): Promise<AsideOpenResult> {
		let session = this.#tabs.get(name);
		let created = false;
		if (!session || session.dead) {
			session = new AsideReplSession({ cliPath, spawn: this.#spawn, timeoutMs: opts.timeoutMs });
			this.#tabs.set(name, session);
			created = true;
		}
		if (opts.url) {
			await session.run(`await openTab(${JSON.stringify(opts.url)})`, opts.signal);
		}
		const info = await this.#readInfo(session, opts.signal);
		return { info, created };
	}

	async run(name: string, code: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResultOk> {
		const session = this.#require(name);
		session.setTimeout?.(timeoutMs);
		const payload = await session.run(code, signal);
		return asidePayloadToRunResult(payload);
	}

	async act(
		name: string,
		steps: readonly BrowserActionStep[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<RunResultOk> {
		return await this.run(name, compileAsideActionSteps(steps), timeoutMs, signal);
	}

	close(name: string): boolean {
		const session = this.#tabs.get(name);
		if (!session) return false;
		session.kill();
		this.#tabs.delete(name);
		return true;
	}

	closeAll(): number {
		let count = 0;
		for (const name of [...this.#tabs.keys()]) {
			if (this.close(name)) count++;
		}
		return count;
	}

	async #readInfo(session: AsideReplSession, signal?: AbortSignal): Promise<BrowserTabInfo> {
		const payload = await session.run(
			"return page ? { url: await page.url(), title: await page.title(), viewport: (page.viewportSize ? page.viewportSize() : null) } : { url: 'about:blank', title: '', viewport: null }",
			signal,
		);
		const rv = (payload.ok ? payload.returnValue : null) as {
			url?: string;
			title?: string;
			viewport?: { width: number; height: number } | null;
		} | null;
		return {
			url: rv?.url ?? "about:blank",
			title: rv?.title,
			viewport: rv?.viewport ?? { width: 0, height: 0 },
		};
	}

	#require(name: string): AsideReplSession {
		const session = this.#tabs.get(name);
		if (!session || session.dead) {
			throw new ToolError(`No Aside tab named ${JSON.stringify(name)}. Open it first with action 'open'.`);
		}
		return session;
	}
}
