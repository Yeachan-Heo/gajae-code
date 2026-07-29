// Spills a revision-store snapshot to a temp directory, prints where it landed,
// then either exits abnormally (SIGTERM path) or closes cleanly, depending on
// argv[2]. Used to prove the postmortem sweep actually removes the directory.
import { RevisionStore, trackedSpillDirectoriesForTest } from "../../src/sdk/host/query/revision-store";

const mode = process.argv[2] ?? "abort";
const store = new RevisionStore("probe-session");

// Push a payload large enough to force a spill to disk.
const big = "x".repeat(20 * 1024 * 1024);
await store.createRevision("probe", "probe-resource", { body: big });

const dirs = trackedSpillDirectoriesForTest();
console.log(JSON.stringify({ dirs }));

if (mode === "close") {
	await store.close();
	console.log(JSON.stringify({ afterClose: trackedSpillDirectoriesForTest() }));
	process.exit(0);
}

// Abnormal path: let the harness signal us so postmortem runs.
setTimeout(() => process.exit(1), 30_000);
