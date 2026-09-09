import { runNativeSmokeTest } from "../native-smoke";
import type { DoctorProbeReceipt } from "./probe-types";

export async function collectNativeProbe(): Promise<DoctorProbeReceipt> {
	await runNativeSmokeTest();
	return {
		schemaVersion: 1,
		kind: "native",
		status: "completed",
		reasonCode: "native_exports_verified",
		checks: [],
	};
}
