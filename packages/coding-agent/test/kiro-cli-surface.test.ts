import { describe, expect, it } from "bun:test";
import { getExtraHelpText } from "../src/cli/fast-help";
import { EMBEDDED_DOCS } from "../src/internal-urls/docs-index.generated";

const ENV_DOC_FILENAME = "environment-variables.md";

/**
 * Kiro is reached through a self-hosted relay, so both env vars are load-bearing:
 * `KIRO_API_KEY` gates relay model discovery (`/model` enumerates nothing without
 * it) and `KIRO_BASE_URL` moves the endpoint off the default port it shares with
 * llama.cpp. A provider whose env surface is missing from live `--help` is
 * undiscoverable.
 *
 * The rows are pinned in full rather than by name so the description text and each
 * row's own separator column stay regression-guarded, instead of passing on a row
 * that renders with the wrong padding. This pins these two rows, not the block-wide
 * alignment invariant. Byte-level freshness of the embedded docs corpus is gated
 * separately in `docs-index-lazy.test.ts`; the assertion here is that the reference
 * doc these rows point at genuinely carries both vars.
 */
describe("kiro CLI surface", () => {
	it("lists the Kiro relay env rows in live --help output", () => {
		const help = getExtraHelpText();

		expect(help).toContain("  KIRO_API_KEY               - Kiro relay models (kiro-go / kiro2api)");
		expect(help).toContain("  KIRO_BASE_URL              - Kiro relay endpoint (default http://127.0.0.1:8080/v1)");
	});

	it("documents both Kiro env vars in the referenced env doc", () => {
		const envDoc = EMBEDDED_DOCS[ENV_DOC_FILENAME];

		expect(envDoc).toBeTruthy();
		expect(envDoc).toContain("| `KIRO_API_KEY` ");
		expect(envDoc).toContain("| `KIRO_BASE_URL` ");
	});
});
