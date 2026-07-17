import { expect, test } from "bun:test";
import {
	assertNativeRuntimeCompatibility,
	NativeRuntimeCompatibilityError,
} from "../src/sdk/bus/native-runtime-compatibility";

test("accepts matching generated native build versions with workflow arbitration capabilities", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: {
				registerArbitratedAsk: () => {},
				retireIfUnclaimed: () => {},
				stopAndWait: () => {},
			},
		}),
	).not.toThrow();
});

class StaleNotificationServer {
	registerArbitratedAsk(): void {}
}

test("rejects a matching native build missing a required workflow arbitration capability", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: StaleNotificationServer.prototype,
		}),
	).toThrow(NativeRuntimeCompatibilityError);

	try {
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: StaleNotificationServer.prototype,
		});
	} catch (error) {
		expect(error).toMatchObject({
			code: "native_runtime_incompatible",
			retryable: false,
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			workflowArbitrationAvailable: false,
		});
	}
});
test("rejects a matching native build missing stopAndWait", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.2",
			notificationServer: {
				registerArbitratedAsk: () => {},
				retireIfUnclaimed: () => {},
			},
		}),
	).toThrow(NativeRuntimeCompatibilityError);
});
test("rejects mismatched generated native build versions as non-retryable compatibility errors", () => {
	expect(() =>
		assertNativeRuntimeCompatibility({
			runtimeVersion: "0.10.2",
			nativeVersion: "0.10.1",
			notificationServer: {
				registerArbitratedAsk: () => {},
				retireIfUnclaimed: () => {},
				stopAndWait: () => {},
			},
		}),
	).toThrow(NativeRuntimeCompatibilityError);
});
