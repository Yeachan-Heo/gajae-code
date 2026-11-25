/**
 * Holds a session claim for `session-ownership-process.test.ts`.
 *
 * Runs with `HOME` set to the test's temp home, claims `OWNER_SESSION_ID` as `OWNER_SURFACE`,
 * optionally starts a grandchild through the native shell (which, unlike `Bun.spawn`, passes
 * every descriptor without close-on-exec to the child), prints one JSON ready line, then
 * releases on a `release` line from stdin.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeShell } from "@gajae-code/natives";
import {
	claimSessionOwner,
	type SessionOwnerSurface,
	sessionOwnersDirectory,
} from "../../src/session/session-ownership";

const home = process.env.HOME;
const sessionId = process.env.OWNER_SESSION_ID;
const surface = (process.env.OWNER_SURFACE ?? "terminal") as SessionOwnerSurface;
const grandchildPidFile = process.env.OWNER_GRANDCHILD_PID_FILE;
if (!home || !sessionId) throw new Error("missing HOME or OWNER_SESSION_ID");
// Never claim outside the test's temp home.
if (!sessionOwnersDirectory().startsWith(`${await fs.realpath(home)}${path.sep}`)) {
	process.stdout.write(`${JSON.stringify({ status: "home_escaped" })}\n`);
	process.exit(3);
}

const result = await claimSessionOwner(sessionId, { surface });
if (result.status !== "claimed") {
	process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
	process.exit(3);
}

let grandchild: number | null = null;
if (grandchildPidFile) {
	void executeShell({
		command: `/bin/sh -c 'echo $$ > "$OWNER_GRANDCHILD_PID_FILE"; exec sleep 60'`,
		env: { OWNER_GRANDCHILD_PID_FILE: grandchildPidFile },
	});
	const deadline = Date.now() + 10_000;
	while (grandchild === null) {
		const text = await fs.readFile(grandchildPidFile, "utf8").catch(() => "");
		if (text.endsWith("\n")) grandchild = Number(text.trim());
		else if (Date.now() > deadline) throw new Error("grandchild never wrote its pid");
		else await Bun.sleep(10);
	}
}

process.stdout.write(`${JSON.stringify({ status: result.status, pid: process.pid, grandchild })}\n`);

for await (const chunk of process.stdin) {
	if (Buffer.from(chunk).toString("utf8").includes("release")) {
		result.claim.release();
		process.stdout.write("released\n");
	}
}
