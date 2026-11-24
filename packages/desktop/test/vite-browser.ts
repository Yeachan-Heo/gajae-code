import puppeteer, { type Browser } from "puppeteer-core";
import { browserPath } from "./component-fixture";

const READY_TIMEOUT_MS = 30_000;
const READY_REQUEST_TIMEOUT_MS = 2_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const WARM_UP_NAVIGATION_TIMEOUT_MS = 60_000;
/** One warm-up attempt: the app entry load plus the file's own warm-up. */
const WARM_UP_ATTEMPT_TIMEOUT_MS = 150_000;
const WARM_UP_ATTEMPTS = 2;
/** Closing the browser and stopping Vite after a failure. */
const CLEANUP_MARGIN_MS = 15_000;
const STDERR_TAIL_CHARS = 2_000;

/**
 * The `beforeAll` budget for {@link startViteBrowser}. It covers starting Vite, launching the
 * browser and paying the one-time cold start, so a slow first page load never lands inside the
 * first test's own limit. It is the sum of every bounded step plus cleanup, so the helper's own
 * error and cleanup always run before Bun's hook timeout would.
 */
export const VITE_BROWSER_SETUP_TIMEOUT_MS =
	READY_TIMEOUT_MS + LAUNCH_TIMEOUT_MS + WARM_UP_ATTEMPTS * WARM_UP_ATTEMPT_TIMEOUT_MS + CLEANUP_MARGIN_MS;

/** A Vite dev server for the desktop UI and the headless browser that drives it. */
export interface ViteBrowser {
	readonly origin: string;
	readonly browser: Browser;
	/** Close the browser and stop Vite; safe to call more than once. */
	close(): Promise<void>;
}

export interface ViteBrowserOptions {
	/**
	 * Drive this file's own first-test path once (for example open the dialog under test), after
	 * the app entry has loaded. It runs on the browser being warmed and must close what it opens.
	 */
	warmUp?: (browser: Browser) => Promise<void>;
}

/**
 * Start Vite for the desktop UI on `port`, wait until it answers, launch the headless browser
 * and warm both once.
 *
 * A fresh checkout has no Vite dependency cache: the first page load optimizes dependencies and
 * transforms every module, and the browser's first render is far slower than later ones. On a
 * cold CI runner that alone took a file's first test past its 30 s limit, and the timeout then
 * killed the shared browser and failed every later test with a closed connection. This pays the
 * cold start here instead: it loads the app entry (which statically imports the app and the
 * showcase, so every component module) until the network is idle, then runs the file's own
 * warm-up. Vite can reload a first page once it finishes optimizing dependencies, so a failed
 * warm-up is retried once on a fresh page.
 *
 * It fails loudly when Vite exits or never answers, naming Vite's last stderr output, and on any
 * failure it stops what it started before rethrowing, since the caller never receives a handle
 * to clean up.
 */
export async function startViteBrowser(port: number, options: ViteBrowserOptions = {}): Promise<ViteBrowser> {
	const executablePath = browserPath;
	if (!executablePath) throw new Error("No browser is available for the mounted desktop UI tests");
	const origin = `http://127.0.0.1:${port}`;
	const server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	// Keep draining stderr so Vite never blocks on a full pipe, and keep its tail for errors.
	const stderr = { tail: "" };
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of server.stderr) {
			stderr.tail = (stderr.tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
		}
	})().catch(() => {});
	let browser: Browser | undefined;
	let closed: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closed ??= (async () => {
			try {
				await browser?.close();
			} finally {
				server.kill();
				await server.exited;
			}
		})();
		return closed;
	};
	try {
		await waitForVite(server, origin, stderr);
		const launched = await puppeteer.launch({ executablePath, headless: true, timeout: LAUNCH_TIMEOUT_MS });
		browser = launched;
		await warmUp(launched, origin, options.warmUp);
		return { origin, browser: launched, close };
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}

function withStderr(message: string, stderr: { tail: string }): string {
	const tail = stderr.tail.trim();
	return tail ? `${message}. Vite stderr:\n${tail}` : `${message}. Vite wrote nothing to stderr.`;
}

async function waitForVite(
	server: Bun.Subprocess<"ignore", "ignore", "pipe">,
	origin: string,
	stderr: { tail: string },
): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(
				withStderr(`The Vite dev server exited with code ${server.exitCode} before answering at ${origin}`, stderr),
			);
		}
		try {
			if ((await fetch(origin, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) })).ok) return;
		} catch {
			// Vite is starting, or this request outlived its own timeout.
		}
		await Bun.sleep(100);
	}
	throw new Error(withStderr(`The Vite dev server did not answer at ${origin} within ${READY_TIMEOUT_MS} ms`, stderr));
}

/** Settle `work` or fail after `ms`; the work itself is left to the caller's cleanup. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
	try {
		return await Promise.race([work, expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function warmUp(browser: Browser, origin: string, step: ViteBrowserOptions["warmUp"]): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await within(
				(async () => {
					const context = await browser.createBrowserContext();
					try {
						const page = await context.newPage();
						await page.goto(origin, { waitUntil: "networkidle0", timeout: WARM_UP_NAVIGATION_TIMEOUT_MS });
					} finally {
						await context.close();
					}
					await step?.(browser);
				})(),
				WARM_UP_ATTEMPT_TIMEOUT_MS,
				`Warm-up attempt ${attempt} at ${origin}`,
			);
			return;
		} catch (error) {
			if (attempt >= WARM_UP_ATTEMPTS) throw error;
			// Say why the first attempt failed, so a retry that then passes is still visible in the log.
			console.warn(`Vite warm-up attempt ${attempt} failed; retrying on a fresh page:`, error);
		}
	}
}
