import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { readJsonlStream } from "../bench/multisession/jsonl";

const CHANNEL = path.join(import.meta.dir, "../bench/multisession/channel.ts");

// A root that spawns a long-lived child as soon as the driver releases it.
const ROOT_SCRIPT = `
import { driverCommands, emitToDriver } from ${JSON.stringify(CHANNEL)};
for await (const command of driverCommands()) {
	if (command.type === "go") {
		const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
		emitToDriver({ type: "child", pid: child.pid });
	}
}
`;

async function childrenOf(pid: number): Promise<number[]> {
	const out = await $`pgrep -P ${pid}`.nothrow().quiet().text();
	return out
		.split("\n")
		.map(line => Number(line.trim()))
		.filter(value => value > 0);
}

const spawned: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];

afterEach(async () => {
	for (const proc of spawned.splice(0)) proc.kill("SIGKILL");
});

describe("bench multisession root registration handshake", () => {
	test("a root creates no descendants before the driver's ack", async () => {
		const root = Bun.spawn([process.execPath, "-e", ROOT_SCRIPT], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		spawned.push(root);
		// Without an ack the root stays blocked and starts nothing.
		await Bun.sleep(750);
		expect(await childrenOf(root.pid)).toEqual([]);

		root.stdin.write(`${JSON.stringify({ type: "ack" })}\n${JSON.stringify({ type: "go" })}\n`);
		root.stdin.flush();
		const events = readJsonlStream<{ type: string; pid: number }>(root.stdout, "root stdout");
		const first = await events.next();
		expect(first.value?.type).toBe("child");
		const childPid = first.value?.pid ?? 0;
		spawned.push({ kill: () => process.kill(childPid, "SIGKILL") });
		expect(await childrenOf(root.pid)).toContain(childPid);
	});

	test("a command before ack is rejected and the root does no work", async () => {
		const root = Bun.spawn([process.execPath, "-e", ROOT_SCRIPT], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		spawned.push(root);
		root.stdin.write(`${JSON.stringify({ type: "go" })}\n`);
		root.stdin.flush();
		expect(await root.exited).not.toBe(0);
		expect(await new Response(root.stderr).text()).toContain("expected ack before go");
		expect(await childrenOf(root.pid)).toEqual([]);
	});
});
