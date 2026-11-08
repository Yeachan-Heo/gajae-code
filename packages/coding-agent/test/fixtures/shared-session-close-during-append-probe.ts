/**
 * Observer-only probe: close a resumed TUI while another process has an in-flight append.
 * This is not an ownership collision test: it validates neither closing-side writer ownership,
 * artifact-root ownership nor rewrite debt. Only isolated temporary histories are accessed.
 *
 * From the repository root:
 *   bun packages/coding-agent/test/fixtures/shared-session-close-during-append-probe.ts
 *   bun packages/coding-agent/test/fixtures/shared-session-close-during-append-probe.ts --expire-release-gate
 *   bun packages/coding-agent/test/fixtures/shared-session-close-during-append-probe.ts --unclean-closer
 * Normal: exit 0 only with the observation checks and confirmed cleanup.
 * Negative modes: exit 1, never release the held reply, and print failure plus cleanup evidence.
 * Expiry withholds release and uses a 250 ms gate deadline; unclean close kills the actual PTY.
 * Setup/turn waits are bounded at 30 s, PTYs at 120 s, cleanup at 15 s graceful + 15 s killed
 * per child. Host/native stalls are not a hard wall-clock guarantee. An unconfirmed termination
 * retains the temporary root and reports its path; it is never permission to remove a live root.
 * Previous successful runs are not evidence for this revision or its negative paths.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PtyRunResult, PtySession } from "@gajae-code/natives";

const args = process.argv.slice(2);
const mode = args[0] ?? "normal";
const validMode = args.length <= 1 && ["normal", "--expire-release-gate", "--unclean-closer"].includes(mode);
const reply = "probe-reply";
const sleep = (ms: number) => Bun.sleep(ms);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cleanExit = (result: PtyRunResult) => result.exitCode === 0 && !result.cancelled && !result.timedOut;
interface Child {
	name: string;
	pty: PtySession;
	done: Promise<void>;
	result?: PtyRunResult;
	error?: string;
	screen: string;
}
const children: Child[] = [];
let root: string | undefined;
let server: Bun.Server<undefined> | undefined;
let stopping = false;
let responses = 0;
let heldRequests = 0;
let heldRepliesEmitted = 0;
let gateExpired = false;
let releaseWritten = false;
let verifiedCloserExit = false;
let failure: string | undefined;
const observation: Record<string, unknown> = { closerExitedBeforeReply: false };
const cleanupErrors: string[] = [];
const cleanupChildren: Record<string, unknown>[] = [];
let rootRemoved = false;
let serverStopped = false;

// Polling keeps the wait bounded without leaving timeout promises behind after completion.
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
	const deadline = performance.now() + timeoutMs;
	while (!(await check())) {
		if (gateExpired) throw new Error("Release gate expired without authorization");
		if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await sleep(50);
	}
}

async function waitForCompletion(child: Child, timeoutMs: number) {
	const deadline = performance.now() + timeoutMs;
	while (!child.result && !child.error && performance.now() < deadline) await sleep(50);
	// A rejected start promise is not proof of process termination.
	if (!child.result) return false;
	await child.done;
	return true;
}

try {
	if (!validMode) throw new Error("Expected no argument, --expire-release-gate, or --unclean-closer");
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-close-probe-"));
	const releasePath = path.join(root, "closer-exited");
	const sessions = path.join(root, "sessions");
	const agent = path.join(root, "agent");
	const cwd = path.join(root, "workspace");
	for (const directory of [sessions, agent, cwd]) await fs.mkdir(directory, { recursive: true });
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			if (!url.pathname.endsWith("/chat/completions")) {
				return new Response("{}", { headers: { "content-type": "application/json" } });
			}
			await request.text();
			responses += 1;
			if (responses > 1) {
				heldRequests += 1;
				const deadline = performance.now() + (mode === "--expire-release-gate" ? 250 : 60_000);
				while (!releaseWritten || !fsSync.existsSync(releasePath)) {
					if (stopping || gateExpired) return new Response("Probe reply withheld", { status: 409 });
					if (performance.now() >= deadline) {
						gateExpired = true;
						return new Response("Release gate expired", { status: 409 });
					}
					await sleep(25);
				}
				// The file alone is insufficient: release must follow an observed clean PTY exit.
				if (stopping || gateExpired || !verifiedCloserExit || !releaseWritten) {
					return new Response("Release not authorized", { status: 409 });
				}
				heldRepliesEmitted += 1;
			}
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			return new Response(
				`${chunk({ role: "assistant", content: reply }, null) + chunk({}, "stop")}data: [DONE]\n\n`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	await Bun.write(
		path.join(agent, "models.yml"),
		`providers:
  fake:
    baseUrl: http://127.0.0.1:${server.port}/v1
    apiKey: probe-key
    api: openai-completions
    models:
      - id: fake-model
        name: Fake Model
        contextWindow: 8000
        maxTokens: 1000
        input: [text]
        output: [text]
`,
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		HOME: root,
		TERM: "xterm-256color",
		GJC_CODING_AGENT_DIR: agent,
		GJC_AUTOMATION: "1",
		GJC_NOTIFY: "off",
	};
	const cli = path.resolve(import.meta.dirname, "../../src/cli.ts");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const start = (name: string, extra: string[] = []) => {
		const child: Child = { name, pty: new PtySession(), done: Promise.resolve(), screen: "" };
		// Pin the session before start, including synchronous-start failures.
		children.push(child);
		child.done = child.pty
			.start(
				{
					command: [
						process.execPath,
						cli,
						"--no-mcp",
						"--no-lsp",
						"--no-rules",
						"--no-title",
						"--model",
						"fake/fake-model",
						"--session-dir",
						sessions,
						...extra,
					]
						.map(quote)
						.join(" "),
					shell: "bash",
					cwd,
					env,
					unsetEnv: Object.keys(process.env).filter(key => !(key in env)),
					cols: 120,
					rows: 36,
					timeoutMs: 120_000,
				},
				(_error, chunk) => {
					if (chunk) child.screen += chunk;
				},
			)
			.then(
				result => {
					child.result = result;
				},
				error => {
					child.error = errorText(error);
				},
			);
		return child;
	};
	const transcriptFiles = async () =>
		(await fs.readdir(sessions, { recursive: true })).filter(entry => entry.endsWith(".jsonl"));
	const transcript = async () => {
		const files = await transcriptFiles();
		return files.length === 1 ? Bun.file(path.join(sessions, files[0]!)).text() : "";
	};
	const replyCount = async () => (await transcript()).split(reply).length - 1;
	const owner = start("owner");
	await sleep(9_000);
	owner.pty.write("opening-turn\r");
	await waitFor(async () => (await replyCount()) === 1, 30_000, "opening reply");
	const sessionId = (JSON.parse((await transcript()).split("\n")[0]!) as { id: string }).id;
	const closer = start("closer", ["--resume", sessionId]);
	await waitFor(
		() => closer.screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").includes("opening-turn"),
		30_000,
		"resumed history",
	);
	const repliesBeforeTurn = await replyCount();
	owner.pty.write("in-flight-turn\r");
	// Observe the actual blocked request, not just an input echo or a short sleep.
	await waitFor(() => heldRequests > 0, 30_000, "held model request");
	const repliesAtClose = await replyCount();
	const promptAtClose = (await transcript()).includes("in-flight-turn");
	Object.assign(observation, { closerOpenedSession: true, repliesBeforeTurn, repliesAtClose, promptAtClose });
	if (mode === "--expire-release-gate") {
		await waitFor(() => gateExpired, 5_000, "forced gate expiry");
		throw new Error("Release gate expired without authorization");
	}
	if (mode === "--unclean-closer") closer.pty.kill();
	else closer.pty.write("/quit\r");
	await waitFor(() => Boolean(closer.result || closer.error), 30_000, "closer exit");
	await closer.done;
	if (!closer.result) throw new Error(`Closer completion unconfirmed: ${closer.error}`);
	const closerResult = closer.result;
	verifiedCloserExit = cleanExit(closerResult);
	Object.assign(observation, {
		closerExitCode: closerResult.exitCode ?? null,
		closerCancelled: closerResult.cancelled,
		closerTimedOut: closerResult.timedOut,
		closerExited: verifiedCloserExit,
	});
	if (!verifiedCloserExit) throw new Error("Closer did not exit cleanly; release denied");
	if (mode === "--unclean-closer") throw new Error("Forced kill unexpectedly produced a clean exit; release denied");
	if (gateExpired) throw new Error("Release gate expired before closer exit");
	await fs.writeFile(releasePath, "clean exit verified\n");
	releaseWritten = true;
	await waitFor(async () => (await replyCount()) > repliesAtClose, 30_000, "in-flight reply commit");
	const repliesAfterClose = await replyCount();
	const entries = (await transcript())
		.split("\n")
		.slice(1)
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as { id?: string; parentId?: string });
	const ids = new Set(entries.map(entry => entry.id));
	const transcriptFileCount = (await transcriptFiles()).length;
	const danglingParents = entries.filter(
		entry => typeof entry.parentId === "string" && !ids.has(entry.parentId),
	).length;
	const duplicateIds = entries.length - ids.size;
	const closerExitedBeforeReply =
		verifiedCloserExit &&
		releaseWritten &&
		!gateExpired &&
		heldRepliesEmitted > 0 &&
		promptAtClose &&
		repliesAtClose === repliesBeforeTurn &&
		repliesAfterClose > repliesAtClose;
	Object.assign(observation, {
		repliesAfterClose,
		closerExitedBeforeReply,
		transcriptFiles: transcriptFileCount,
		entries: entries.length,
		danglingParents,
		duplicateIds,
	});
	if (!closerExitedBeforeReply || transcriptFileCount !== 1 || danglingParents !== 0 || duplicateIds !== 0) {
		throw new Error("Probe observation checks failed");
	}
} catch (error) {
	failure = errorText(error);
} finally {
	stopping = true;
	// Never unlink a root on a mere elapsed timeout. Only fulfilled PTY completion confirms exit.
	for (const child of children) {
		let killed = false;
		const errors: string[] = [];
		if (!child.result) {
			try {
				child.pty.write("\x03");
				child.pty.write("/quit\r");
			} catch (error) {
				errors.push(`graceful: ${errorText(error)}`);
			}
			if (!(await waitForCompletion(child, 15_000))) {
				try {
					child.pty.kill();
					killed = true;
				} catch (error) {
					errors.push(`kill: ${errorText(error)}`);
				}
				await waitForCompletion(child, 15_000);
			}
		}
		const confirmed = Boolean(child.result);
		cleanupChildren.push({
			name: child.name,
			confirmed,
			killed,
			result: child.result ?? null,
			startError: child.error ?? null,
			errors,
		});
		if (!confirmed) cleanupErrors.push(`${child.name} termination unconfirmed`);
	}
	try {
		if (server) await server.stop(true);
		serverStopped = true;
	} catch (error) {
		cleanupErrors.push(`server stop: ${errorText(error)}`);
	}
	if (root && children.every(child => Boolean(child.result)) && serverStopped) {
		try {
			await fs.rm(root, { recursive: true, force: true });
			rootRemoved = true;
		} catch (error) {
			cleanupErrors.push(`root removal: ${errorText(error)}`);
		}
	}
}
const ok = !failure && cleanupErrors.length === 0;
process.stdout.write(
	`${JSON.stringify({
		mode,
		ok,
		failure: failure ?? null,
		...observation,
		gateExpired,
		releaseWritten,
		verifiedCloserExit,
		heldRequests,
		heldRepliesEmitted,
		cleanup: {
			children: cleanupChildren,
			serverStopped,
			rootRemoved,
			retainedRoot: rootRemoved ? null : (root ?? null),
			errors: cleanupErrors,
		},
	})}\n`,
);
process.exit(ok ? 0 : 1);
