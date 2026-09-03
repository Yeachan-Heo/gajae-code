import * as fs from "node:fs/promises";
import * as path from "node:path";
import "@gajae-code/utils";
import {
	SessionStateLockTestHooks,
	setSessionStateLockNativeBindings,
	withSessionStateFileLock,
} from "../../src/gjc-runtime/session-state-lock";
import { exactIdentityNativeBindings } from "../helpers/exact-identity-natives";

const root = process.argv[2];
if (!root) throw new Error("root is required");

const stateFile = path.join(root, "runtime-state.json");
setSessionStateLockNativeBindings(() => exactIdentityNativeBindings);
SessionStateLockTestHooks.ownerHostId = () => "forced-exit-probe-host";
SessionStateLockTestHooks.legacyOwnerHostId = () => "forced-exit-probe-legacy-host";
SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;

SessionStateLockTestHooks.beforeCurrentOwnerRelease = async file => {
	if (file !== `${stateFile}.lock.transition.owner`) return;
	await Bun.write(path.join(root, "lock-held"), "held\n");
	await new Promise<never>(() => {});
};

void withSessionStateFileLock(stateFile, async () => undefined);
for (let attempt = 0; attempt < 200; attempt++) {
	if (await fs.exists(path.join(root, "lock-held"))) break;
	await Bun.sleep(10);
}
await fs.writeFile(path.join(root, "ready"), "ready\n");
await new Promise<never>(() => {});
