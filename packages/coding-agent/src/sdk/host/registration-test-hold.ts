/**
 * Test seam for the single-owner flow tests (design §13 H3): hold a session host's broker
 * registration while it already holds the session claim but has no endpoint in the index.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { startupProjectEnvSnapshot } from "@gajae-code/utils/env";
import { projectEnvSnapshot } from "@gajae-code/utils/env-file";
import { trustedCoordinatorEnv } from "../../gjc-runtime/sidecar-bootstrap-env";

const HOST_REGISTRATION_HOLD_DIR_ENV = "GJC_SDK_TEST_HOST_REGISTRATION_HOLD_DIR";
const HOST_REGISTRATION_HOLD_MAX_MS = 60_000;

/**
 * The hold directory from the operator's environment only: a value the project dotenv supplied, in
 * the current directory or in the one this process started in, is ignored and removed from this
 * process's environment, so no child inherits it. An unset variable costs no read.
 */
function trustedHostRegistrationHoldDirectory(): string | undefined {
	if (!process.env[HOST_REGISTRATION_HOLD_DIR_ENV]) return undefined;
	let accepted: string | undefined;
	for (const snapshot of [projectEnvSnapshot(process.cwd()), startupProjectEnvSnapshot()]) {
		accepted = trustedCoordinatorEnv(HOST_REGISTRATION_HOLD_DIR_ENV, process.env, snapshot);
		if (accepted === undefined) {
			delete process.env[HOST_REGISTRATION_HOLD_DIR_ENV];
			return undefined;
		}
	}
	return accepted;
}

/**
 * While `<dir>/<sessionId>.hold` exists, defer this host's broker registration (at most 60 s).
 * `SessionSdkHost.registerWithBroker` calls it, so it holds an interactive TUI and a broker-launched
 * host alike: both register through that method. `undefined`, with nothing awaited, when the seam
 * is not set, so registration keeps its ordering outside the tests that use it.
 */
export function awaitHostRegistrationTestHold(sessionId: string): Promise<void> | undefined {
	const directory = trustedHostRegistrationHoldDirectory();
	return directory ? waitWhileHeld(path.join(directory, `${sessionId}.hold`)) : undefined;
}

async function waitWhileHeld(hold: string): Promise<void> {
	const held = (): Promise<boolean> =>
		fs.stat(hold).then(
			() => true,
			() => false,
		);
	const deadline = Date.now() + HOST_REGISTRATION_HOLD_MAX_MS;
	while (Date.now() < deadline && (await held())) await Bun.sleep(50);
}
