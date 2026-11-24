import puppeteer, { type Browser } from "puppeteer-core";
import { browserPath } from "./component-fixture";

/**
 * The `beforeAll` budget for {@link startViteBrowser}. It covers starting Vite, launching the
 * browser and paying the one-time cold start, so a slow first page load never lands inside the
 * first test's own limit.
 */
export const VITE_BROWSER_SETUP_TIMEOUT_MS = 180_000;

const READY_TIMEOUT_MS = 30_000;
const WARM_UP_NAVIGATION_TIMEOUT_MS = 60_000;
const WARM_UP_ATTEMPTS = 2;

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
 * It fails loudly when Vite exits or never answers, and on any failure it stops what it started
 * before rethrowing, since the caller never receives a handle to clean up.
 */
export async function startViteBrowser(port: number, options: ViteBrowserOptions = {}): Promise<ViteBrowser> {
	const executablePath = browserPath;
	if (!executablePath) throw new Error("No browser is available for the mounted desktop UI tests");
	const origin = `http://127.0.0.1:${port}`;
	const server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
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
		await waitForVite(server, origin);
		const launched = await puppeteer.launch({ executablePath, headless: true });
		browser = launched;
		await warmUp(launched, origin, options.warmUp);
		return { origin, browser: launched, close };
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}

async function waitForVite(server: Bun.Subprocess<"ignore", "ignore", "ignore">, origin: string): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(`The Vite dev server exited with code ${server.exitCode} before answering at ${origin}`);
		}
		try {
			if ((await fetch(origin)).ok) return;
		} catch {
			// Vite is starting.
		}
		await Bun.sleep(100);
	}
	throw new Error(`The Vite dev server did not answer at ${origin} within ${READY_TIMEOUT_MS} ms`);
}

async function warmUp(browser: Browser, origin: string, step: ViteBrowserOptions["warmUp"]): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			const context = await browser.createBrowserContext();
			try {
				const page = await context.newPage();
				await page.goto(origin, { waitUntil: "networkidle0", timeout: WARM_UP_NAVIGATION_TIMEOUT_MS });
			} finally {
				await context.close();
			}
			await step?.(browser);
			return;
		} catch (error) {
			if (attempt >= WARM_UP_ATTEMPTS) throw error;
		}
	}
}
