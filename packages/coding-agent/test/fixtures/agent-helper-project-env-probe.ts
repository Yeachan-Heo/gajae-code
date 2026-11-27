/**
 * Starts one of the helpers GJC launches during a session from the current
 * (project) directory the way the app does: `@gajae-code/utils/env` loads first
 * (copying the project `.env` into the process environment), then the real
 * launcher builds the helper's environment. The helper itself is replaced by a
 * short-lived `node` process that receives that environment; only whether a
 * planted `NODE_OPTIONS` preload ran matters.
 */
import "@gajae-code/utils/env";
import { vi } from "bun:test";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@gajae-code/ai";
import { TERMINAL } from "@gajae-code/tui";
import { Settings, settings } from "../../src/config/settings";
import { EventController } from "../../src/modes/controllers/event-controller";
import { initTheme } from "../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import { launchHeadlessBrowser, loadPuppeteer } from "../../src/tools/browser/launch";
import { acquireBrowser, type BrowserKind } from "../../src/tools/browser/registry";
import { runEngineSubprocess } from "../../src/web/insane/bridge";

const op = process.argv[2];
const cwd = process.cwd();
const found = Bun.which("node");
if (!found) throw new Error("node not found");
const node: string = found;

async function runNode(env: NodeJS.ProcessEnv | undefined): Promise<void> {
	const proc = Bun.spawn([node, "-e", "0"], { cwd, env, stdout: "ignore", stderr: "ignore" });
	await proc.exited;
}

if (op === "notify") {
	initTheme();
	await Settings.init({ inMemory: true, cwd });
	settings.override("completion.notify", "on");
	settings.set("completion.notifyCommand", `"${node}" -e 0`);
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	const spawn = vi.spyOn(Bun, "spawn");
	const context = {
		isBackgrounded: true,
		sessionManager: { getSessionName: () => "probe", getCwd: () => cwd, getSessionId: () => "probe" },
		session: {
			getLastAssistantMessage: () =>
				({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }) as AssistantMessage,
		},
	} as unknown as InteractiveModeContext;
	new EventController(context).sendCompletionNotification();
	const proc = spawn.mock.results[0]?.value as Bun.Subprocess | undefined;
	if (!proc) throw new Error("notify command was not spawned");
	await proc.exited;
} else if (op === "browser") {
	// Puppeteer starts the browser with `options.env ?? process.env`.
	const puppeteer = await loadPuppeteer();
	vi.spyOn(puppeteer, "launch").mockImplementation(async options => {
		await runNode(options?.env ?? process.env);
		throw new Error("probe browser");
	});
	await launchHeadlessBrowser({ headless: true }).catch(() => {});
} else if (op === "app-path" || op === "chrome-profile") {
	// `app.path` and `app.browser: "chrome"` spawn the configured executable
	// directly. A stand-in script runs node and exits; GJC then waits for a CDP
	// endpoint that never appears, so the probe aborts once node has run.
	const exe = `${cwd}/browser-stand-in.sh`;
	// A GTK browser would load the modules these variables name; record whether any arrived.
	await Bun.write(
		exe,
		`#!/bin/sh\n[ -n "$GTK_MODULES$GTK3_MODULES$GTK_PATH" ] && echo gtk >> "${cwd}/preload-ran"\nexec "${node}" -e 0\n`,
	);
	await fs.chmod(exe, 0o755);
	const userDataDir = `${cwd}/user-data`;
	await fs.mkdir(userDataDir);
	const kind: BrowserKind =
		op === "app-path"
			? { kind: "spawned", path: exe }
			: {
					kind: "chrome-profile",
					path: exe,
					userDataDir,
					profileDirectory: "Profile 1",
					background: true,
					noFocus: true,
				};
	await acquireBrowser(kind, { cwd, signal: AbortSignal.timeout(3_000) }).catch(() => {});
} else if (op === "insane") {
	await runEngineSubprocess(
		{ url: "https://example.invalid", timeoutMs: 10_000 },
		{
			// Keep GJC's spawn options (the environment under test); swap only the program.
			spawnImpl: ((_command: string, _args: readonly string[], options: SpawnOptions) =>
				nodeSpawn(node, ["-e", "0"], options)) as unknown as typeof nodeSpawn,
		},
	);
} else throw new Error(`unknown op ${op}`);
console.log(JSON.stringify({ done: true }));
process.exit(0);
