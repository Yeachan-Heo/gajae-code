import * as fs from "node:fs";
import * as path from "node:path";
import {
	FileSessionStorage,
	readSessionCommitMarkerSync,
	replaceSessionCommitMarkerCheckedSync,
} from "../../../src/session/session-storage";

const root = process.env.GJC_MARKER_RACE_ROOT;
const publisher = process.env.GJC_MARKER_RACE_PUBLISHER;
const generation = Number(process.env.GJC_MARKER_RACE_GENERATION);
if (!root || !publisher || !Number.isSafeInteger(generation))
	throw new Error("Missing marker race worker configuration");

const markerPath = path.join(root, "session.spill.commit");
const storage = new FileSessionStorage();
const state = readSessionCommitMarkerSync(storage, markerPath);
if (state.kind !== "present") throw new Error("Expected initial marker");
fs.writeFileSync(path.join(root, `ready-${publisher}`), "ready\n");
while (!fs.existsSync(path.join(root, "go"))) await Bun.sleep(1);

try {
	replaceSessionCommitMarkerCheckedSync(
		storage,
		markerPath,
		Buffer.from(`${JSON.stringify({ gen: generation })}\n`, "utf8"),
		{
			rawBytesSha256: state.rawBytesSha256,
			descriptorIdentity: state.stat,
		},
	);
	process.stdout.write(JSON.stringify({ outcome: "published", generation }));
} catch (error) {
	process.stdout.write(
		JSON.stringify({
			outcome: "rejected",
			generation,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
}
