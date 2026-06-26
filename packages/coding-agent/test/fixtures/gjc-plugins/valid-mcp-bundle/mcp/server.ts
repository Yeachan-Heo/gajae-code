// Minimal newline-delimited JSON-RPC 2.0 MCP stdio server for tests.
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (msg: any): void => {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
};

rl.on("line", line => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let req: any;
	try {
		req = JSON.parse(trimmed);
	} catch {
		return;
	}
	const { id, method } = req;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "domain-docs", version: "1.0.0" },
			},
		});
	} else if (method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				tools: [
					{ name: "lookup", description: "Look up a domain doc", inputSchema: { type: "object", properties: {} } },
				],
			},
		});
	} else if (method === "tools/call") {
		// Echo whether the host secret leaked into the child environment so tests
		// can prove no-env isolation for plugin stdio MCP servers.
		const secret = process.env.GJC_PLUGIN_TEST_SECRET ?? "<absent>";
		send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `secret=${secret}` }] } });
	} else if (id !== undefined) {
		send({ jsonrpc: "2.0", id, result: {} });
	}
});
