import { expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as loaderState from "../../natives/native/loader-state.js";
import { __resetResourceGcForTest, __sampleWindowsJobMemoryForTest } from "../src/tools/resource-gc";

test("resource GC loads the Windows memory probe through the top-level native loader", async () => {
	const source = await Bun.file(path.join(import.meta.dir, "../src/tools/resource-gc.ts")).text();

	expect(source).toContain(
		'import { loadNative as loadNativeBindings } from "../../../natives/native/loader-state.js";',
	);
	expect(source).not.toContain('require("@gajae-code/natives")');
});

test("resource GC resolves the native memory probe once across repeated samples", async () => {
	const loadNativeSpy = vi.spyOn(loaderState, "loadNative").mockReturnValue({
		probeWindowsJobMemory: () => ({ kind: "unsupported_platform", platform: "win32" }),
	});
	try {
		loadNativeSpy.mockClear();
		__resetResourceGcForTest();

		expect(__sampleWindowsJobMemoryForTest(1024, 512)).toBeNull();
		expect(__sampleWindowsJobMemoryForTest(1024, 512)).toBeNull();
		expect(loadNativeSpy).toHaveBeenCalledTimes(1);
	} finally {
		loadNativeSpy.mockRestore();
	}
});
