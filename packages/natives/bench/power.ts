import * as native from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

interface PowerAssertionHandle {
	stop(): void | Promise<void>;
}

interface PowerAssertionConstructor {
	start(options: { reason: string }): PowerAssertionHandle | Promise<PowerAssertionHandle>;
}

// The pre-port base exports MacOSPowerAssertion; HEAD exports PowerAssertion.
const powerAssertion = (
	native as unknown as {
		PowerAssertion?: PowerAssertionConstructor;
		MacOSPowerAssertion?: PowerAssertionConstructor;
	}
).PowerAssertion ?? (native as unknown as { MacOSPowerAssertion?: PowerAssertionConstructor }).MacOSPowerAssertion;

if (!powerAssertion) throw new Error("Native power assertion class is unavailable");

const cases = [
	{
		id: "W01",
		run: async () => {
			let assertion: PowerAssertionHandle | undefined;
			try {
				const started: unknown = await powerAssertion.start({ reason: "A/B benchmark transient assertion" });
				if (
					typeof started !== "object" ||
					started === null ||
					typeof (started as { stop?: unknown }).stop !== "function"
				) {
					throw new Error("Power assertion start returned an invalid handle");
				}
				assertion = started as PowerAssertionHandle;
			} finally {
				if (assertion) await assertion.stop();
			}
		},
	},
];

await runAbSuite("power", cases, 50);
