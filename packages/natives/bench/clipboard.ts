// A/B adapter: clipboard image read (C-CLIPBOARD). Read-only: it never writes
// the clipboard, so it is safe on a developer host. readImageFromClipboard
// exists with the same signature at 01511ffd5f and on dev.
import { readImageFromClipboard } from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

// One query is ~10us, near the timer and scheduling noise floor; a batch per
// sample measures the native call rather than the harness.
const READ_BATCH = 200;

await runAbSuite(
	"clipboard",
	[
		{
			// C01: READ_BATCH pasteboard image queries, validating every payload.
			id: "C01",
			run: async () => {
				for (let i = 0; i < READ_BATCH; i++) {
					const image = await readImageFromClipboard();
					if (image === null || image === undefined) continue;
					if (!(image.data instanceof Uint8Array) || image.data.length === 0) {
						throw new Error("readImageFromClipboard returned an empty image payload");
					}
				}
			},
		},
	],
	50,
);
