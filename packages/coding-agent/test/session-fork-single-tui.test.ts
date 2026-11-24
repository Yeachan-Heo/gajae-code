import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PtyRunResult } from "@gajae-code/natives";
import { PtySession } from "@gajae-code/natives";
import { withTimeout } from "@gajae-code/utils";
import { sessionRoot } from "../src/gjc-runtime/session-layout";
import { SessionManager } from "../src/session/session-manager";

// A single interactive TUI, no peer process: `/fork` must work after messages were
// published through root shared append (v0.21.0-v0.22.0 refused it with
// "Shared session mutation requires transaction admission: prepare branched session").
// Real TUIs in PTYs, an isolated HOME and agent dir, and a local SSE model server.

const roots: string[] = [];
const live: Array<{ pty: PtySession; done: Promise<PtyRunResult> }> = [];

afterEach(async () => {
	const processes = live.splice(0);
	for (const { pty } of processes) {
		try {
			pty.kill();
		} catch {}
	}
	await withTimeout(Promise.allSettled(processes.map(process => process.done)), 20_000, "PTY cleanup did not settle");
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const UP = "\x1b[A";

type ChatBody = { model?: string; messages?: { role?: string; content?: unknown }[] };

/** Replies `<latest user text>-reply` and records which model each turn used. */
function startFakeModel() {
	const turns: { model: string | undefined; prompt: string }[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			if (!url.pathname.endsWith("/chat/completions"))
				return new Response("{}", { headers: { "content-type": "application/json" } });
			const body = (await request.json()) as ChatBody;
			const latestUser = body.messages?.findLast(message => message.role === "user");
			const text = JSON.stringify(latestUser?.content) ?? "";
			const prompt = /fork-[a-z0-9-]+/.exec(text)?.[0] ?? "background";
			turns.push({ model: body.model, prompt });
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chunk",
					object: "chat.completion.chunk",
					created: 1,
					model: body.model ?? "fake-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			const reply = { role: "assistant", content: `${prompt}-reply` };
			return new Response(`${chunk(reply, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	if (server.port === undefined) throw new Error("fake model server did not bind a port");
	return { server, port: server.port, turns };
}

async function writeModelsConfig(agent: string, port: number) {
	const model = (id: string) => `      - id: ${id}
        name: ${id}
        reasoning: true
        contextWindow: 200000
        maxTokens: 1000
        input: [text]
        output: [text]
`;
	await Bun.write(
		path.join(agent, "models.yml"),
		`providers:
  fake:
    baseUrl: http://127.0.0.1:${port}/v1
    apiKey: test-key
    api: openai-completions
    models:
${model("fake-model")}${model("fake-model-b")}`,
	);
}

type Tui = { pty: PtySession; done: Promise<PtyRunResult>; screen: () => string; mark: () => number };

function startTui(options: { cli: string; cwd: string; root: string; agent: string; extra?: string[] }): Tui {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		HOME: options.root,
		TERM: "xterm-256color",
		GJC_CODING_AGENT_DIR: options.agent,
		GJC_AUTOMATION: "1",
		GJC_NOTIFY: "off",
	};
	const pty = new PtySession();
	let raw = "";
	const done = pty.start(
		{
			command: [
				process.execPath,
				options.cli,
				"--no-mcp",
				"--no-lsp",
				"--no-rules",
				"--no-title",
				"--model",
				"fake/fake-model",
				...(options.extra ?? []),
			].join(" "),
			shell: "bash",
			cwd: options.cwd,
			env,
			unsetEnv: Object.keys(process.env).filter(key => !(key in env)),
			cols: 120,
			rows: 36,
			timeoutMs: 240_000,
		},
		(_error, chunk) => {
			if (chunk) raw += chunk;
		},
	);
	live.push({ pty, done });
	return { pty, done, screen: () => strip(raw), mark: () => strip(raw).length };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}

type Entry = { type?: string; id?: string; parentId?: string | null; customType?: string; message?: unknown };
type Header = { type: "session"; id: string; parentSession?: string; title?: string };

async function transcriptFiles(sessions: string): Promise<string[]> {
	const listed = (await fs.readdir(sessions, { recursive: true }).catch(() => [])) as string[];
	return listed
		.filter(entry => entry.endsWith(".jsonl") && !entry.split(path.sep).some(part => part.startsWith(".")))
		.map(entry => path.join(sessions, entry));
}

async function readTranscript(file: string): Promise<{ header: Header; entries: Entry[] }> {
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.trim().length > 0);
	return {
		header: JSON.parse(lines[0]!) as Header,
		entries: lines.slice(1).flatMap(line => {
			try {
				return [JSON.parse(line) as Entry];
			} catch {
				return [];
			}
		}),
	};
}

async function transcriptById(sessions: string, id: string): Promise<string | undefined> {
	for (const file of await transcriptFiles(sessions)) {
		if ((await readTranscript(file)).header.id === id) return file;
	}
	return undefined;
}

/** Message entries whose serialized form carries the text as a complete JSON string. */
const messagesWith = (entries: Entry[], text: string) =>
	entries.filter(entry => entry.type === "message" && JSON.stringify(entry).includes(`"${text}"`));

async function hasMessage(file: string, text: string): Promise<boolean> {
	const raw = await Bun.file(file).text();
	if (!raw.includes(`"${text}"`)) return false;
	return messagesWith((await readTranscript(file)).entries, text).length > 0;
}

const replied = (file: string, prompt: string) =>
	waitFor(() => hasMessage(file, `${prompt}-reply`), 60_000, `reply to ${prompt}`);

const ready = (tui: Tui) => waitFor(() => /v\d+\.\d+\.\d+/.test(tui.screen()), 60_000, "TUI footer");

const REFUSAL = /requires transaction admission|Fork failed|Error:/;

/** Screen output produced after `mark`, so earlier text cannot satisfy a check. */
const since = (tui: Tui, mark: number) => tui.screen().slice(mark);

async function sendCommand(tui: Tui, command: string, expected: RegExp) {
	const mark = tui.mark();
	tui.pty.write(`${command}\r`);
	await waitFor(() => expected.test(since(tui, mark)), 30_000, `${command} output`);
	expect(since(tui, mark)).not.toMatch(REFUSAL);
}

/**
 * Drive `/fork`, pick the user message `upPresses` above the newest one, and return the
 * successor's transcript once it is on disk. The selected prompt is restored into the
 * editor and must not be submitted.
 */
async function forkFrom(tui: Tui, sessions: string, source: string, upPresses: number, selected: string) {
	const sourceBytes = Buffer.from(await Bun.file(source).arrayBuffer());
	const sourceHeader = (await readTranscript(source)).header;
	const before = new Set(await transcriptFiles(sessions));
	const mark = tui.mark();
	tui.pty.write("/fork\r");
	await waitFor(() => since(tui, mark).includes(selected), 30_000, "fork selector");
	for (let index = 0; index < upPresses; index++) {
		tui.pty.write(UP);
		await Bun.sleep(150);
	}
	tui.pty.write("\r");
	let successor: string | undefined;
	await waitFor(
		async () => {
			if (REFUSAL.test(since(tui, mark)))
				throw new Error(
					`fork refused: ${/.{0,160}(requires transaction admission|Fork failed|Error:).{0,200}/s.exec(since(tui, mark))?.[0]}`,
				);
			for (const file of await transcriptFiles(sessions)) {
				if (before.has(file)) continue;
				if ((await readTranscript(file)).header.parentSession === sourceHeader.id) successor = file;
			}
			return successor !== undefined;
		},
		30_000,
		"fork successor transcript",
	);
	await waitFor(() => /Forked to a new session/.test(since(tui, mark)), 30_000, "fork confirmation");
	expect(since(tui, mark)).not.toMatch(REFUSAL);
	const fork = await readTranscript(successor!);
	expect(fork.header.id).not.toBe(sourceHeader.id);
	expect(path.basename(successor!)).not.toBe(path.basename(source));
	expect(fork.header.parentSession).toBe(sourceHeader.id);
	// The selected prompt is restored for editing, not submitted: still absent once the
	// post-fork redraw has settled and the editor shows it.
	await waitFor(() => new RegExp(`>\\s*${selected}\\b`).test(since(tui, mark)), 30_000, "restored prompt in editor");
	await Bun.sleep(1_500);
	const settled = await readTranscript(successor!);
	expect(messagesWith(settled.entries, selected)).toHaveLength(0);
	expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(sourceBytes);
	return { file: successor!, header: fork.header, entries: settled.entries, sourceBytes };
}

/** Press Enter once on the restored prompt; it must land exactly once, as typed. */
async function submitRestored(tui: Tui, file: string, prompt: string) {
	tui.pty.write("\r");
	await waitFor(() => hasMessage(file, prompt), 30_000, `submitted ${prompt}`);
	const submitted = messagesWith((await readTranscript(file)).entries, prompt) as (Entry & {
		message?: { role?: string; content?: unknown };
	})[];
	expect(submitted).toHaveLength(1);
	expect(submitted[0]!.message?.role).toBe("user");
	expect(JSON.stringify(submitted[0]!.message?.content)).toContain(`"${prompt}"`);
}

/**
 * `/model`, `/fast`, `/effort`, `/rename` and a normal prompt, each taking effect in
 * `file`. Each control is driven through a change so it must write a new entry.
 */
async function runControls(
	tui: Tui,
	file: string,
	model: { turns: { model?: string; prompt: string }[] },
	tag: string,
) {
	const before = (await readTranscript(file)).entries.length;
	await sendCommand(tui, "/model fake/fake-model", /fake-model/);
	await sendCommand(tui, "/model fake/fake-model-b", /fake-model-b/);
	await sendCommand(tui, "/fast off", /Fast mode/i);
	await sendCommand(tui, "/fast on", /Fast mode/i);
	await sendCommand(tui, "/effort low", /effort/i);
	const effortMark = tui.mark();
	await sendCommand(tui, "/effort high", /Effective effort: \w+/);
	const effort = /Effective effort: \w+/.exec(since(tui, effortMark))![0];
	await sendCommand(tui, `/rename renamed-${tag}`, new RegExp(`renamed-${tag}`));
	const prompt = `fork-${tag}-after`;
	tui.pty.write(`${prompt}\r`);
	await replied(file, prompt);
	expect(model.turns.findLast(turn => turn.prompt === prompt)?.model).toBe("fake-model-b");
	const added = (await readTranscript(file)).entries.slice(before) as (Entry & Record<string, unknown>)[];
	expect(added.findLast(entry => entry.type === "model_change")?.model).toBe("fake/fake-model-b");
	// The fake model's effective level is the same in the source and every fork; the
	// control's own entry is what proves it was admitted.
	expect(added.filter(entry => entry.type === "thinking_level_change" && entry.operatorIntent === true)).toHaveLength(
		2,
	);
	expect(added.some(entry => entry.type === "service_tier_change")).toBe(true);
	// A rename is a header patch line after the header, not a header rewrite.
	expect(await Bun.file(file).text()).toContain(`"title":"renamed-${tag}"`);
	return { effort };
}

/** Every file under a directory with its bytes, or null when the directory is absent. */
async function treeSnapshot(dir: string): Promise<Record<string, string> | null> {
	const listed = (await fs.readdir(dir, { recursive: true }).catch(() => null)) as string[] | null;
	if (listed === null) return null;
	const files: Record<string, string> = {};
	for (const name of listed.sort()) {
		const file = path.join(dir, name);
		// Transient lock files can vanish between the listing and the read; the settle
		// loop compares two whole snapshots, so a skipped file cannot hide a change.
		try {
			if ((await fs.stat(file)).isFile())
				files[name] = Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return files;
}

/**
 * The directory once it has stopped changing: the source's runtime marker is written in
 * the background after its turn ends, and that tail must not be blamed on a later fork.
 */
async function settledSnapshot(dir: string): Promise<Record<string, string> | null> {
	let previous = await treeSnapshot(dir);
	for (let attempt = 0; attempt < 30; attempt++) {
		await Bun.sleep(1_000);
		const next = await treeSnapshot(dir);
		if (Bun.deepEquals(next, previous)) return next;
		previous = next;
	}
	throw new Error(`${dir} did not settle`);
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-fork-single-tui-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agent = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	const sessions = SessionManager.getDefaultSessionDirReadOnly(cwd, agent);
	const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
	const model = startFakeModel();
	await writeModelsConfig(agent, model.port);
	// Keep almost nothing recent so a manual /compact of this short session has work to do.
	await Bun.write(path.join(agent, "config.yml"), "compaction:\n  keepRecentTokens: 1\n");
	return { root, cwd, agent, sessions, cli, model };
}

async function only(sessions: string): Promise<string> {
	let file: string | undefined;
	await waitFor(
		async () => {
			const files = await transcriptFiles(sessions);
			file = files.length === 1 ? files[0] : undefined;
			return file !== undefined;
		},
		60_000,
		"the first transcript",
	);
	return file!;
}

/**
 * Known failing until the /fork fix lands: the test passes under it.failing only when the
 * run stops on exactly the reported refusal, so a harness break or timeout is not
 * mistaken for the reproduction. Flip to a plain it() with the fix.
 */
function reproducesRefusal(refusal: RegExp, run: () => Promise<void>): () => Promise<void> {
	return async () => {
		try {
			await run();
		} catch (error) {
			if (refusal.test(error instanceof Error ? error.message : String(error))) throw error;
		}
	};
}

describe.skipIf(process.platform === "win32")("/fork in a single interactive TUI", () => {
	it.failing(
		"forks from the newest and the first prompt after shared-append messages",
		reproducesRefusal(/requires transaction admission: prepare branched session/, async () => {
			const { root, cwd, agent, sessions, cli, model } = await fixture();
			try {
				const tui = startTui({ cli, cwd, root, agent });
				await ready(tui);
				tui.pty.write("fork-p1\r");
				const source = await only(sessions);
				await replied(source, "fork-p1");
				tui.pty.write("fork-p2\r");
				await replied(source, "fork-p2");
				const sourceId = (await readTranscript(source)).header.id;

				// Fork 1: the newest prompt. Model selection survives the fork.
				await sendCommand(tui, "/model fake/fake-model-b", /fake-model-b/);
				// The fork never writes the source's workflow state directory.
				const sourceWorkflow = sessionRoot(cwd, sourceId);
				const sourceWorkflowBefore = await settledSnapshot(sourceWorkflow);
				const first = await forkFrom(tui, sessions, source, 0, "fork-p2");
				expect(first.header.parentSession).toBe(sourceId);
				expect(messagesWith(first.entries, "fork-p1")).toHaveLength(1);
				expect(messagesWith(first.entries, "fork-p1-reply")).toHaveLength(1);
				expect(first.entries.some(entry => entry.type === "model_change")).toBe(true);
				// Submitting the restored prompt lands it in the fork, on the selected model.
				await submitRestored(tui, first.file, "fork-p2");
				await replied(first.file, "fork-p2");
				expect(model.turns.at(-1)).toEqual({ model: "fake-model-b", prompt: "fork-p2" });
				expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(first.sourceBytes);
				const fork1Controls = await runControls(tui, first.file, model, "fork1");

				// Fork 2: the first prompt, from the fork the TUI is now on.
				const second = await forkFrom(tui, sessions, first.file, 2, "fork-p1");
				expect(messagesWith(second.entries, "fork-p1")).toHaveLength(0);
				expect(messagesWith(second.entries, "fork-p2")).toHaveLength(0);
				await submitRestored(tui, second.file, "fork-p1");
				await replied(second.file, "fork-p1");
				expect(Buffer.from(await Bun.file(first.file).arrayBuffer())).toEqual(second.sourceBytes);
				expect(await runControls(tui, second.file, model, "fork2")).toEqual(fork1Controls);
				expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(first.sourceBytes);
				expect(await treeSnapshot(sourceWorkflow)).toEqual(sourceWorkflowBefore);

				// The source stays fully usable after being forked, and forks again once resumed.
				tui.pty.kill();
				await tui.done.catch(() => undefined);
				const resumed = startTui({ cli, cwd, root, agent, extra: ["--resume", sourceId] });
				await ready(resumed);
				expect(await runControls(resumed, source, model, "source")).toEqual(fork1Controls);
				expect(await transcriptById(sessions, sourceId)).toBe(source);
				// A real /compact, then a fork whose branch path carries the compaction.
				resumed.pty.write("/compact\r");
				await waitFor(
					async () => (await readTranscript(source)).entries.some(entry => entry.type === "compaction"),
					60_000,
					"compaction entry",
				);
				resumed.pty.write("fork-after-compact\r");
				await replied(source, "fork-after-compact");
				const resumedWorkflow = await settledSnapshot(sourceWorkflow);
				const third = await forkFrom(resumed, sessions, source, 0, "fork-after-compact");
				expect(third.entries.some(entry => entry.type === "compaction")).toBe(true);
				expect(messagesWith(third.entries, "fork-source-after")).toHaveLength(1);
				await submitRestored(resumed, third.file, "fork-after-compact");
				await replied(third.file, "fork-after-compact");
				expect(model.turns.at(-1)).toEqual({ model: "fake-model-b", prompt: "fork-after-compact" });
				expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(third.sourceBytes);
				expect(await treeSnapshot(sourceWorkflow)).toEqual(resumedWorkflow);
			} finally {
				await model.server.stop(true);
			}
		}),
		240_000,
	);

	it("never writes the shared transcript when /fork runs beside a peer TUI", async () => {
		const { root, cwd, agent, sessions, cli, model } = await fixture();
		try {
			const a = startTui({ cli, cwd, root, agent });
			await ready(a);
			a.pty.write("fork-a1\r");
			const shared = await only(sessions);
			await replied(shared, "fork-a1");
			const sessionId = (await readTranscript(shared)).header.id;
			const b = startTui({ cli, cwd, root, agent, extra: ["--resume", sessionId] });
			await ready(b);
			b.pty.write("fork-b1\r");
			await replied(shared, "fork-b1");
			a.pty.write("fork-a2\r");
			await replied(shared, "fork-a2");

			for (const tui of [a, b]) {
				const bytes = Buffer.from(await Bun.file(shared).arrayBuffer());
				const mark = tui.mark();
				tui.pty.write("/fork\r");
				// The peer's sibling branch is foreign to this opener: the fork is refused,
				// before the picker opens or, at the latest, when a prompt is selected.
				await waitFor(() => /Fork failed|›\s*fork-[ab]\d/.test(since(tui, mark)), 30_000, "fork refusal or picker");
				if (!/Fork failed/.test(since(tui, mark))) tui.pty.write("\r");
				await waitFor(() => /Fork failed/.test(since(tui, mark)), 30_000, "fork refusal");
				expect(since(tui, mark)).toMatch(/requires transaction admission: prepare branched session/);
				expect(await transcriptFiles(sessions)).toEqual([shared]);
				expect(Buffer.from(await Bun.file(shared).arrayBuffer())).toEqual(bytes);
			}
			// Both openers keep working on the shared session.
			a.pty.write("fork-a3\r");
			await replied(shared, "fork-a3");
			b.pty.write("fork-b2\r");
			await replied(shared, "fork-b2");
			expect(await transcriptFiles(sessions)).toEqual([shared]);
		} finally {
			await model.server.stop(true);
		}
	}, 240_000);
});
