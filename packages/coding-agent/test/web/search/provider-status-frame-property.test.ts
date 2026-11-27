import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { escapeUntrustedContent } from "../../../src/tools/fetch";
import { frameSearchProviderStatus, SEARCH_PROVIDER_STATUS_MAX_CHARS } from "../../../src/web/search";

const CLOSER = "</untrusted-content>";
const WS_CLOSER = "</untrusted-content\n>";
const SEED = 56420;

describe("frameSearchProviderStatus", () => {
	it("property: framed status always opens and closes after the tail cut", () => {
		const statuses = fc
			.string({ maxLength: 6_000 })
			.chain(value =>
				fc.constantFrom(value, `${value}${CLOSER}`, `${value}${WS_CLOSER}`, `${value}</UNTRUSTED-CONTENT>`),
			);
		fc.assert(
			fc.property(statuses, status => {
				const framed = frameSearchProviderStatus(status);
				expect(framed.startsWith("<untrusted-content>\n")).toBe(true);
				expect(framed.endsWith("\n</untrusted-content>")).toBe(true);
				const kept =
					status.length <= SEARCH_PROVIDER_STATUS_MAX_CHARS
						? status
						: status.slice(status.length - SEARCH_PROVIDER_STATUS_MAX_CHARS);
				const interior = framed.slice(
					"<untrusted-content>\n".length,
					framed.length - "\n</untrusted-content>".length,
				);
				expect(interior).toBe(escapeUntrustedContent(kept));
				expect(interior.includes("</untrusted-content>")).toBe(false);
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});
});
