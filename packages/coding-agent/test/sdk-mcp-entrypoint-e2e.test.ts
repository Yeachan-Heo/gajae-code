import { expect, test } from "bun:test";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const script = path.join(packageRoot, "test", "fixtures", "sdk-mcp-entrypoint-e2e-script.ts");

// The fixture script runs the SHIPPED `gjc mcp-serve sdk` entrypoint as a
// subprocess, feeds it JSON-RPC over stdio, and proves that session queries
// reach a recorded SDK WebSocket while G02 endpoint-credential requests are
// rejected before any send. It exits nonzero with a thrown error otherwise.
test("gjc mcp-serve sdk serves the SDK MCP adapter end-to-end", async () => {
	const child = Bun.spawn(["bun", script], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
	const exitCode = await child.exited;
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
	expect(stdout).toContain("MCP-SDK-E2E-OK");
	expect(stdout).toContain("query_request");
}, 60000);
