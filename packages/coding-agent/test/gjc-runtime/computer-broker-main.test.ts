import { expect, it } from "bun:test";
import { parseArgs } from "@gajae-code/coding-agent/cli/args";
import { runRootCommand } from "@gajae-code/coding-agent/main";

it("acquires the managed computer broker lease before root-command routing", async () => {
	const events: string[] = [];
	await runRootCommand(parseArgs(["--resume"]), [], {
		acquireComputerBrokerLease: async () => {
			events.push("acquire");
		},
		isResumePickerTerminal: () => {
			events.push("route");
			return false;
		},
		suppressProcessExit: true,
	});
	expect(events).toEqual(["acquire", "route"]);
});
