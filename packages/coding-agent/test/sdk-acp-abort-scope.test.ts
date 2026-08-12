import { expect, test } from "bun:test";
import { resolveAcpAbortScope } from "../src/modes/acp/abort-scope";

test("resolveAcpAbortScope defaults to turn for an external client turn-end", () => {
	expect(resolveAcpAbortScope(undefined, {})).toBe("turn");
	expect(resolveAcpAbortScope(null, {})).toBe("turn");
	expect(resolveAcpAbortScope({}, {})).toBe("turn");
	expect(resolveAcpAbortScope({ gjc: {} }, {})).toBe("turn");
});

test("resolveAcpAbortScope honors _meta.gjc.abortScope over the environment", () => {
	expect(resolveAcpAbortScope({ gjc: { abortScope: "turn" } }, { GJC_ACP_ABORT_SCOPE: "owned" })).toBe("turn");
	expect(resolveAcpAbortScope({ gjc: { abortScope: "owned" } }, { GJC_ACP_ABORT_SCOPE: "turn" })).toBe("owned");
});

test("resolveAcpAbortScope falls back to GJC_ACP_ABORT_SCOPE when _meta is absent", () => {
	expect(resolveAcpAbortScope(undefined, { GJC_ACP_ABORT_SCOPE: "turn" })).toBe("turn");
	expect(resolveAcpAbortScope({}, { GJC_ACP_ABORT_SCOPE: "owned" })).toBe("owned");
});

test("resolveAcpAbortScope rejects malformed metadata and env values safely to turn", () => {
	expect(resolveAcpAbortScope({ gjc: { abortScope: "everything" } }, {})).toBe("turn");
	expect(resolveAcpAbortScope({ gjc: { abortScope: 42 } }, { GJC_ACP_ABORT_SCOPE: "turn" })).toBe("turn");
	expect(resolveAcpAbortScope(undefined, { GJC_ACP_ABORT_SCOPE: "invalid" })).toBe("turn");
});
