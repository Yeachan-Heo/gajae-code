/**
 * Single-owner target model, end to end (session single-owner design §12 "Required test" and
 * §13.1 item 3): the process that runs turns holds the session claim, and remote clients attach
 * to its in-process SDK endpoint through the broker. They never open a second writer.
 *
 * Every process here is real: an interactive TUI in a PTY owns session S under ownership mode
 * `observe`, and again under `enforce`; `gjc acp` runs `initialize`, `session/load` S and a
 * prompt; `gjc sdk session send S --wait` sends another; a broker `session.resume` of S must reuse the TUI's endpoint. `gjc session
 * owners --json` probes the claim with the same HOME, and the
 * per-process ownership counters are read from the stats database after every process exited
 * cleanly, because a process only reports them at exit.
 *
 * Isolation: every child gets one environment from `buildChildEnv` rooted at an owned temp
 * directory (HOME, TMPDIR, XDG dirs and the agent dir), plus stubbed `open`/`xdg-open`. The model
 * is a local SSE fixture, and the broker is a fixture lease this process owns, so no child
 * spawns a detached broker and `cleanupFixtureRoots` stops it.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { PtyRunResult } from "@gajae-code/natives";
import { PtySession } from "@gajae-code/natives";
import { withTimeout } from "@gajae-code/utils";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { lifecycleRequestTimeoutMs } from "../src/sdk/broker/startup-budget";
import { SdkClient, type SdkRequestOptions } from "../src/sdk/client";
import { SessionManager } from "../src/session/session-manager";
import { buildChildEnv } from "./helpers/acp-child-env";
import {
	cleanupFixtureRoots,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const cleanupRoots: FixtureRootCleanup[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
/** Short-lived `gjc` commands still running; a failed test kills them before its root is removed. */
const cliChildren = new Set<Bun.Subprocess>();
const STDERR_CAP = 64 * 1024;

// Bun's default hook timeout (5 s) is shorter than closing a launched host and stopping the TUI,
// ACP and broker; a cut-short cleanup would orphan them, so the hook gets its own bound.
afterAll(async () => {
	try {
		await cleanupFixtureRoots(cleanupRoots);
	} finally {
		for (const server of servers.splice(0)) server.stop(true);
	}
}, 120_000);

async function killCliChildren(): Promise<void> {
	const children = [...cliChildren];
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await withTimeout(
		Promise.all(children.map(child => child.exited)),
		5_000,
		"gjc commands did not exit after SIGKILL",
	);
}

const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}

type ChatBody = { messages?: { role?: string; content?: unknown }[] };

interface FakeModel {
	port: number;
	prompts: string[];
	reached(prompt: string): Promise<void>;
	release(prompt: string): void;
	releaseAll(): void;
}

/**
 * Replies `<prompt>-reply` to the latest `attach-*` user prompt. A prompt listed in `holds` is
 * answered only after the test releases it, so the test can probe ownership while that turn is
 * in flight and its client process is still alive.
 */
