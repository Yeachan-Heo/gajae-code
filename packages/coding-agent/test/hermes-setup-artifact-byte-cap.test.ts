import { describe, expect, it } from "bun:test";
import { YAML } from "bun";
import { runHermesSetup } from "../src/setup/hermes-setup";

const ROOT = process.cwd();

async function render(artifactByteCap: string) {
	return await runHermesSetup({ root: [ROOT], profile: "test", repo: "repo", json: true, artifactByteCap });
}

function renderedCap(result: Awaited<ReturnType<typeof runHermesSetup>>): unknown {
	const preview = result.previews?.find(entry => entry.path.endsWith(".yaml"));
	const parsed = YAML.parse(preview?.content ?? "") as {
		mcp_servers?: Record<string, { env?: Record<string, unknown> }>;
	};
	return parsed.mcp_servers?.gjc_coordinator?.env?.GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP;
}

describe("gjc setup hermes --artifact-byte-cap", () => {
	it("refuses an integer the runtime policy parser would discard", async () => {
		// Given a positive integer beyond Number.MAX_SAFE_INTEGER, which String() renders as "1e+21".
		// When setup renders it, Then it is refused instead of writing a cap the server would ignore.
		for (const cap of ["9007199254740992", "1e21"]) {
			await expect(render(cap)).rejects.toThrow("--artifact-byte-cap must be a positive integer.");
		}
	});

	it("still renders a safe integer as plain digits", async () => {
		expect(renderedCap(await render("1048576"))).toBe("1048576");
		expect(renderedCap(await render("1e6"))).toBe("1000000");
	});
});
