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

type Tui = {
	pty: PtySession;
	done: Promise<PtyRunResult>;
	screen: () => string;
	mark: () => number;
	/** Raw bytes received so far; grows on every render. */
	received: () => number;
};

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
	return { pty, done, screen: () => strip(raw), mark: () => strip(raw).length, received: () => raw.length };
}

async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	label: string,
	evidence?: () => string | Promise<string>,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${label}${evidence ? `\n${await evidence()}` : ""}`);
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
const screenSince = (tui: Tui, mark: number) => `--- screen since the input ---\n${since(tui, mark).slice(-3_000)}`;

/**
 * Best effort: return once the TUI has written nothing for `quietMs`, so a render or
 * status from the previous step is not still pending when the next input arrives.
 */
async function quiet(tui: Tui, quietMs = 400, maxMs = 5_000) {
	const deadline = Date.now() + maxMs;
	let seen = tui.received();
	let stillSince = Date.now();
	while (Date.now() < deadline) {
		await Bun.sleep(50);
		const now = tui.received();
		if (now !== seen) {
			seen = now;
			stillSince = Date.now();
		} else if (Date.now() - stillSince >= quietMs) return;
	}
}

type Added = Entry & Record<string, unknown>;

/** Entries appended to `file` after its first `count` entries. */
async function addedSince(file: string, count: number): Promise<Added[]> {
	return (await readTranscript(file)).entries.slice(count) as Added[];
}

/**
 * Submit one slash command and wait until its effect is in the transcript.
 *
 * Status lines are no completion signal: `showStatus` rewrites the previous status in
 * place, and on Linux the config hot-reload watcher reports "Configuration reloaded"
 * after `/model` writes the config. That can replace a later command's status before
 * any frame shows it.
 */
async function sendCommand(tui: Tui, file: string, command: string, applied: (added: Added[]) => boolean) {
	await quiet(tui);
	const count = (await readTranscript(file)).entries.length;
	const mark = tui.mark();
	tui.pty.write(`${command}\r`);
	await waitFor(
		async () => applied(await addedSince(file, count)),
		30_000,
		`${command} in the transcript`,
		async () =>
			`${screenSince(tui, mark)}\n--- transcript entries added ---\n${(await addedSince(file, count))
				.map(entry => JSON.stringify(entry).slice(0, 240))
				.join("\n")}`,
	);
	await quiet(tui);
	expect(since(tui, mark)).not.toMatch(REFUSAL);
	return addedSince(file, count);
}

const modelChange = (model: string) => (added: Added[]) =>
	added.some(entry => entry.type === "model_change" && entry.model === model);
const tierChange = (serviceTier: string | null) => (added: Added[]) =>
	added.some(entry => entry.type === "service_tier_change" && entry.serviceTier === serviceTier);
const operatorEffort = (added: Added[]) =>
	added.some(entry => entry.type === "thinking_level_change" && entry.operatorIntent === true);

/**
 * Drive `/fork`, pick the user message `upPresses` above the newest one, and return the
 * successor's transcript once it is on disk. The selected prompt is restored into the
 * editor and must not be submitted.
 */
/**
 * `parentSession` is an opaque lineage string (docs/session.md): the shared route records the
 * source id, the direct route the source's transcript path. Either names the source.
 */
function namesParent(parentSession: string | undefined, sourceId: string, sourceFile: string): boolean {
	return (
		parentSession === sourceId ||
		(parentSession !== undefined && path.resolve(parentSession) === path.resolve(sourceFile))
	);
}

async function forkFrom(tui: Tui, sessions: string, source: string, upPresses: number, selected: string) {
	const sourceBytes = Buffer.from(await Bun.file(source).arrayBuffer());
	const sourceHeader = (await readTranscript(source)).header;
	const before = new Set(await transcriptFiles(sessions));
	const mark = tui.mark();
	tui.pty.write("/fork\r");
	// The picker's cursor row, not the prompt text that the chat history also shows.
	await waitFor(
		() => /›\s*fork-/.test(since(tui, mark)),
		30_000,
		"fork selector",
		() => screenSince(tui, mark),
	);
	for (let index = 0; index < upPresses; index++) {
		tui.pty.write(UP);
		await Bun.sleep(150);
	}
	const cursorOn = new RegExp(`›\\s*${selected}\\b`);
	await waitFor(
		() => cursorOn.test(since(tui, mark)),
		30_000,
		`fork selector on ${selected}`,
		() => screenSince(tui, mark),
	);
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
				if (namesParent((await readTranscript(file)).header.parentSession, sourceHeader.id, source))
					successor = file;
			}
			return successor !== undefined;
		},
		30_000,
		"fork successor transcript",
		async () => `${screenSince(tui, mark)}\n--- transcripts ---\n${(await transcriptFiles(sessions)).join("\n")}`,
	);
	await waitFor(() => /Forked to a new session/.test(since(tui, mark)), 30_000, "fork confirmation");
	expect(since(tui, mark)).not.toMatch(REFUSAL);
	const fork = await readTranscript(successor!);
	expect(fork.header.id).not.toBe(sourceHeader.id);
	expect(path.basename(successor!)).not.toBe(path.basename(source));
	expect(namesParent(fork.header.parentSession, sourceHeader.id, source)).toBe(true);
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
	await sendCommand(tui, file, "/model fake/fake-model", modelChange("fake/fake-model"));
	await sendCommand(tui, file, "/model fake/fake-model-b", modelChange("fake/fake-model-b"));
	// On, then off: whatever tier the session starts with, both are changes.
	await sendCommand(tui, file, "/fast on", tierChange("priority"));
	await sendCommand(tui, file, "/fast off", tierChange(null));
	await sendCommand(tui, file, "/effort low", operatorEffort);
	const high = await sendCommand(tui, file, "/effort high", operatorEffort);
	// The effective level the control recorded after clamping to the model.
	const effortEntry = high.findLast(entry => entry.type === "thinking_level_change" && entry.operatorIntent === true);
	expect(effortEntry).toBeDefined();
	const effort = effortEntry!.thinkingLevel;
	await sendCommand(tui, file, `/rename renamed-${tag}`, added =>
		added.some(entry => JSON.stringify(entry).includes(`"title":"renamed-${tag}"`)),
	);
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

/**
 * An isolated root with the fake model. `ownership` writes `session.ownership.mode` into the
 * operator's config (the setting is global-only; the env override can only lower it), and
 * `branchSummaries` makes `/tree` ask whether to summarize the branch it leaves.
 */
async function fixture(options: { ownership?: "observe" | "enforce"; branchSummaries?: boolean } = {}) {
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
	await Bun.write(
		path.join(agent, "config.yml"),
		`compaction:\n  keepRecentTokens: 1\n${options.branchSummaries ? "branchSummary:\n  enabled: true\n" : ""}${
			options.ownership ? `session:\n  ownership:\n    mode: ${options.ownership}\n` : ""
		}`,
	);
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

describe.skipIf(process.platform === "win32")("/fork in a single interactive TUI", () => {
	it("forks from the newest and the first prompt after shared-append messages", async () => {
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
			await sendCommand(tui, source, "/model fake/fake-model-b", modelChange("fake/fake-model-b"));
			// The fork never writes the source's workflow state directory.
			const sourceWorkflow = sessionRoot(cwd, sourceId);
			const sourceWorkflowBefore = await settledSnapshot(sourceWorkflow);
			const first = await forkFrom(tui, sessions, source, 0, "fork-p2");
			expect(namesParent(first.header.parentSession, sourceId, source)).toBe(true);
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
	}, 240_000);

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
				expect(since(tui, mark)).toMatch(
					/Cannot fork this session: another gjc process has written to this session/,
				);
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

const DOWN = "\x1b[B";

/**
 * Drive `/tree`: move the cursor with `keys` until `cursorOn` shows it on the target, select it,
 * and answer "Summarize branch?" (the fixture enables branch summaries). Returns the added entries.
 */
async function navigateTree(tui: Tui, file: string, keys: string[], cursorOn: RegExp, summarize: boolean) {
	await quiet(tui);
	const count = (await readTranscript(file)).entries.length;
	const mark = tui.mark();
	tui.pty.write("/tree\r");
	await waitFor(
		() => /Session Tree/.test(since(tui, mark)),
		30_000,
		"tree selector",
		() => screenSince(tui, mark),
	);
	for (const key of keys) {
		tui.pty.write(key);
		await Bun.sleep(150);
	}
	await waitFor(
		() => cursorOn.test(since(tui, mark)),
		30_000,
		"tree cursor on the target",
		() => screenSince(tui, mark),
	);
	tui.pty.write("\r");
	await waitFor(
		() => /Summarize branch\?/.test(since(tui, mark)),
		30_000,
		"summary choice",
		() => screenSince(tui, mark),
	);
	if (summarize) {
		tui.pty.write(DOWN);
		await Bun.sleep(150);
	}
	tui.pty.write("\r");
	return { mark, count };
}

/** `command` is refused as a shared-session mutation naming `operation`, before any transcript write. */
async function refusedBeforeEffect(tui: Tui, file: string, command: string, operation: string) {
	await quiet(tui);
	const bytes = Buffer.from(await Bun.file(file).arrayBuffer());
	const mark = tui.mark();
	tui.pty.write(`${command}\r`);
	await waitFor(
		() => since(tui, mark).includes(`Shared session mutation requires transaction admission: ${operation}`),
		30_000,
		`${command} refusal`,
		() => screenSince(tui, mark),
	);
	await quiet(tui);
	expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(bytes);
}

// Single-owner step 9 (design §7.2 #7): one TUI, no peer. Under enforce it holds its session's claim
// alone, so after its first messages every control takes effect. Under observe it still publishes
// through the shared layer, whose bars refuse the rewrite controls before any effect.
describe.skipIf(process.platform === "win32")("single-TUI control matrix", () => {
	it("enforce: star, rename, rewind, tree summary, compaction, move, /fork and /drop all take effect", async () => {
		const { root, cwd, agent, sessions, cli, model } = await fixture({ ownership: "enforce", branchSummaries: true });
		try {
			const tui = startTui({ cli, cwd, root, agent });
			await ready(tui);
			tui.pty.write("fork-m1\r");
			const source = await only(sessions);
			await replied(source, "fork-m1");
			tui.pty.write("fork-m2\r");
			await replied(source, "fork-m2");
			const sourceId = (await readTranscript(source)).header.id;

			await sendCommand(tui, source, "/star", added =>
				added.some(entry => entry.type === "header_patch" && JSON.stringify(entry).includes('"starred":true')),
			);
			await sendCommand(tui, source, "/rename matrix-renamed", added =>
				added.some(entry => JSON.stringify(entry).includes('"title":"matrix-renamed"')),
			);

			// Rewind: back to the first reply without a summary, then a new prompt branches there.
			const rewind = await navigateTree(tui, source, [UP, UP], /›\s*▸\s*assistant: fork-m1-reply/, false);
			await waitFor(() => /Navigated to selected point/.test(since(tui, rewind.mark)), 30_000, "rewind");
			expect(since(tui, rewind.mark)).not.toMatch(REFUSAL);
			tui.pty.write("fork-m3\r");
			await replied(source, "fork-m3");
			const branched = (await readTranscript(source)).entries;
			const m1Reply = messagesWith(branched, "fork-m1-reply")[0]!;
			const m2 = messagesWith(branched, "fork-m2")[0]!;
			const byId = new Map(branched.map(entry => [entry.id, entry]));
			const ancestors: (string | undefined)[] = [];
			for (let at = messagesWith(branched, "fork-m3")[0]?.parentId; at; at = byId.get(at)?.parentId)
				ancestors.push(at);
			expect(ancestors).toContain(m1Reply.id);
			expect(ancestors).not.toContain(m2.id);

			// Tree summary: back to the second reply, summarizing the branch it leaves.
			const summary = await navigateTree(tui, source, [DOWN, DOWN], /›[\s│]*▸?\s*assistant: fork-m2-reply/, true);
			await waitFor(
				async () => (await addedSince(source, summary.count)).some(entry => entry.type === "branch_summary"),
				60_000,
				"branch summary entry",
				() => screenSince(tui, summary.mark),
			);
			expect(since(tui, summary.mark)).not.toMatch(REFUSAL);

			tui.pty.write("/compact\r");
			await waitFor(
				async () => (await readTranscript(source)).entries.some(entry => entry.type === "compaction"),
				60_000,
				"compaction entry",
			);

			// Move Session: the transcript leaves this workspace's session directory.
			const movedCwd = path.join(root, "moved");
			await fs.mkdir(movedCwd, { recursive: true });
			const movedSessions = SessionManager.getDefaultSessionDirReadOnly(movedCwd, agent);
			const moveMark = tui.mark();
			tui.pty.write(`/move ${movedCwd}\r`);
			let moved: string | undefined;
			await waitFor(
				async () => {
					moved = await transcriptById(movedSessions, sourceId);
					return moved !== undefined && !(await Bun.file(source).exists());
				},
				30_000,
				"the moved transcript",
				() => screenSince(tui, moveMark),
			);
			expect(since(tui, moveMark)).not.toMatch(REFUSAL);
			tui.pty.write("fork-m4\r");
			await replied(moved!, "fork-m4");
			// The move kept the star and the title.
			expect(await Bun.file(moved!).text()).toContain('"starred":true');
			expect(await Bun.file(moved!).text()).toContain('"title":"matrix-renamed"');

			// /fork from the second prompt, then /drop the fork: the source stays.
			// The selector lists every user message, the rewound-from branch's fork-m3 included.
			const fork = await forkFrom(tui, movedSessions, moved!, 2, "fork-m2");
			expect(namesParent(fork.header.parentSession, sourceId, moved!)).toBe(true);
			await submitRestored(tui, fork.file, "fork-m2");
			await replied(fork.file, "fork-m2");
			await quiet(tui);
			const dropMark = tui.mark();
			tui.pty.write("/drop\r");
			await waitFor(
				async () => !(await Bun.file(fork.file).exists()),
				30_000,
				"the dropped fork",
				() => screenSince(tui, dropMark),
			);
			await waitFor(() => /Session dropped/.test(since(tui, dropMark)), 30_000, "drop confirmation");
			expect(since(tui, dropMark)).not.toMatch(REFUSAL);
			expect(Buffer.from(await Bun.file(moved!).arrayBuffer())).toEqual(fork.sourceBytes);
		} finally {
			await model.server.stop(true);
		}
	}, 240_000);

	it("observe: star, tree summary, move and /drop refuse before any effect", async () => {
		const { root, cwd, agent, sessions, cli, model } = await fixture({ ownership: "observe", branchSummaries: true });
		try {
			const tui = startTui({ cli, cwd, root, agent });
			await ready(tui);
			tui.pty.write("fork-o1\r");
			const source = await only(sessions);
			await replied(source, "fork-o1");
			tui.pty.write("fork-o2\r");
			await replied(source, "fork-o2");

			await refusedBeforeEffect(tui, source, "/star", "set session starred");
			const bytes = Buffer.from(await Bun.file(source).arrayBuffer());
			const summary = await navigateTree(tui, source, [UP, UP], /›\s*▸\s*assistant: fork-o1-reply/, true);
			await waitFor(
				() => since(tui, summary.mark).includes("requires transaction admission: summarize branch"),
				30_000,
				"tree summary refusal",
				() => screenSince(tui, summary.mark),
			);
			await quiet(tui);
			expect(Buffer.from(await Bun.file(source).arrayBuffer())).toEqual(bytes);
			const movedCwd = path.join(root, "moved");
			await fs.mkdir(movedCwd, { recursive: true });
			await refusedBeforeEffect(tui, source, `/move ${movedCwd}`, "move session");
			await refusedBeforeEffect(tui, source, "/drop", "drop session");
			expect(await transcriptFiles(sessions)).toEqual([source]);
		} finally {
			await model.server.stop(true);
		}
	}, 240_000);
});
