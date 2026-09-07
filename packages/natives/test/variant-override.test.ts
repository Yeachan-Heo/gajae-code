import { describe, expect, it } from "bun:test";
import { getVariantOverride } from "../native/loader-state.js";

describe("getVariantOverride", () => {
	it("honors the documented GJC_NATIVE_VARIANT name", () => {
		// The three natives docs name `GJC_NATIVE_VARIANT`, and
		// docs/natives-build-release-debugging.md prescribes it as the remedy when
		// an x64 machine loads the wrong variant. Only `PI_NATIVE_VARIANT` was
		// read, so following that remedy silently kept the auto-detected variant.
		expect(getVariantOverride({ GJC_NATIVE_VARIANT: "baseline" })).toBe("baseline");
		expect(getVariantOverride({ GJC_NATIVE_VARIANT: "modern" })).toBe("modern");
	});

	it("keeps honoring the pre-rebrand PI_NATIVE_VARIANT name", () => {
		expect(getVariantOverride({ PI_NATIVE_VARIANT: "baseline" })).toBe("baseline");
		expect(getVariantOverride({ PI_NATIVE_VARIANT: "modern" })).toBe("modern");
	});

	it("prefers the canonical name over the legacy alias", () => {
		expect(getVariantOverride({ GJC_NATIVE_VARIANT: "modern", PI_NATIVE_VARIANT: "baseline" })).toBe("modern");
	});

	it("treats an empty or blank canonical value as absent", () => {
		expect(getVariantOverride({ GJC_NATIVE_VARIANT: "", PI_NATIVE_VARIANT: "baseline" })).toBe("baseline");
		expect(getVariantOverride({ GJC_NATIVE_VARIANT: "   ", PI_NATIVE_VARIANT: "baseline" })).toBe("baseline");
		expect(getVariantOverride({ GJC_NATIVE_VARIANT: "" })).toBeNull();
	});

	it("ignores invalid values under either name", () => {
		// docs/natives-architecture.md: "invalid values are ignored".
		expect(getVariantOverride({ GJC_NATIVE_VARIANT: "bogus" })).toBeNull();
		expect(getVariantOverride({ PI_NATIVE_VARIANT: "Modern" })).toBeNull();
		expect(getVariantOverride({})).toBeNull();
	});
});
