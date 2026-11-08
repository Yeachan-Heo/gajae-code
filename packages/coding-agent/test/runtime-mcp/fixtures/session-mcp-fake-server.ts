// Minimal stdio MCP server used by the session MCP connect tests.
// It logs `spawn <name> <pid>` / `exit <name> <pid>` so tests can count real processes.
// Flags: --name <n> --log <file> [--delay-init ms] [--delay-if-exists <file> ms] [--fail] [--fail-if-exists <file>]
//        [--tools a,b]: tool names to list (default: echo)
//        [--grow-on <file>]: once <file> exists, also list `grown` and send tools/list_changed.
import { appendFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}
const name = flag("--name") ?? "fake";
const log = flag("--log");
const record = (line: string) => {
	if (log) appendFileSync(log, `${line}\n`);
};
record(`spawn ${name} ${process.pid}`);
process.on("exit", () => record(`exit ${name} ${process.pid}`));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
process.stdin.on("end", () => process.exit(0));

const failIfExists = flag("--fail-if-exists");
if (argv.includes("--fail") || (failIfExists && existsSync(failIfExists))) process.exit(3);

const delayInit = Number(flag("--delay-init") ?? 0);
const delayIfExistsIndex = argv.indexOf("--delay-if-exists");
const delayIfExists =
	delayIfExistsIndex === -1
		? undefined
		: { file: argv[delayIfExistsIndex + 1]!, ms: Number(argv[delayIfExistsIndex + 2]) };

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const baseTools = (flag("--tools") ?? "echo").split(",");
const growOn = flag("--grow-on");
if (growOn) {
	const timer = setInterval(() => {
		if (!existsSync(growOn)) return;
		clearInterval(timer);
		send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
	}, 50);
}
const tool = (toolName: string) => ({
	name: toolName,
	description: `${toolName} tool of ${name}`,
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
});

async function handle(message: { id?: number | string; method?: string; params?: { name?: string } }): Promise<void> {
	if (message.id === undefined) return;
	switch (message.method) {
		case "initialize": {
			let delay = delayInit;
			if (delayIfExists && existsSync(delayIfExists.file)) delay = Math.max(delay, delayIfExists.ms);
			if (delay > 0) await sleep(delay);
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: { listChanged: growOn !== undefined } },
					serverInfo: { name, version: "1.0.0" },
				},
			});
			return;
		}
		case "tools/list":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [...baseTools, ...(growOn && existsSync(growOn) ? ["grown"] : [])].map(tool) },
			});
			return;
		case "tools/call":
			send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name} ok` }] } });
			return;
		case "ping":
			send({ jsonrpc: "2.0", id: message.id, result: {} });
			return;
		default:
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) void handle(JSON.parse(line));
		newline = buffer.indexOf("\n");
	}
});
