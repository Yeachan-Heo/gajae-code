import * as native from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

// One query is ~0.3us, below timer/await noise; a batch makes the sample
// measure the native call rather than the harness.
const DETECT_BATCH = 1000;

const cases = [
	{
		// A01: DETECT_BATCH appearance queries per sample.
		id: "A01",
		run: () => {
			for (let i = 0; i < DETECT_BATCH; i++) {
				const appearance: unknown = native.detectMacOSAppearance();
				if (appearance !== null && appearance !== undefined && appearance !== "dark" && appearance !== "light") {
					throw new Error(`Unexpected macOS appearance: ${String(appearance)}`);
				}
			}
		},
	},
];

await runAbSuite("appearance", cases, 100);