function startFakeModel(holds: readonly string[]): FakeModel {
	const prompts: string[] = [];
	const gates = new Map(holds.map(prompt => [prompt, Promise.withResolvers<void>()]));
	const reached = new Map(holds.map(prompt => [prompt, Promise.withResolvers<void>()]));
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (!url.pathname.endsWith("/chat/completions"))
				return new Response("{}", { headers: { "content-type": "application/json" } });
			const body = (await request.json()) as ChatBody;
			const latestUser = body.messages?.findLast(message => message.role === "user");
			const prompt = /attach-[a-z]+-[a-z]+/.exec(JSON.stringify(latestUser?.content) ?? "")?.[0] ?? "background";
			prompts.push(prompt);
			const gate = gates.get(prompt);
			if (gate) {
				reached.get(prompt)?.resolve();
				try {
					await withTimeout(gate.promise, 60_000, `the test never released ${prompt}`);
				} catch {
					return new Response("held turn was never released", { status: 400 });
				}
			}
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chunk",
					object: "chat.completion.chunk",
					created: 1,
					model: "fake-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			const reply = { role: "assistant", content: `${prompt}-reply` };
			return new Response(`${chunk(reply, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	servers.push(server);
	if (server.port === undefined) throw new Error("fake model server did not bind a port");
	return {
		port: server.port,
		prompts,
		reached: (prompt: string) => reached.get(prompt)!.promise,
		release: (prompt: string) => gates.get(prompt)!.resolve(),
		releaseAll: () => {
			for (const gate of gates.values()) gate.resolve();
		},
	};
}

class RecordingClient implements Client {
	readonly updates: SessionNotification[] = [];
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}
	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}
	assistantText(): string {
		let text = "";
		for (const { update } of this.updates)
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
				text += update.content.text;
		return text;
	}
}

type CliResult = { exitCode: number; stdout: string; stderr: string };

/** Runs one short-lived `gjc` command in the fixture environment; output is captured through files. */
async function runGjc(
	env: Record<string, string>,
	cwd: string,
	args: string[],
	timeoutMs = 60_000,
): Promise<CliResult> {
	const capture = await fs.mkdtemp(path.join(env.TMPDIR!, "gjc-cli-capture-"));
	const stdoutPath = path.join(capture, "stdout");
	const stderrPath = path.join(capture, "stderr");
	const child = Bun.spawn([process.execPath, cli, ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: Bun.file(stdoutPath),
		stderr: Bun.file(stderrPath),
	});
	cliChildren.add(child);
	try {
		const exitCode = await withTimeout(child.exited, timeoutMs, `gjc ${args.join(" ")} did not exit`);
		return { exitCode, stdout: await Bun.file(stdoutPath).text(), stderr: await Bun.file(stderrPath).text() };
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await child.exited;
		cliChildren.delete(child);
		await fs.rm(capture, { recursive: true, force: true });
	}
}

type OwnerRow = { sessionId?: string; state?: string; holder?: { pid?: number; surface?: string } };

async function sessionOwners(env: Record<string, string>, cwd: string): Promise<OwnerRow[]> {
	const result = await runGjc(env, cwd, ["session", "owners", "--json"]);
	if (result.exitCode !== 0) throw new Error(`gjc session owners failed: ${result.stderr}${result.stdout}`);
	const report = JSON.parse(result.stdout) as { owners?: OwnerRow[] };
	return report.owners ?? [];
}

type TranscriptEntry = { type?: string; id?: string; parentId?: string | null };

async function transcriptFiles(sessions: string): Promise<string[]> {
	const listed = (await fs.readdir(sessions, { recursive: true }).catch(() => [])) as string[];
	return listed.filter(entry => entry.endsWith(".jsonl")).map(entry => path.join(sessions, entry));
}

async function readTranscript(file: string) {
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.trim().length > 0);
	const header = JSON.parse(lines[0]!) as { id?: string };
	const entries = lines.slice(1).flatMap(line => {
		try {
			return [JSON.parse(line) as TranscriptEntry];
		} catch {
			return [];
		}
	});
	return { header, entries };
}

/** Message entries whose serialized form holds `text` as a complete JSON string value. */
function messageEntries(entries: TranscriptEntry[], text: string): TranscriptEntry[] {
	const needle = `"${text}"`;
	return entries.filter(entry => entry.type === "message" && JSON.stringify(entry).includes(needle));
}

async function findFiles(root: string, name: string): Promise<string[]> {
	const listed = (await fs.readdir(root, { recursive: true }).catch(() => [])) as string[];
	return listed.filter(entry => path.basename(entry) === name).map(entry => path.join(root, entry));
}

type BrokerRow = { sessionId?: unknown; pid?: unknown; live?: unknown; endpointGeneration?: unknown };

/** One broker request over a fresh SDK client; returns the `result` payload, or the frame without one. */
async function brokerGlobal(
	discovery: { url: string; token: string },
	operation: string,
	input: Record<string, unknown>,
	options: SdkRequestOptions = {},
): Promise<Record<string, unknown>> {
	const client = await SdkClient.connect(discovery.url, discovery.token);
	try {
		const response = (await client.global(operation, input, options)) as Record<string, unknown>;
		return (response.result as Record<string, unknown> | undefined) ?? response;
	} finally {
		await client.close();
	}
}

/** Liveness only: signal 0 delivers nothing, so this never acts on a pid read from the broker index. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A host the broker launched for S instead of reusing the TUI; only a failing run has one. */
type LaunchedHost = { pid: number; endpointGeneration?: unknown; endpointIncarnation?: unknown };

/**
 * Closes, through the broker, every host serving `sessionId` other than the owner, and waits for
 * each to exit. The fixture lease stops only the broker, so a launched `session-host-internal`
 * (and its stderr drainer) would otherwise outlive the test and write into the removed root.
 */
async function closeLaunchedHosts(
	discovery: { url: string; token: string },
	sessionId: string,
	ownerPid: number,
	known: readonly LaunchedHost[],
): Promise<void> {
	const hosts = new Map<number, LaunchedHost>();
	for (const host of known) if (host.pid !== ownerPid) hosts.set(host.pid, host);
	for (const row of await brokerRows(discovery))
		if (row.sessionId === sessionId && typeof row.pid === "number" && row.pid !== ownerPid && !hosts.has(row.pid))
			hosts.set(row.pid, { pid: row.pid });
	const failures: unknown[] = [];
	for (const host of hosts.values()) {
		const authority =
			typeof host.endpointGeneration === "number" && typeof host.endpointIncarnation === "string"
				? { endpointGeneration: host.endpointGeneration, endpointIncarnation: host.endpointIncarnation }
				: {};
		// While the owner's row is still unresolved the broker refuses the close as ambiguous; retry
		// until the broker has reaped it.
		let closeError: unknown;
		const deadline = Date.now() + 30_000;
		do {
			try {
				await brokerGlobal(
					discovery,
					"session.close",
					{ sessionId, ...authority },
					{ idempotencyKey: `owner-attach-close-${host.pid}-${Date.now()}` },
				);
				closeError = undefined;
			} catch (error) {
				closeError = error;
				await Bun.sleep(250);
			}
		} while (closeError !== undefined && processAlive(host.pid) && Date.now() < deadline);
		if (closeError !== undefined) failures.push(closeError);
		try {
			await waitFor(() => !processAlive(host.pid), 30_000, `launched host ${host.pid} to exit`);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0)
		throw new AggregateError(
			failures,
			`A host launched for the session was not closed: ${failures.map(failure => (failure instanceof Error ? failure.message : String(failure))).join("; ")}`,
		);
}

/** The first page of the broker's `session.list`; the fixture never holds more than one session. */
async function brokerRows(discovery: { url: string; token: string }): Promise<BrokerRow[]> {
	const page = await brokerGlobal(discovery, "session.list", {});
	return Array.isArray(page.sessions) ? (page.sessions as BrokerRow[]) : [];
}

function subprocessInput(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
		close() {
			proc.stdin.end();
		},
		abort() {
			proc.stdin.end();
		},
	});
}

interface Fixture {
	root: string;
	env: Record<string, string>;
	agentDir: string;
	workspace: string;
	model: FakeModel;
	cleanup: FixtureRootCleanup;
	started: { discovery: { url: string; token: string } };
}

/**
 * An owned root with an isolated environment, the fake model in `models.yml`, the ownership mode
 * in the operator's global config, and a fixture broker. Shutdown runs in registration order:
 * release held turns, stop the TUI, ACP and any CLI command, then close the broker lease.
 */
async function startFixture(mode: "observe" | "enforce", holds: readonly string[]): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-attach-")));
	const env = buildChildEnv(root);
	const agentDir = env.GJC_CODING_AGENT_DIR!;
	const workspace = path.join(root, "workspace");
	const stubs = path.join(root, "stub-bin");
	for (const dir of [
		env.TMPDIR,
		env.XDG_DATA_HOME,
		env.XDG_CONFIG_HOME,
		env.XDG_STATE_HOME,
		env.XDG_CACHE_HOME,
		env.XDG_RUNTIME_DIR,
		agentDir,
		workspace,
		stubs,
	])
		await fs.mkdir(dir!, { recursive: true, mode: 0o700 });
	// No child may open a browser: `open`/`xdg-open` resolve to no-op stubs first on PATH.
	for (const name of ["open", "xdg-open"]) {
		await Bun.write(path.join(stubs, name), "#!/bin/sh\nexit 0\n");
		await fs.chmod(path.join(stubs, name), 0o755);
	}
	env.PATH = `${stubs}:${env.PATH}`;
	const model = startFakeModel(holds);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		`providers:
  fake:
    baseUrl: http://127.0.0.1:${model.port}/v1
    apiKey: test-key
    api: openai-completions
    models:
      - id: fake-model
        name: Fake Model
        contextWindow: 200000
        maxTokens: 1000
        input: [text]
        output: [text]
`,
	);
	// The operator's global config (ownership settings are global-only).
	await Bun.write(path.join(agentDir, "config.yml"), `session:\n  ownership:\n    mode: ${mode}\n`);

	const started = await withFixtureBrokerEnvironment(() =>
		startFixtureBrokerWithLeaseForTest({ agentDir, env }),
	).catch(async error => {
		await fs.rm(root, { recursive: true, force: true });
		throw error;
	});
	const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
	cleanupRoots.push(cleanup);
	registerFixtureRuntime(cleanup, {
		key: "fake-model",
		requiredOwner: "runtime",
		shutdown: async () => model.releaseAll(),
	});
	registerFixtureRuntime(cleanup, { key: "cli-commands", requiredOwner: "runtime", shutdown: killCliChildren });
	return { root, env, agentDir, workspace, model, cleanup, started };
}

/** A real interactive TUI in a PTY. `exec` keeps the printed pid the TUI's own. */
interface Tui {
	readonly pty: PtySession;
	readonly done: Promise<PtyRunResult>;
	screen(): string;
	pid(): Promise<number>;
}

function startTui(
	fixture: Fixture,
	args: readonly string[],
	extraEnv: Record<string, string> = {},
	where: { readonly cwd?: string; readonly key?: string } = {},
): Tui {
	const tuiEnv: Record<string, string> = {
		...fixture.env,
		TERM: "xterm-256color",
		GJC_AUTOMATION: "1",
		GJC_NOTIFY: "off",
		...extraEnv,
	};
	const pty = new PtySession();
	let raw = "";
	const done: Promise<PtyRunResult> = pty.start(
		{
			command: `printf 'gjc-tui-pid=%s\\n' $$; exec '${process.execPath}' '${cli}' --no-mcp --no-lsp --no-rules --no-title --model fake/fake-model ${args.join(" ")}`,
			shell: "bash",
			cwd: where.cwd ?? fixture.workspace,
			env: tuiEnv,
			unsetEnv: Object.keys(process.env).filter(key => !(key in tuiEnv)),
			cols: 120,
			rows: 36,
			timeoutMs: 240_000,
		},
		(_error, chunk) => {
			if (chunk) raw += chunk;
		},
	);
	let exited = false;
	void done.finally(() => {
		exited = true;
	});
	registerFixtureRuntime(fixture.cleanup, {
		key: where.key ?? "tui",
		requiredOwner: "runtime-and-broker",
		shutdown: async () => {
			// Quit first, so the TUI retires its broker row and a launched host's close is not
			// refused as ambiguous; kill only if it does not exit.
			if (!exited) {
				pty.write("/quit\r");
				await Promise.race([done.catch(() => undefined), Bun.sleep(10_000)]);
			}
			if (!exited) pty.kill();
			await withTimeout(
				done.catch(() => undefined),
				20_000,
				"TUI PTY did not settle",
			);
		},
	});
	return {
		pty,
		done,
		screen: () => strip(raw),
		pid: async (): Promise<number> => {
			await waitFor(() => /gjc-tui-pid=\d+/.test(raw), 30_000, "the TUI pid");
			const pid = Number(/gjc-tui-pid=(\d+)/.exec(raw)?.[1]);
			expect(pid).toBeGreaterThan(0);
			return pid;
		},
	};
}

/** `gjc acp` with a recording ACP client on its stdio; stopped by the fixture cleanup. */
function startAcp(fixture: Fixture) {
	const acp = Bun.spawn([process.execPath, cli, "acp"], {
		cwd: fixture.workspace,
		env: fixture.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stderr = "";
	const stderrDrain = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of acp.stderr)
			stderr = `${stderr}${decoder.decode(chunk, { stream: true })}`.slice(-STDERR_CAP);
	})();
	registerFixtureRuntime(fixture.cleanup, {
		key: "acp",
		requiredOwner: "runtime-and-broker",
		shutdown: async () => {
			if (acp.exitCode !== null) return;
			try {
				acp.stdin.end();
			} catch {}
			const graceful = await Promise.race([acp.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
			if (!graceful) acp.kill("SIGKILL");
			await withTimeout(acp.exited, 5_000, "ACP did not exit after SIGKILL");
		},
		dispose: () => stderrDrain,
	});
	const client = new RecordingClient();
	const connection = new ClientSideConnection(() => client, ndJsonStream(subprocessInput(acp), acp.stdout));
	return { acp, client, connection, stderr: () => stderr };
}

// The harness drives a real PTY and POSIX process groups; Windows keeps its own suites.
// Under `enforce` too: a refusal never blocks remote control, because attach and reuse never claim.
describe.skipIf(process.platform === "win32")("remote clients attach to the TUI that owns the session", () => {
	it.each([
		"observe",
		"enforce",
	] as const)("%s: ACP session/load and an SDK send run in the owner's transcript and never claim", async mode => {
		const TUI_PROMPT = "attach-tui-one";
		const ACP_PROMPT = "attach-acp-two";
		const SDK_PROMPT = "attach-sdk-three";
		const fixture = await startFixture(mode, [ACP_PROMPT, SDK_PROMPT]);
		const { root, env, agentDir, workspace, model, cleanup, started } = fixture;

		// --- The owner: a real interactive TUI in a PTY.
		const tui = startTui(fixture, []);
		const { pty, done: tuiDone } = tui;
		await waitFor(() => /v\d+\.\d+\.\d+/.test(tui.screen()), 60_000, "TUI footer");
		const tuiPid = await tui.pid();

		// The TUI's own first prompt creates S on disk.
		const sessions = SessionManager.getDefaultSessionDirReadOnly(workspace, agentDir);
		pty.write(`${TUI_PROMPT}\r`);
		let transcript = "";
		await waitFor(
			async () => {
				const files = await transcriptFiles(sessions);
				if (files.length !== 1) return false;
				transcript = files[0]!;
				return messageEntries((await readTranscript(transcript)).entries, `${TUI_PROMPT}-reply`).length > 0;
			},
			60_000,
			"the TUI's own turn on disk",
		);
		const sessionId = (await readTranscript(transcript)).header.id!;
		expect(sessionId).toBeTruthy();

		// Attach only once the owner's endpoint is live in the broker index with a positive generation;
		// the startup window before it is the case below.
		let ownerRow: BrokerRow | undefined;
		await waitFor(
			async () => {
				const rows = await brokerRows(started.discovery);
				ownerRow = rows.find(row => row.sessionId === sessionId);
				return ownerRow?.live === true && Number(ownerRow.endpointGeneration ?? 0) > 0;
			},
			60_000,
			"the TUI endpoint in the broker index",
		);
		expect(ownerRow?.pid).toBe(tuiPid);

		const onlyTheTuiHolds = (owners: OwnerRow[]) =>
			expect(
				owners.map(owner => ({
					sessionId: owner.sessionId,
					surface: owner.holder?.surface,
					pid: owner.holder?.pid,
				})),
			).toEqual([{ sessionId, surface: "terminal", pid: tuiPid }]);
		onlyTheTuiHolds(await sessionOwners(env, workspace));

		// A failing run can make the broker launch a host for S instead of reusing the TUI. Close any
		// such host through the broker before the lease stops the broker itself.
		const launchedHosts: LaunchedHost[] = [];
		registerFixtureRuntime(cleanup, {
			key: "launched-hosts",
			requiredOwner: "runtime-and-broker",
			shutdown: () => closeLaunchedHosts(started.discovery, sessionId, tuiPid, launchedHosts),
		});

		// --- ACP client: `gjc acp`, initialize, session/load S, one prompt.
		const { acp, client: acpClient, connection, stderr: acpStderr } = startAcp(fixture);
		try {
			await withTimeout(
				connection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
				60_000,
				"ACP initialize",
			);
			await withTimeout(
				connection.loadSession({ sessionId, cwd: workspace, mcpServers: [] }),
				60_000,
				"ACP session/load",
			);
			const prompt = connection.prompt({ sessionId, prompt: [{ type: "text", text: ACP_PROMPT }] });
			// The ACP turn is at the model, run by the TUI: the ACP process is alive and holds nothing.
			await withTimeout(model.reached(ACP_PROMPT), 60_000, "the ACP prompt at the model");
			expect(acp.exitCode).toBeNull();
			onlyTheTuiHolds(await sessionOwners(env, workspace));
			model.release(ACP_PROMPT);
			const response = await withTimeout(prompt, 60_000, "ACP session/prompt");
			expect(response.stopReason).toBe("end_turn");
			expect(acpClient.assistantText()).toContain(`${ACP_PROMPT}-reply`);
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n[acp stderr]\n${acpStderr()}`);
		}
		acp.stdin.end();
		expect(await withTimeout(acp.exited, 20_000, "ACP did not exit after stdin closed")).toBe(0);

		// --- SDK client: `gjc sdk session send S --wait`.
		const sent = runGjc(
			env,
			workspace,
			["sdk", "session", "send", sessionId, "--text", SDK_PROMPT, "--wait", "--json"],
			90_000,
		);
		// Awaited below; this only keeps an early failure from also reporting an unhandled rejection.
		sent.catch(() => undefined);
		await withTimeout(model.reached(SDK_PROMPT), 60_000, "the SDK prompt at the model");
		onlyTheTuiHolds(await sessionOwners(env, workspace));
		model.release(SDK_PROMPT);
		const send = await sent;
		expect(send.exitCode).toBe(0);
		expect(JSON.parse(send.stdout)).toMatchObject({ ok: true, result: { status: "terminal_ok" } });

		// --- Broker `session.resume` of S, as Telegram, Hermes and Mobile call it: it reuses the
		// owner's live endpoint instead of launching a host.
		const resumed = await brokerGlobal(
			started.discovery,
			"session.resume",
			// The input shape ACP's resume uses: the saved transcript and the target workspace.
			{ sessionId, cwd: workspace, sessionPath: transcript, target: { path: workspace } },
			{ idempotencyKey: `owner-attach-resume-${sessionId}` },
		);
		if (typeof resumed.pid === "number" && resumed.pid !== tuiPid)
			launchedHosts.push({
				pid: resumed.pid,
				endpointGeneration: resumed.endpointGeneration,
				endpointIncarnation: resumed.endpointIncarnation,
			});
		expect(resumed).toMatchObject({ sessionId, reused: true, pid: tuiPid });

		// Both remote prompts ran in the owner's transcript: one file, header S, each exactly once.
		expect(await transcriptFiles(sessions)).toEqual([transcript]);
		const merged = await readTranscript(transcript);
		expect(merged.header.id).toBe(sessionId);
		for (const text of [TUI_PROMPT, ACP_PROMPT, SDK_PROMPT]) {
			expect(messageEntries(merged.entries, text)).toHaveLength(1);
			expect(messageEntries(merged.entries, `${text}-reply`)).toHaveLength(1);
		}
		// The three attach prompts reached the model in order; other requests (none today) are ignored.
		const order = [TUI_PROMPT, ACP_PROMPT, SDK_PROMPT].map(prompt => model.prompts.indexOf(prompt));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// No host was launched for S, by ACP, the SDK send or the resume: the broker still routes it
		// to the TUI alone.
		expect(
			(await brokerRows(started.discovery)).filter(row => row.sessionId === sessionId).map(row => row.pid),
		).toEqual([tuiPid]);
		// The claim is still the TUI's.
		onlyTheTuiHolds(await sessionOwners(env, workspace));

		// --- The owner quits: nothing is held.
		pty.write("/quit\r");
		expect(await withTimeout(tuiDone, 30_000, "TUI did not exit after /quit")).toMatchObject({ exitCode: 0 });
		expect(await sessionOwners(env, workspace)).toEqual([]);

		// Counters every exited process reported: every claim taken was released and none was
		// contended. A process reports only at a clean exit, so a client whose exit-time write is
		// dropped is invisible here; the owners probes above are the signal that does not depend on it.
		const statsDbs = await findFiles(root, "stats.db");
		expect(statsDbs).toHaveLength(1);
		const db = new Database(statsDbs[0]!, { readonly: true });
		try {
			const rows = db.prepare("SELECT name, count FROM session_ownership_events").all() as {
				name: string;
				count: number;
			}[];
			const total = (name: string) => rows.filter(row => row.name === name).reduce((sum, row) => sum + row.count, 0);
			expect(total("claim_conflict")).toBe(0);
			expect(total("held_at_exit")).toBe(0);
			expect(total("claim_failed")).toBe(0);
			expect(total("claim_taken")).toBeGreaterThanOrEqual(1);
			expect(total("claim_released")).toBe(total("claim_taken"));
		} finally {
			db.close();
		}
	}, 300_000);

	// Design §13 H3: a TUI holds the claim before its endpoint reaches the broker index. A resume in
	// that window waits for the endpoint instead of launching a second writer. The test holds the
	// TUI's registration open through its test seam for 3 s. It runs under `enforce`, whose 8 s wait
	// leaves that hold a wide margin; `observe` waits only 2 s, and its reuse is pinned in
	// sdk-broker-resume-held-session.test.ts.
	it("enforce: a broker resume and ACP session/load during the TUI's startup reuse its endpoint", async () => {
		const PRINT_PROMPT = "attach-print-zero";
		const ACP_PROMPT = "attach-acp-late";
		const fixture = await startFixture("enforce", [ACP_PROMPT]);
		const { env, agentDir, workspace, model, cleanup, started } = fixture;

		// S exists before the TUI starts: one `gjc -p` turn, which claims S and releases it at exit.
		const printed = await runGjc(env, workspace, [
			"-p",
			"--no-mcp",
			"--no-lsp",
			"--no-rules",
			"--model",
			"fake/fake-model",
			PRINT_PROMPT,
		]);
		expect(printed.exitCode).toBe(0);
		const sessions = SessionManager.getDefaultSessionDirReadOnly(workspace, agentDir);
		const files = await transcriptFiles(sessions);
		expect(files).toHaveLength(1);
		const transcript = files[0]!;
		const sessionId = (await readTranscript(transcript)).header.id!;
		expect(await sessionOwners(env, workspace)).toEqual([]);

		// `gjc --resume S`, with its endpoint registration held.
		const holdDir = path.join(fixture.root, "registration-hold");
		await fs.mkdir(holdDir, { recursive: true, mode: 0o700 });
		const hold = path.join(holdDir, `${sessionId}.hold`);
		await Bun.write(hold, "");
		const tui = startTui(fixture, ["--resume", sessionId], { GJC_SDK_TEST_HOST_REGISTRATION_HOLD_DIR: holdDir });
		const tuiPid = await tui.pid();
		const launchedHosts: LaunchedHost[] = [];
		registerFixtureRuntime(cleanup, {
			key: "launched-hosts",
			requiredOwner: "runtime-and-broker",
			shutdown: () => closeLaunchedHosts(started.discovery, sessionId, tuiPid, launchedHosts),
		});
		await waitFor(
			async () =>
				(await sessionOwners(env, workspace)).some(
					owner => owner.sessionId === sessionId && owner.holder?.pid === tuiPid,
				),
			60_000,
			"the TUI's claim on S",
		);
		const rowsForS = async () => (await brokerRows(started.discovery)).filter(row => row.sessionId === sessionId);
		const endpointPublished = async () => (await rowsForS()).some(row => Number(row.endpointGeneration ?? 0) > 0);
		expect(await endpointPublished()).toBe(false);

		const acp = startAcp(fixture);
		// Requests still waiting in the broker when a step fails. They settle while the TUI still
		// holds S: once cleanup quits it, a waiting resume would launch a host after cleanup ran.
		const inFlight: Promise<unknown>[] = [];
		try {
			await withTimeout(
				acp.connection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
				60_000,
				"ACP initialize",
			);
			// Inside the window: a broker resume, as Telegram and Hermes send it, and ACP session/load.
			const resumeInput = { sessionId, cwd: workspace, sessionPath: transcript, target: { path: workspace } };
			const resumed = brokerGlobal(started.discovery, "session.resume", resumeInput, {
				idempotencyKey: `startup-window-resume-${sessionId}`,
				// The deadline every lifecycle client sizes for a resume.
				timeoutMs: lifecycleRequestTimeoutMs("session.resume", resumeInput),
			});
			const loaded = acp.connection.loadSession({ sessionId, cwd: workspace, mcpServers: [] });
			inFlight.push(resumed, loaded);
			// Awaited below; this only keeps an early failure from also reporting an unhandled rejection.
			resumed.catch(() => undefined);
			loaded.catch(() => undefined);
			await Bun.sleep(3_000);
			// Both are waiting: the endpoint is still held back, and no host was launched for S.
			expect(await endpointPublished()).toBe(false);
			expect((await rowsForS()).every(row => row.pid === tuiPid)).toBe(true);

			await fs.rm(hold);
			const resume = await withTimeout(resumed, 30_000, "broker session.resume");
			if (typeof resume.pid === "number" && resume.pid !== tuiPid)
				launchedHosts.push({
					pid: resume.pid,
					endpointGeneration: resume.endpointGeneration,
					endpointIncarnation: resume.endpointIncarnation,
				});
			expect(resume).toMatchObject({ sessionId, reused: true, pid: tuiPid });
			await withTimeout(loaded, 60_000, "ACP session/load");

			const prompt = acp.connection.prompt({ sessionId, prompt: [{ type: "text", text: ACP_PROMPT }] });
			await withTimeout(model.reached(ACP_PROMPT), 60_000, "the ACP prompt at the model");
			model.release(ACP_PROMPT);
			expect((await withTimeout(prompt, 60_000, "ACP session/prompt")).stopReason).toBe("end_turn");
			expect(acp.client.assistantText()).toContain(`${ACP_PROMPT}-reply`);
		} catch (error) {
			await fs.rm(hold, { force: true });
			await Promise.allSettled(inFlight.map(request => withTimeout(request, 30_000, "a request in flight")));
			const rows = JSON.stringify(await rowsForS().catch(() => "unavailable"));
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n[rows]\n${rows}\n[tui]\n${tui.screen().slice(-3000)}\n[acp stderr]\n${acp.stderr()}`,
			);
		}
		acp.acp.stdin.end();
		expect(await withTimeout(acp.acp.exited, 20_000, "ACP did not exit after stdin closed")).toBe(0);

		// The ACP turn ran in the TUI's transcript, S, and the broker still routes S to the TUI alone.
		expect(await transcriptFiles(sessions)).toEqual([transcript]);
		const merged = await readTranscript(transcript);
		expect(merged.header.id).toBe(sessionId);
		expect(messageEntries(merged.entries, `${ACP_PROMPT}-reply`)).toHaveLength(1);
		expect((await rowsForS()).map(row => row.pid)).toEqual([tuiPid]);
		expect(
			(await sessionOwners(env, workspace)).map(owner => ({ sessionId: owner.sessionId, pid: owner.holder?.pid })),
		).toEqual([{ sessionId, pid: tuiPid }]);

		tui.pty.write("/quit\r");
		expect(await withTimeout(tui.done, 30_000, "TUI did not exit after /quit")).toMatchObject({ exitCode: 0 });
	}, 300_000);

	// Design §12 "hand over to the TUI" and §13 H1/L1, the phone-to-PC flow: a long-lived `gjc acp`
	// (the Gajae Mobile bridge) creates S, so a broker-launched host holds it. `gjc --resume S` warns
	// with Continue here. While the host runs a turn, Continue here is refused and the TUI says so;
	// once the turn ends it closes the host, and the bridge's next prompt, sent with no session/load,
	// runs in the TUI and lands in S's one transcript. Then `/resume` takes the bridge's second
	// session S2 over the same way; the bridge stays idle until the Router has rebound it, and its
	// prompt and session/close afterwards reach the TUI without closing it.
	it("enforce: Continue here takes a broker-hosted session over and the ACP client follows it", async () => {
		const FIRST_PROMPT = "attach-acp-one";
		const BUSY_PROMPT = "attach-acp-busy";
		const AFTER_PROMPT = "attach-acp-after";
		const EARLY_PROMPT = "attach-acp-early";
		const SECOND_PROMPT = "attach-acp-second";
		const LATER_PROMPT = "attach-acp-later";
		const fixture = await startFixture("enforce", [BUSY_PROMPT]);
		const { env, agentDir, workspace, model, cleanup, started } = fixture;

		// --- The bridge: `gjc acp`, session/new S and S2, one prompt each. Broker-launched hosts run them.
		const acp = startAcp(fixture);
		let tuiPid: number | undefined;
		let sessionId = "";
		let secondId = "";
		const launchedHosts: LaunchedHost[] = [];
		registerFixtureRuntime(cleanup, {
			key: "launched-hosts",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				for (const id of [sessionId, secondId])
					if (id) await closeLaunchedHosts(started.discovery, id, tuiPid ?? -1, launchedHosts);
			},
		});
		const rowsOf = async (id: string) => (await brokerRows(started.discovery)).filter(row => row.sessionId === id);
		const rowsForS = () => rowsOf(sessionId);
		const holderOf = async (id: string) =>
			(await sessionOwners(env, workspace)).find(owner => owner.sessionId === id)?.holder?.pid;
		const sessions = SessionManager.getDefaultSessionDirReadOnly(workspace, agentDir);
		const transcriptOf = async (id: string) => {
			for (const file of await transcriptFiles(sessions))
				if ((await readTranscript(file)).header.id === id) return file;
			throw new Error(`no transcript for ${id}`);
		};
		let tui: Tui | undefined;
		try {
			await withTimeout(
				acp.connection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
				60_000,
				"ACP initialize",
			);
			const create = async (text: string) => {
				const id = (
					await withTimeout(
						acp.connection.newSession({ cwd: workspace, mcpServers: [] }),
						60_000,
						"ACP session/new",
					)
				).sessionId;
				const reply = await withTimeout(
					acp.connection.prompt({ sessionId: id, prompt: [{ type: "text", text }] }),
					60_000,
					`the ACP prompt ${text}`,
				);
				expect(reply.stopReason).toBe("end_turn");
				const pid = Number((await rowsOf(id)).find(row => row.live === true)?.pid);
				expect(pid).toBeGreaterThan(0);
				expect(await holderOf(id)).toBe(pid);
				launchedHosts.push({ pid });
				return { id, pid };
			};
			const firstHost = await create(FIRST_PROMPT);
			sessionId = firstHost.id;
			const hostPid = firstHost.pid;
			const secondHost = await create(SECOND_PROMPT);
			secondId = secondHost.id;
			const transcript = await transcriptOf(sessionId);

			// --- From another folder, `gjc --resume S` could only fork S here, so the warning offers Fork
			// and Cancel, not Continue here. Cancel exits and leaves S with its host.
			const elsewhere = path.join(fixture.root, "elsewhere");
			await fs.mkdir(elsewhere, { recursive: true, mode: 0o700 });
			const away = startTui(fixture, ["--resume", sessionId], {}, { cwd: elsewhere, key: "tui-elsewhere" });
			await waitFor(() => away.screen().includes("Fork into a new session"), 60_000, "the warning elsewhere");
			expect(away.screen()).not.toContain("Continue here");
			away.pty.write("c");
			expect(await withTimeout(away.done, 30_000, "the TUI elsewhere did not exit")).toMatchObject({ exitCode: 0 });
			expect(await holderOf(sessionId)).toBe(hostPid);

			// --- A turn is running in the host: the bridge's second prompt is held at the model.
			const busy = acp.connection.prompt({ sessionId, prompt: [{ type: "text", text: BUSY_PROMPT }] });
			busy.catch(() => undefined);
			await withTimeout(model.reached(BUSY_PROMPT), 60_000, "the busy prompt at the model");

			// --- `gjc --resume S` in a terminal: the warning offers Continue here beside Fork and Cancel.
			// The TUI's endpoint publication is held after it takes S over, so the bridge's first prompt
			// meets a TUI that is still starting.
			const holdDir = path.join(fixture.root, "registration-hold");
			await fs.mkdir(holdDir, { recursive: true, mode: 0o700 });
			const hold = path.join(holdDir, `${sessionId}.hold`);
			await Bun.write(hold, "");
			tui = startTui(fixture, ["--resume", sessionId], { GJC_SDK_TEST_HOST_REGISTRATION_HOLD_DIR: holdDir });
			const view = tui;
			tuiPid = await view.pid();
			await waitFor(() => view.screen().includes("Continue here"), 60_000, "the held-session warning");
			expect(view.screen()).toContain("Fork into a new session");
			const beforeBusy = view.screen().length;
			view.pty.write("h");
			await waitFor(() => view.screen().slice(beforeBusy).includes("running a turn"), 60_000, "the busy refusal");
			// Refused before anything changed: the host still holds S and the broker still routes to it.
			expect(processAlive(hostPid)).toBe(true);
			expect((await rowsForS()).map(row => row.pid)).toEqual([hostPid]);
			expect(await holderOf(sessionId)).toBe(hostPid);

			// --- The turn ends; Continue here again closes the host and the TUI owns S. The host can stay
			// busy for a moment after the prompt settles, so a fresh refusal is answered with another try.
			model.release(BUSY_PROMPT);
			expect((await withTimeout(busy, 60_000, "the busy ACP prompt")).stopReason).toBe("end_turn");
			let attempt = view.screen().length;
			view.pty.write("h");
			await waitFor(
				async () => {
					if ((await holderOf(sessionId)) === tuiPid) return true;
					const since = view.screen().slice(attempt);
					if (since.includes("running a turn") && since.includes("Continue here")) {
						attempt = view.screen().length;
						view.pty.write("h");
					}
					return false;
				},
				60_000,
				"the TUI's claim on S",
			);
			await waitFor(() => !processAlive(hostPid), 30_000, "the session host to exit");

			// --- A prompt while the TUI has no endpoint yet fails as before, undelivered, and the bridge
			// keeps S: once the endpoint is published, its next prompt, with no session/load, runs in
			// the TUI.
			const early = acp.connection.prompt({ sessionId, prompt: [{ type: "text", text: EARLY_PROMPT }] });
			await expect(withTimeout(early, 60_000, "the ACP prompt while the TUI starts")).rejects.toThrow();
			await fs.rm(hold);
			const after = await withTimeout(
				acp.connection.prompt({ sessionId, prompt: [{ type: "text", text: AFTER_PROMPT }] }),
				90_000,
				"the ACP prompt after the handover",
			);
			expect(after.stopReason).toBe("end_turn");
			expect(acp.client.assistantText()).toContain(`${AFTER_PROMPT}-reply`);
			await waitFor(() => view.screen().includes(`${AFTER_PROMPT}-reply`), 30_000, "the reply in the TUI");

			// S's one transcript holds every prompt exactly once; the broker routes S to the TUI alone.
			const merged = await readTranscript(transcript);
			for (const text of [FIRST_PROMPT, BUSY_PROMPT, AFTER_PROMPT]) {
				expect(messageEntries(merged.entries, text)).toHaveLength(1);
				expect(messageEntries(merged.entries, `${text}-reply`)).toHaveLength(1);
			}
			expect(messageEntries(merged.entries, EARLY_PROMPT)).toHaveLength(0);
			expect((await rowsForS()).map(row => row.pid)).toEqual([tuiPid]);
			expect(await holderOf(sessionId)).toBe(tuiPid);

			// --- `/resume` onto S2, which the bridge's other host holds: Continue here from the TUI's own
			// selector (no accelerators there: down to the second option).
			const beforeResume = view.screen().length;
			view.pty.write("/resume\r");
			await waitFor(() => view.screen().slice(beforeResume).includes(SECOND_PROMPT), 30_000, "the /resume list");
			view.pty.write(SECOND_PROMPT);
			await Bun.sleep(300);
			view.pty.write("\r");
			await waitFor(
				() => view.screen().slice(beforeResume).includes("Continue here"),
				30_000,
				"the /resume warning",
			);
			view.pty.write("\x1b[B");
			await Bun.sleep(200);
			view.pty.write("\r");
			await waitFor(async () => (await holderOf(secondId)) === tuiPid, 60_000, "the TUI's claim on S2");
			await waitFor(() => !processAlive(secondHost.pid), 30_000, "S2's session host to exit");
			// The bridge stays idle until S2's endpoint is live and the Router's 2 s reconcile has rebound it.
			await waitFor(
				async () =>
					(await rowsOf(secondId)).some(
						row => row.pid === tuiPid && row.live === true && Number(row.endpointGeneration) > 0,
					),
				30_000,
				"the TUI's endpoint for S2",
			);
			await Bun.sleep(3_000);
			const later = await withTimeout(
				acp.connection.prompt({ sessionId: secondId, prompt: [{ type: "text", text: LATER_PROMPT }] }),
				90_000,
				"the ACP prompt on S2 after /resume",
			);
			expect(later.stopReason).toBe("end_turn");
			await waitFor(() => view.screen().includes(`${LATER_PROMPT}-reply`), 30_000, "the S2 reply in the TUI");
			const second = await readTranscript(await transcriptOf(secondId));
			for (const text of [SECOND_PROMPT, LATER_PROMPT])
				expect(messageEntries(second.entries, `${text}-reply`)).toHaveLength(1);
			// The bridge created S2, but closing it there only detaches: the TUI keeps and serves it.
			await withTimeout(acp.connection.closeSession({ sessionId: secondId }), 30_000, "ACP session/close");
			expect(processAlive(tuiPid)).toBe(true);
			expect(await holderOf(secondId)).toBe(tuiPid);
			expect((await rowsOf(secondId)).map(row => ({ pid: row.pid, live: row.live }))).toEqual([
				{ pid: tuiPid, live: true },
			]);
		} catch (error) {
			model.releaseAll();
			await fs.rm(path.join(fixture.root, "registration-hold"), { recursive: true, force: true });
			const rows = JSON.stringify(await rowsForS().catch(() => "unavailable"));
			const data = JSON.stringify((error as { data?: unknown }).data ?? null);
			const events = (
				await Bun.file(path.join(agentDir, "sdk", "sessions", "index.jsonl"))
					.text()
					.catch(() => "")
			)
				.split("\n")
				.filter(line => line.includes(sessionId))
				.map(line => {
					const event = JSON.parse(line) as Record<string, unknown>;
					return `${event.indexSeq} ${event.type} gen=${event.endpointGeneration} pid=${event.pid} root=${String((event.locator as { stateRoot?: string } | undefined)?.stateRoot).slice(-12)}`;
				})
				.join("\n");
			throw new Error(
				`${error instanceof Error ? error.message : String(error)} ${data}\n[events]\n${events}\n[rows]\n${rows}\n[tui]\n${tui?.screen().slice(-4000) ?? ""}\n[acp stderr]\n${acp.stderr()}`,
			);
		}
		acp.acp.stdin.end();
		expect(await withTimeout(acp.acp.exited, 20_000, "ACP did not exit after stdin closed")).toBe(0);
		// The bridge's exit leaves S2 with the TUI, which still serves it; S was released by /resume.
		expect(
			(await sessionOwners(env, workspace)).map(owner => ({ sessionId: owner.sessionId, pid: owner.holder?.pid })),
		).toEqual([{ sessionId: secondId, pid: tuiPid }]);
		expect((await rowsOf(secondId)).map(row => ({ pid: row.pid, live: row.live }))).toEqual([
			{ pid: tuiPid, live: true },
		]);
		tui?.pty.write("/quit\r");
		expect(await withTimeout(tui!.done, 30_000, "TUI did not exit after /quit")).toMatchObject({ exitCode: 0 });
	}, 300_000);
});
