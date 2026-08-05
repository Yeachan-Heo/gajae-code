import { expect, test, vi } from "bun:test";
import { HttpTransport } from "./transports/http";

test("shared noReplay tools/call does not refresh OAuth or resend after 401", async () => {
	const transport = new HttpTransport({ type: "http", url: "https://example.test/mcp" });
	await transport.connect();
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
	const authRefresh = vi.fn(async () => ({ Authorization: "Bearer refreshed" }));
	transport.onAuthError = authRefresh;
	try {
		await expect(transport.request("tools/call", { name: "mutate" }, { noReplay: true })).rejects.toThrow("HTTP 401");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(authRefresh).not.toHaveBeenCalled();
	} finally {
		fetchSpy.mockRestore();
		await transport.close();
	}
});
