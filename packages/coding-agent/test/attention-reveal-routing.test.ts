import { describe, expect, test } from "bun:test";
import { resolveTaskRevealRoute } from "../src/modes/attention-reveal-routing";

describe("attention reveal routing", () => {
	test("routes bash and cron task kinds to the existing jobs owner", () => {
		expect(resolveTaskRevealRoute({ kind: "bash", id: "bash:bg_1" })).toEqual({
			kind: "jobs",
			taskId: "bg_1",
			sourceKind: "bash",
		});
		expect(resolveTaskRevealRoute({ kind: "subagent", id: "subagent:3-AuthLoader" })).toEqual({
			kind: "unavailable",
			reason: "unsupported_kind",
		});
		expect(resolveTaskRevealRoute({ kind: "cron", id: "cron:cron_1" })).toEqual({
			kind: "jobs",
			taskId: "cron_1",
			sourceKind: "cron",
		});
	});

	test("fails closed for unsupported, stale-shaped, and unsafe identities", () => {
		expect(resolveTaskRevealRoute({ kind: "unknown", id: "unknown:1" })).toEqual({
			kind: "unavailable",
			reason: "unsupported_kind",
		});
		expect(resolveTaskRevealRoute({ kind: "bash", id: "subagent:bg_1" })).toEqual({
			kind: "unavailable",
			reason: "malformed_id",
		});
		expect(resolveTaskRevealRoute({ kind: "bash", id: "bash:../secret" })).toEqual({
			kind: "unavailable",
			reason: "malformed_id",
		});
		expect(resolveTaskRevealRoute({ kind: "bash", id: "bash:" })).toEqual({
			kind: "unavailable",
			reason: "malformed_id",
		});
		expect(resolveTaskRevealRoute(null)).toEqual({ kind: "unavailable", reason: "malformed_id" });
	});
});
