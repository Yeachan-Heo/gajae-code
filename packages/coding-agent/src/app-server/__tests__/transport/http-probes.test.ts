import { expect, test } from "bun:test";
import { handleHealthProbe } from "../../transport/http-probes";

test("handleHealthProbe: /readyz returns 200 when no Origin header", () => {
	const res = handleHealthProbe({ method: "GET", path: "/readyz", headers: {} });
	expect(res).not.toBeNull();
	expect(res!.status).toBe(200);
});

test("handleHealthProbe: /healthz returns 200 when no Origin header", () => {
	const res = handleHealthProbe({ method: "GET", path: "/healthz", headers: {} });
	expect(res).not.toBeNull();
	expect(res!.status).toBe(200);
});

test("handleHealthProbe: any request with an Origin header gets 403", () => {
	for (const path of ["/readyz", "/healthz", "/anything"]) {
		const res = handleHealthProbe({ method: "GET", path, headers: { origin: "https://evil.com" } });
		expect(res).not.toBeNull();
		expect(res!.status).toBe(403);
	}
});

test("handleHealthProbe: a non-probe path with no Origin returns null (pass to upgrade)", () => {
	const res = handleHealthProbe({ method: "GET", path: "/some/other/path", headers: {} });
	expect(res).toBeNull();
});

test("handleHealthProbe: a WebSocket upgrade path returns null", () => {
	const res = handleHealthProbe({ method: "GET", path: "/", headers: { upgrade: "websocket" } });
	expect(res).toBeNull();
});
