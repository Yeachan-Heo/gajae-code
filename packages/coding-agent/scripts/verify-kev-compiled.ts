// Opt-in live verification: build dist/gjc, then `gjc setup kev install` and
// `gjc setup kev start` so an owned Kev service exists. Run from repository root.
// Chat completions are loopback mocks; only Kev inference is real, and it travels
// over the owned supervisor's authenticated Unix socket rather than an HTTP port.
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const binary = path.resolve("packages/coding-agent/dist/gjc");
const reports: unknown[] = [];
for (const mode of ["routing", "shadow"] as const) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kev-compiled-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "work");
	await fs.mkdir(cwd, { recursive: true });
	const chatModels: string[] = [];
	let parentTurns = 0;
	let failure: unknown;
	// Kev inference is no longer reachable over HTTP, so it cannot be tapped here.
	// It goes through the owned supervisor's authenticated Unix socket, and the
	// persisted decision events below are the evidence that it happened.
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			try {
				const url = new URL(req.url);
				if (url.pathname !== "/v1/chat/completions") return new Response("unexpected path", { status: 404 });
				const body = (await req.json()) as { model: string; messages: unknown[] };
				chatModels.push(body.model);
				let delta: unknown = { content: "SYNTHETIC_CHILD_OK" };
				let finish = "stop";
				if (body.model === "main") {
					parentTurns++;
					if (parentTurns === 1) {
						delta = {
							tool_calls: [
								{
									index: 0,
									id: "call_compiled_task",
									type: "function",
									function: {
										name: "task",
										arguments: JSON.stringify({
											agent: "executor",
											tasks: [
												{
													id: "KevCompiled",
													description: "Synthetic compiled Kev verification",
													assignment:
														"Return SYNTHETIC_CHILD_OK only. Do not use tools, edit files, or run any commands. Skip all tests, gates and formatters.",
													tier: "fast",
												},
											],
										}),
									},
								},
							],
						};
						finish = "tool_calls";
					} else if (parentTurns === 2) {
						delta = {
							tool_calls: [
								{
									index: 0,
									id: "call_compiled_await",
									type: "function",
									function: {
										name: "subagent",
										arguments: JSON.stringify({
											action: "await",
											ids: ["0-KevCompiled"],
											timeout_ms: 20000,
											heartbeat_ms: 0,
											verbosity: "full",
										}),
									},
								},
							],
						};
						finish = "tool_calls";
					} else {
						await Bun.sleep(500);
						delta = { content: "COMPILED_KEV_OK" };
					}
				}
				const chunk = (value: unknown, reason: string | null) =>
					`data: ${JSON.stringify({ id: "local-compiled-test", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
				return new Response(
					`${chunk({ role: "assistant", ...(delta as object) }, null) + chunk({}, finish)}data: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			} catch (error) {
				failure = String(error);
				return new Response(String(error), { status: 500 });
			}
		},
	});
	try {
		const baseUrl = `http://127.0.0.1:${server.port}/v1`;
		await Bun.write(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: {
					"compiled-local": {
						baseUrl,
						api: "openai-completions",
						auth: "none",
						models: ["main", "pinned", "fast"].map(id => ({
							id,
							name: id,
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						})),
					},
				},
			}),
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			JSON.stringify({
				task: {
					agentModelOverrides: { executor: "compiled-local/pinned" },
					autorouting: { enabled: false, tiers: { fast: ["compiled-local/fast"], balanced: [], strong: [] } },
					decision: {
						enabled: true,
						provider: "kev",
						mode,
						timeoutMs: 5000,
						kevModel: "kev-latest",
					},
				},
				compaction: { enabled: false },
			}),
		);
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: root,
			TMPDIR: os.tmpdir(),
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_TASK_COLLECTION: "metadata",
			NO_COLOR: "1",
			TERM: "dumb",
		};
		const args = [
			binary,
			"--mode",
			"json",
			"--print",
			"--no-session",
			"--no-mcp",
			"--no-lsp",
			"--no-rules",
			"--no-title",
			"--tools",
			"task,subagent",
			"--model",
			"compiled-local/main",
			"--thinking",
			"off",
			"--system-prompt",
			"Synthetic local verification. Follow the supplied tool calls.",
			"Run the synthetic compiled Kev verification.",
		];
		const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), 90000);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		clearTimeout(timer);
		await Bun.write(`artifacts/kev-compiled-${mode}.stdout.jsonl`, stdout);
		await Bun.write(`artifacts/kev-compiled-${mode}.stderr.txt`, stderr);
		const dbPath = path.join(agentDir, "task-decisions", "task-decisions.db");
		let rows: Array<{ event_type: string; payload_json: string }> = [];
		if (await Bun.file(dbPath).exists()) {
			const db = new Database(dbPath, { readonly: true });
			try {
				rows = db
					.query<{ event_type: string; payload_json: string }, []>("SELECT * FROM events ORDER BY rowid")
					.all();
			} finally {
				db.close();
			}
		}
		const report = {
			mode,
			binary,
			root,
			exitCode,
			failure,
			chatModels,
			rows,
			stdoutTail: stdout.slice(-12000),
			stderr,
		};
		reports.push(report);
		await Bun.write("artifacts/kev-compiled-verification.json", JSON.stringify(reports, null, 2));
		if (exitCode !== 0 || failure)
			throw new Error(
				`Compiled ${mode} failed: exit=${exitCode}, error=${failure}; inspect artifacts/kev-compiled-verification.json`,
			);
		if (!chatModels.includes(mode === "routing" ? "fast" : "pinned"))
			throw new Error(`Wrong compiled child model: ${chatModels.join(",")}`);
		if (mode === "routing" && chatModels.includes("pinned")) throw new Error("Routing did not override child pin");
		if (mode === "shadow" && chatModels.includes("fast")) throw new Error("Shadow unexpectedly overrode child pin");
		const decisions = rows.filter(row => row.event_type === "decision").map(row => JSON.parse(row.payload_json));
		const outcomes = rows.filter(row => row.event_type === "outcome").map(row => JSON.parse(row.payload_json));
		const begin = rows.find(row => row.event_type === "begin");
		if (!begin || JSON.parse(begin.payload_json).requested_selectors[0] !== "compiled-local/pinned")
			throw new Error("Explicit child pin was not exercised");
		if (decisions.length !== 1 || decisions[0].error_code || decisions[0].recommended_tier !== "fast")
			throw new Error("Missing valid compiled Kev decision");
		if (decisions[0].decision_mode !== mode) throw new Error("Wrong persisted decision mode");
		if (mode === "routing" && decisions[0].effective_selector !== "compiled-local/fast")
			throw new Error("Recommended selector not applied");
		if (mode === "shadow" && decisions[0].effective_selector !== undefined)
			throw new Error("Shadow claimed routing authority");
		if (outcomes.length !== 1 || outcomes[0].status !== "completed" || outcomes[0].exitCode !== 0)
			throw new Error("Synthetic child did not complete successfully");
		if (chatModels.at(-1) !== "main") throw new Error("Main model changed after child execution");
		if (JSON.stringify(rows).includes("Return SYNTHETIC_CHILD_OK")) throw new Error("Metadata leaked raw assignment");
		process.stdout.write(
			`${JSON.stringify({
				mode,
				exitCode,
				chatModels,
				eventRows: rows.length,
				paidCalls: 0,
			})}\n`,
		);
	} finally {
		await server.stop(true);
	}
}
