import { describe, expect, it } from "bun:test";
import { cleanReason } from "../src/auth-broker/redact";

/**
 * `cleanReason` keeps provider and upstream failure text safe for less-trusted
 * surfaces, so its input is remote-influenced: it is the message an upstream
 * auth endpoint produced, not text this process composed.
 */
describe("cleanReason", () => {
	it("scans a large credential-free reason in linear time", () => {
		// The URL-credential rule accepted an unbounded scheme before the literal
		// `://`, so a long alphabetic run was re-tried at every prefix. That is
		// quadratic in the length of the reason: 100 KB cost ~2.6s.
		for (const body of ["x".repeat(100_000), "a-b.c+".repeat(20_000)]) {
			const startedAt = performance.now();
			const out = cleanReason(body);
			const elapsedMs = performance.now() - startedAt;
			expect(out).toBeDefined();
			// Linear scanning lands well under a millisecond; the budget is loose so
			// it fails only on quadratic scanning.
			expect(elapsedMs).toBeLessThan(1_000);
		}
	});

	it("still redacts url userinfo across real scheme shapes", () => {
		for (const [input, secret] of [
			["connect failed https://alice:https-secret-value@example.com/x", "https-secret-value"],
			["connect failed postgres://svc:pg-secret-value@db.internal:5432/app", "pg-secret-value"],
			["connect failed git+ssh://deploy:ssh-secret-value@git.example.com/x.git", "ssh-secret-value"],
		] as const) {
			const out = cleanReason(input);
			expect(out).toBeDefined();
			expect(out).not.toContain(secret);
			// The scheme stays readable so the reason still names the remote.
			expect(out).toContain(input.slice(input.indexOf("://") - 5, input.indexOf("://") + 3).slice(-8));
		}
	});
});
