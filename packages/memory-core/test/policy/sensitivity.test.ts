import { describe, expect, it } from "bun:test";

import { scanSecretContent } from "../../src/policy/secret-scan";
import {
	checkSensitivity,
	enforceSensitivity,
	SENSITIVITY_LEVELS,
	SENSITIVITY_MATRIX,
	WRITE_DESTINATIONS,
} from "../../src/policy/sensitivity";

const EXPECTED_DESTINATIONS = [
	"global-canonical",
	"project-canonical",
	"session",
	"proposal",
	"checkpoint",
	"ledger",
	"redact-output",
	"export-output",
	"explain-output",
	"doctor-report",
] as const;

const EXPECTED_SENSITIVITIES = ["public-safe", "private", "restricted"] as const;

const EXPECTED_MATRIX = {
	"global-canonical": { "public-safe": true, private: true, restricted: true },
	"project-canonical": { "public-safe": true, private: true, restricted: true },
	session: { "public-safe": true, private: true, restricted: true },
	proposal: { "public-safe": true, private: true, restricted: false },
	checkpoint: { "public-safe": true, private: true, restricted: false },
	ledger: { "public-safe": true, private: false, restricted: false },
	"redact-output": { "public-safe": true, private: false, restricted: false },
	"export-output": { "public-safe": true, private: false, restricted: false },
	"explain-output": { "public-safe": true, private: false, restricted: false },
	"doctor-report": { "public-safe": true, private: false, restricted: false },
} as const;

describe("memory sensitivity policy", () => {
	it("exhausts every WriteDestination × Sensitivity cell", () => {
		expect(WRITE_DESTINATIONS).toEqual(EXPECTED_DESTINATIONS);
		expect(SENSITIVITY_LEVELS).toEqual(EXPECTED_SENSITIVITIES);
		expect(SENSITIVITY_MATRIX).toEqual(EXPECTED_MATRIX);

		for (const destination of EXPECTED_DESTINATIONS) {
			for (const sensitivity of EXPECTED_SENSITIVITIES) {
				const expectedAllowed = EXPECTED_MATRIX[destination][sensitivity];
				const checked = checkSensitivity({ destination, sensitivity });
				expect(checked.ok).toBe(true);
				if (!checked.ok) continue;
				expect(checked.value).toMatchObject({ destination, sensitivity, allowed: expectedAllowed });
				expect(checked.value.reason).toBe(
					expectedAllowed
						? "sensitivity is permitted for the destination"
						: "sensitivity is not permitted for the destination",
				);

				const enforced = enforceSensitivity(destination, sensitivity);
				if (expectedAllowed) {
					expect(enforced).toEqual({ ok: true, value: true });
				} else {
					expect(enforced.ok).toBe(false);
					if (enforced.ok) continue;
					if (enforced.error.code !== "sensitivity-violation") continue;
					expect(enforced.error).toMatchObject({
						code: "sensitivity-violation",
						exitCode: 11,
						destination,
					});
					expect(enforced.error.findings).toEqual([
						{
							kind: "sensitivity-label",
							patternId: null,
							sensitivity,
							line: 0,
							excerptRedacted: "[REDACTED]",
						},
					]);
				}
			}
		}
	});

	it("denies secret findings at every destination regardless of the sensitivity cell", () => {
		const scanned = scanSecretContent("token-abcdefghijkl");
		expect(scanned.ok).toBe(true);
		if (!scanned.ok) return;

		for (const destination of EXPECTED_DESTINATIONS) {
			for (const sensitivity of EXPECTED_SENSITIVITIES) {
				const enforced = enforceSensitivity(destination, sensitivity, scanned.value.findings);
				expect(enforced.ok).toBe(false);
				if (enforced.ok) continue;
				if (enforced.error.code !== "sensitivity-violation") continue;
				expect(enforced.error).toMatchObject({
					code: "sensitivity-violation",
					exitCode: 11,
					destination,
					findings: scanned.value.findings,
				});
				expect(JSON.stringify(enforced.error)).not.toContain("token-abcdefghijkl");
			}
		}
	});

	it("rejects every legacy override field instead of allowing a bypass", () => {
		const overrideFields = ["override", "allowSensitive", "allowSecrets", "force"] as const;
		for (const field of overrideFields) {
			for (const value of [false, true, null, "allow"] as const) {
				const checked = checkSensitivity({
					destination: "global-canonical",
					sensitivity: "public-safe",
					[field]: value,
				});
				expect(checked).toEqual({
					ok: false,
					error: {
						code: "policy-denied",
						exitCode: 6,
						destination: "global-canonical",
						reason: "sensitivity overrides are not supported",
					},
				});
			}
		}
	});
});
