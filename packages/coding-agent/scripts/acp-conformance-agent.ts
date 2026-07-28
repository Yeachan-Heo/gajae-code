#!/usr/bin/env bun

/**
 * Credential-free ACP fixture launcher. The loopback endpoint is deliberately
 * deterministic; the child remains the production `gjc --mode acp` surface.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..", "..", "..");
const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-acp-conformance-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

/**
 * Deterministic replies for the pinned `acp-core-v1` corpus. Each branch mirrors one
 * upstream case expectation; nothing here reaches the network.
 */
function response(prompt: string): string {
	if (prompt.includes("inspect-prompt")) return `received blocks: {"type":"resource"}`;
	if (prompt.includes("this-command-does-not-exist")) return "unrecognized prompt";
	if (/^\s*read\b/m.test(prompt)) return "read README.md: acpx";
	if (/^\s*write\b/m.test(prompt)) {
		const target = /write\s+(\S+)/.exec(prompt)?.[1] ?? "file";
		return `wrote ${target}`;
	}
	const echo = /^\s*echo\s*(.*)$/m.exec(prompt);
	if (echo) return echo[1] || "echo";
	return "ok";
}

function sse(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

function completion(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return sse({ id: "gjc-conformance", choices: [{ delta, finish_reason: finishReason }] });
}

function toolCall(name: "read" | "write", arguments_: Record<string, string>): string {
	return completion(
		{
			tool_calls: [
				{
					index: 0,
					id: `conformance-${name}`,
					type: "function",
					function: { name, arguments: JSON.stringify(arguments_) },
				},
			],
		},
		"tool_calls",
	);
}

function textCompletion(text: string): string {
	return `${completion({ content: text })}${completion({}, "stop")}data: [DONE]\n\n`;
}

async function cleanup(code = 0): Promise<never> {
	server?.stop(true);
	if (child && child.exitCode === null) child.kill();
	await fs.rm(agentDir, { recursive: true, force: true });
	process.exit(code);
}

server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = (await request.json().catch(() => ({}))) as {
			messages?: Array<{ role?: string; content?: unknown }>;
		};
		// OpenAI-style content is either a plain string or an array of typed blocks.
		const textOf = (content: unknown): string =>
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map(block =>
								typeof block === "object" &&
								block !== null &&
								typeof (block as { text?: unknown }).text === "string"
									? (block as { text: string }).text
									: "",
							)
							.join("")
					: "";
		const messages = body.messages ?? [];
		const prompt =
			[...messages]
				.reverse()
				.filter(message => message.role === "user")
				.map(message => textOf(message.content))
				.find(text => text.length > 0) ?? "";
		const hasToolResult = messages.some(message => message.role === "tool");
		const isRead = /^\s*read\b/m.test(prompt);
		const isWrite = /^\s*write\b/m.test(prompt);
		const isLateTool = prompt.includes("late-tool 40 follow-up");

		if (prompt.includes("sleep")) {
			const requested = Number(/\bsleep\s+(\d+)/.exec(prompt)?.[1] ?? 0);
			const delay = Math.min(Math.max(requested, 0), 30_000);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					let closed = false;
					const close = () => {
						if (closed) return;
						closed = true;
						controller.close();
					};
					request.signal.addEventListener("abort", close, { once: true });
					void Bun.sleep(delay).then(() => {
						if (closed) return;
						controller.enqueue(new TextEncoder().encode(textCompletion("slept")));
						close();
					});
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		}

		if ((isRead || isWrite || isLateTool) && !hasToolResult) {
			if (isLateTool) {
				const prefix = `${completion({ content: "preparing" })}${completion({ content: " writing now" })}${completion({ content: " before tool" })}`;
				return new Response(
					`${prefix}${toolCall("write", { path: ".acpx-conformance-late.txt", content: "late" })}data: [DONE]\n\n`,
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			}
			// Neutral pre-tool text: every corpus assertion below must come from the real
			// tool result, never from a marker announced before the tool ran.
			const provisional = isRead ? "checking the requested file" : "applying the requested write";
			return new Response(
				`${completion({ content: provisional })}${toolCall(
					isRead ? "read" : "write",
					isRead
						? { path: "README.md" }
						: {
								path: /write\s+(\S+)/.exec(prompt)?.[1] ?? "file",
								content: /write\s+\S+\s*(.*)/.exec(prompt)?.[1] ?? "",
							},
				)}data: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		}

		// Derive the reply from what the tool actually returned so a broken permission
		// bridge, filesystem bridge, or tool result cannot still satisfy the corpus.
		const toolText = messages
			.filter(message => message.role === "tool")
			.map(message => textOf(message.content))
			.join("\n");
		const toolDenied = /rejected by user|permission denied|not permitted/i.test(toolText);
		const reply = toolDenied
			? `permission denied: ${toolText.slice(0, 200)}`
			: isRead
				? `read README.md: ${toolText.trim().slice(0, 200)}`
				: isWrite
					? `wrote ${/write\s+(\S+)/.exec(prompt)?.[1] ?? "file"}: ${toolText.trim().slice(0, 120)}`
					: isLateTool
						? `writing now: ${toolText.trim().slice(0, 120)}`
						: response(prompt);
		return new Response(textCompletion(reply), { headers: { "content-type": "text/event-stream" } });
	},
});

await Bun.write(
	path.join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			conformance: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				auth: "none",
				models: [{ id: "fixture", name: "fixture", input: ["text"], contextWindow: 1_000_000, maxTokens: 8192 }],
			},
		},
	}),
);

// The pinned corpus reads `README.md` from the session cwd the runner passes on
// `session/new`. The runner creates that directory but seeds no content, so seed it
// here (never inside the upstream corpus) when the harness names it.
const scratchCwd = process.env.GJC_ACP_CONFORMANCE_CWD?.trim();
if (scratchCwd) {
	const scratchReadme = path.join(scratchCwd, "README.md");
	if (!(await Bun.file(scratchReadme).exists())) await Bun.write(scratchReadme, "acpx conformance workspace\n");
}

child = Bun.spawn(
	[
		"bun",
		path.join(root, "packages", "coding-agent", "src", "cli.ts"),
		"--mode",
		"acp",
		"--model",
		"conformance/fixture",
	],
	{
		cwd: root,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);
process.once("SIGTERM", () => {
	void cleanup(0);
});
process.once("SIGINT", () => {
	void cleanup(0);
});
await child.exited;
await cleanup(child.exitCode ?? 1);
