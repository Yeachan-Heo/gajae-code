import * as fs from "node:fs";
import { withManagedSessionTransaction } from "../../src/session/internal/managed-session-transaction";

// TEST ONLY: a separate OS process that holds one session transaction so the
// parent test can observe real cross-process exclusion rather than in-process
// reentrancy behavior. The parent decides when the body may finish, which keeps
// the exclusion window independent of process startup time.
const [locksDirectory, sessionId, readyPath, releasePath] = process.argv.slice(2);
if (!locksDirectory || !sessionId || !readyPath || !releasePath) throw new Error("missing fixture arguments");
const waitMs = Number(process.env.GJC_TEST_TRANSACTION_WAIT_MS ?? "250");

try {
	await withManagedSessionTransaction({ locksDirectory, sessionId, waitMs }, async () => {
		// Publish the marker only once the lease is provably held.
		fs.writeFileSync(readyPath, `${process.pid}\n`);
		const deadline = Date.now() + 30_000;
		while (!fs.existsSync(releasePath)) {
			if (Date.now() >= deadline) throw new Error("fixture_release_timeout");
			await Bun.sleep(10);
		}
	});
	process.stdout.write("held\n");
	process.exit(0);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
