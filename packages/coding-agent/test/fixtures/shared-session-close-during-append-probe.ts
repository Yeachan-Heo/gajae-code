/**
 * Probe: does closing one TUI disturb another process's in-flight append?
 *
 * The cleanup-ownership story could not be pinned as a test: review established that a read-only
 * resume close performs no filesystem writes, so an assertion about a collision could not fail.
 * This probe records the two-process observation instead, so the claim is grounded in a real run
 * rather than in reasoning about the code.
 *
 * Run: `bun packages/coding-agent/test/fixtures/shared-session-close-during-append-probe.ts`
 *
 * Observed (macOS, 2026-11-08):
 *   {"closerOpenedSession":true,"closerExitCode":0,"closerCancelled":false,
 *    "closerTimedOut":false,"closerExited":true,"repliesBeforeTurn":1,"repliesAtClose":1,
 *    "repliesAfterClose":2,"promptAtClose":true,"closerExitedBeforeReply":true,
 *    "transcriptFiles":1,"entries":14,"danglingParents":0,"duplicateIds":0}
 * The closer attached to the resumed session and exited cleanly while the owner's turn was
 * outstanding - its prompt was on disk at close time, its reply was not - and that turn then
 * committed with one transcript, no dangling parent and no duplicate id. The server holds the in-flight reply behind a release file, so that reply cannot commit before
 * the closer has exited; the report prints the counts either side of the close rather than a
 * single verdict. That is absence of a collision in this shape - it does not
 * show what happens when the closing side owns a writer, an artifact root or rewrite debt,
 * because a resumed TUI close owns none of them.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PtySession } from "@gajae-code/natives";

const reply = "probe-reply";
let responses = 0;
let releasePath: string | null = null;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const url = new URL(request.url);
		if (!url.pathname.endsWith("/chat/completions")) {
			return new Response("{}", { headers: { "content-type": "application/json" } });
		}
		await request.text();
		// The second and later replies are held back, so the close is provably ordered before the
		// in-flight reply instead of racing a 50 ms window.
		responses += 1;
		if (responses > 1) {
			// Hold the in-flight reply until the closer has provably exited, so the ordering the
			// probe reports is enforced rather than inferred from a sleep.
			for (let waited = 0; waited < 60_000; waited += 50) {
				if (releasePath && fsSync.existsSync(releasePath)) break;
				await Bun.sleep(50);
			}
		}
		const chunk = (delta: object, finish: string | null) =>
			`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		return new Response(`${chunk({ role: "assistant", content: reply }, null) + chunk({}, "stop")}data: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-close-probe-"));
releasePath = path.join(root, "closer-exited");
const sessions = path.join(root, "sessions");
const agent = path.join(root, "agent");
const cwd = path.join(root, "workspace");
for (const directory of [sessions, agent, cwd]) await fs.mkdir(directory, { recursive: true });
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
const start = (extra: string[] = []) => {
	const pty = new PtySession();
	let screen = "";
	const done = pty.start(
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
			].join(" "),
			shell: "bash",
			cwd,
			env,
			unsetEnv: Object.keys(process.env).filter(key => !(key in env)),
			cols: 120,
			rows: 36,
			timeoutMs: 120_000,
		},
		(_error, chunk) => {
			if (chunk) screen += chunk;
		},
	);
	return { pty, done, screen: () => screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") };
};
const sleep = (ms: number) => Bun.sleep(ms);
const transcriptFiles = async () =>
	((await fs.readdir(sessions, { recursive: true }).catch(() => [])) as string[]).filter(entry =>
		entry.endsWith(".jsonl"),
	);
const transcript = async () => {
	const files = await transcriptFiles();
	return files.length === 1 ? Bun.file(path.join(sessions, files[0]!)).text() : "";
};

const replyCount = async () => (await transcript()).split(reply).length - 1;

const owner = start();
await sleep(9_000);
owner.pty.write("opening-turn\r");
// The reply, not the prompt echo, is what proves the turn committed: the prompt is written before
// the model call, so waiting for it would let the probe report success mid-turn.
for (let i = 0; i < 300 && (await replyCount()) < 1; i++) await sleep(100);
const sessionId = (JSON.parse((await transcript()).split("\n")[0]!) as { id: string }).id;

const closer = start(["--resume", sessionId]);
await sleep(9_000);
// The closer must have attached to this session, not booted a fresh one: the resumed history is
// what it renders.
const closerOpenedSession = closer.screen().includes("opening-turn");

// The owner starts a turn and the second process quits while that append is still in flight. The
// close is issued before the reply exists, which the report records as closeBeforeReply.
const repliesBeforeTurn = await replyCount();
owner.pty.write("in-flight-turn\r");
await sleep(50);
closer.pty.write("/quit\r");
// Sampled after the quit is issued and before waiting for the exit, so the ordering claim rests
// on what was observed at close time rather than on an inference across a sleep.
const repliesAtClose = await replyCount();
// The prompt is persisted before the model call, so its presence at close time is what makes
// the doc sentence "closes while the owner's turn is outstanding" checkable.
const promptAtClose = (await transcript()).includes("in-flight-turn");
const closerResult = await closer.done;
// The server has been holding the in-flight reply; release it only now, so the commit it
// produces necessarily follows this exit.
await fs.writeFile(releasePath, "exited\n");
for (let i = 0; i < 300 && (await replyCount()) <= repliesAtClose; i++) await sleep(100);
const repliesAfterClose = await replyCount();

const text = await transcript();
const entries = text
	.split("\n")
	.slice(1)
	.filter(line => line.trim().length > 0)
	.map(line => JSON.parse(line) as { id?: string; parentId?: string });
const ids = new Set(entries.map(entry => entry.id));
const report = {
	closerOpenedSession,
	closerExitCode: closerResult.exitCode ?? null,
	closerCancelled: closerResult.cancelled,
	closerTimedOut: closerResult.timedOut,
	closerExited: closerResult.exitCode === 0 && !closerResult.cancelled && !closerResult.timedOut,
	repliesBeforeTurn,
	repliesAtClose,
	repliesAfterClose,
	promptAtClose,
	closerExitedBeforeReply: promptAtClose && repliesAtClose === repliesBeforeTurn && repliesAfterClose > repliesAtClose,
	transcriptFiles: (await transcriptFiles()).length,
	entries: entries.length,
	danglingParents: entries.filter(entry => typeof entry.parentId === "string" && !ids.has(entry.parentId)).length,
	duplicateIds: entries.length - ids.size,
};
console.log(JSON.stringify(report));
owner.pty.write("/quit\r");
await Promise.race([owner.done, sleep(15_000)]);
server.stop(true);
await fs.rm(root, { recursive: true, force: true });
process.exit(0);
