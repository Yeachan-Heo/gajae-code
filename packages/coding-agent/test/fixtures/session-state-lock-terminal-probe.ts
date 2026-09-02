import * as fs from "node:fs/promises";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import {
	SessionStateLockTestHooks,
	setSessionStateLockNativeBindings,
	withSessionStateFileLock,
} from "../../src/gjc-runtime/session-state-lock";
import { exactIdentityNativeBindings } from "../helpers/exact-identity-natives";

const scenario = process.argv[2];
const root = process.argv[3];
if (!scenario || !root) throw new Error("scenario and root are required");

const stateFile = path.join(root, "runtime-state.json");
const readyFile = path.join(root, "ready");
const enteredFile = path.join(root, "cleanup-lock-entered");

setSessionStateLockNativeBindings(() => exactIdentityNativeBindings);
SessionStateLockTestHooks.ownerHostId = () => "terminal-probe-host";
SessionStateLockTestHooks.legacyOwnerHostId = () => "terminal-probe-legacy-host";
SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;

// This callback starts only after a signal/fatal/quit has already entered postmortem.
// It acquires a session-state lock and deliberately outlives the cleanup deadline, proving
// the synchronous terminal phase observes locks acquired after termination began.
postmortem.register("terminal-probe-late-lock", async () => {
	await withSessionStateFileLock(stateFile, async () => {
		await Bun.write(enteredFile, "entered\n");
		await new Promise<never>(() => {});
	});
});

await fs.writeFile(readyFile, "ready\n");

switch (scenario) {
	case "sigint":
	case "sigterm":
	case "sighup":
		await new Promise<never>(() => {});
		break;
	case "uncaught-exception":
		setTimeout(() => {
			throw new Error("terminal probe uncaught exception");
		}, 10);
		await new Promise<never>(() => {});
		break;
	case "unhandled-rejection":
		setTimeout(() => {
			void Promise.reject(new Error("terminal probe unhandled rejection"));
		}, 10);
		await new Promise<never>(() => {});
		break;
	case "quit":
		await postmortem.quit(7);
		break;
	default:
		throw new Error(`unknown scenario: ${scenario}`);
}
