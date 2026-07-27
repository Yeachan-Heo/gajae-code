import { describe, expect, test } from "bun:test";
import { addFieldShapes, descriptorsFromReadme, descriptorsFromRustSource, fetchPinnedText, readmeMinimumMethodCount, resolveBundleFromSources, rustFailureDiagnostic } from "./sync-codex-app-server-schema.ts";

const rustSource = `
client_request_definitions! {
	#[experimental("experimental/first")]
	ExperimentalFirst => "experimental/first" { params: v2::ExperimentalFirstParams, serialization: None, response: v2::ExperimentalFirstResponse, },
	StableSecond => "stable/second" { params: v2::StableSecondParams, serialization: None, response: v2::StableSecondResponse, },
}
server_request_definitions! {
	ApplyPatchApproval { params: v1::ApplyPatchApprovalParams, response: v1::ApplyPatchApprovalResponse, },
	ExecCommandApproval { params: v1::ExecCommandApprovalParams, response: v1::ExecCommandApprovalResponse, },
}
server_notification_definitions! {
	#[serde(rename = "account/login/completed")]
	#[ts(rename = "account/login/completed")]
	AccountLoginCompleted(v2::AccountLoginCompletedNotification),
}
client_notification_definitions! { Initialized, }
`;

const readme = Array.from({ length: readmeMinimumMethodCount }, (_, index) => `- \`method/${index}\` — stable request`).join("\n");
const pinnedRustSource = "https://raw.githubusercontent.com/openai/codex/81da9deb065d7adb283816b19b40f89bcc484276/codex-rs/app-server-protocol/src/protocol/common.rs";

describe("pinned Codex app-server source sync", () => {
	test("throws with the fetch diagnostic when the pinned source request fails", async () => {
		const cause = new Error("network unavailable");
		await expect(fetchPinnedText("https://example.invalid/protocol.rs", async () => { throw cause; })).rejects.toThrow("Failed to fetch pinned Codex source");
		try {
			await fetchPinnedText("https://example.invalid/protocol.rs", async () => { throw cause; });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error & { cause?: unknown }).cause).toBe(cause);
		}
	});

	test("throws on a non-success pinned source response", async () => {
		await expect(fetchPinnedText("https://example.invalid/protocol.rs", async () => new Response("gone", { status: 404, statusText: "Not Found" }))).rejects.toThrow("HTTP 404 Not Found");
	});

	test("parses entry-scoped experimental annotations, omitted wires, and rename attributes", () => {
		const bundle = descriptorsFromRustSource(rustSource);
		expect(bundle.directions.clientRequests).toEqual([
			expect.objectContaining({ method: "experimental/first", stability: "experimental" }),
			expect.objectContaining({ method: "stable/second", stability: "stable" }),
		]);
		expect(bundle.directions.serverRequests.map(entry => entry.method)).toEqual(["applyPatchApproval", "execCommandApproval"]);
		expect(bundle.directions.serverNotifications).toEqual([expect.objectContaining({ method: "account/login/completed" })]);
	});

	test("keeps stable entries adjacent to experimental entries stable in the pinned Rust catalog", async () => {
		const bundle = descriptorsFromRustSource(await fetchPinnedText(pinnedRustSource));
		const stableMethods = ["thread/name/set", "thread/compact/start", "thread/read", "thread/rollback", "review/start", "model/list", "mcpServer/oauth/login", "config/read"];
		for (const method of stableMethods) expect(bundle.directions.clientRequests.find(entry => entry.method === method)?.stability).toBe("stable");
	});

	test("uses README fallback only when opted in and preserves the Rust failure diagnostic", async () => {
		const sourceFailure = new Error("pinned Rust unavailable");
		await expect(resolveBundleFromSources(false, async () => { throw sourceFailure; }, async () => readme)).rejects.toBe(sourceFailure);
		const resolved = await resolveBundleFromSources(true, async () => { throw sourceFailure; }, async () => readme);
		expect(resolved.bundle.derivation).toBe("readme-derived");
		expect(resolved.rustSourceFailure).toContain("pinned Rust unavailable");
	});

	test("rejects empty or malformed README fallback catalogs", () => {
		expect(() => descriptorsFromReadme("")).toThrow("README fallback parser drift");
		expect(() => descriptorsFromReadme("not a method catalog")).toThrow("README fallback parser drift");
	});

	test("preserves a bounded primary Rust failure diagnostic", () => {
		const diagnostic = rustFailureDiagnostic(new Error("rust parser failed"));
		expect(diagnostic).toContain("rust parser failed");
		expect(rustFailureDiagnostic("x".repeat(2_000))).toHaveLength(1_000);
	});

	test("throws when Rust macro parsing drifts or yields no catalog entries", () => {
		expect(() => descriptorsFromRustSource("client_request_definitions! {}"))
			.toThrow("Pinned Rust parser drift");
	});
});

	test("captures serde-renamed required and optional Rust fields with unresolved references", () => {
		const bundle = descriptorsFromRustSource(rustSource);
		const shaped = addFieldShapes(bundle, {
			"v2/example.rs": `
				#[derive(Serialize)]
				#[serde(rename_all = "camelCase")]
				pub struct ExperimentalFirstParams {
					pub required_value: String,
					#[serde(rename = "explicitName", skip_serializing_if = "Option::is_none")]
					pub optional_value: Option<ExternalType>,
				}
				pub struct ExperimentalFirstResponse { pub answer: u64, }
			`,
		});
		const entry = shaped.directions.clientRequests[0]!;
		expect(shaped.authorityLevel).toBe("method-and-field-shapes");
		expect(entry.params.fields).toEqual([
			{ name: "requiredValue", rustType: "String", optional: false, skipSerializingIf: null },
			{ name: "explicitName", rustType: "Option<ExternalType>", optional: true, skipSerializingIf: "Option::is_none" },
		]);
		expect(entry.params.unresolved).toEqual(["ExternalType"]);
	});
