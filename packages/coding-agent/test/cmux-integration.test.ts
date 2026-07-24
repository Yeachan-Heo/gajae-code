import { describe, expect, it } from "bun:test";
import { type CmuxCommandRunner, CmuxPresentationAdapter, CmuxProjectionSubscription } from "../src/cmux/integration";
import { EventBus } from "../src/utils/event-bus";

const HELP =
	"cmux 0.64.20: browser open --focus new-surface agent-session surface identify --id-format <refs|uuids|both> capabilities";
const IDENTIFY_UUIDS_06420 = JSON.stringify({
	caller: {
		pane_id: "00000000-0000-4000-8000-000000000001",
		surface_id: "00000000-0000-4000-8000-000000000002",
		workspace_id: "00000000-0000-4000-8000-000000000003",
	},
});

function runner(calls: string[][], failures = new Set<string>()): CmuxCommandRunner {
	return {
		async run(_command, args) {
			calls.push([...args]);
			if (failures.has(args[0])) return { exitCode: 1, stdout: "", stderr: "token=secret https://private.example" };
			if (args[0] === "help") return { exitCode: 0, stdout: HELP, stderr: "" };
			if (args.at(-1) === "identify")
				return {
					exitCode: 0,
					stdout: IDENTIFY_UUIDS_06420,
					stderr: "",
				};
			if (args[0] === "new-surface") return { exitCode: 0, stdout: "surface-1\n", stderr: "" };
			return { exitCode: 0, stdout: "ok", stderr: "" };
		},
	};
}

describe("CmuxPresentationAdapter", () => {
	it("disables absent or partial environments without invoking cmux", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({ env: {}, runner: runner(calls) });
		await adapter.presentResearch("https://example.com");
		expect(adapter.capability).toBe("disabled");
		expect(calls).toEqual([]);
	});

	it("verifies public CLI evidence once and opens browsers without focus", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "00000000-0000-4000-8000-000000000003" },
			runner: runner(calls),
		});
		await adapter.presentResearch("https://example.com/a");
		await adapter.presentResearch("https://example.com/b");
		expect(calls.filter(call => call[0] === "help")).toHaveLength(1);
		expect(calls.at(-1)).toEqual(["browser", "open", "https://example.com/b", "--focus", "false"]);
		expect(calls.some(call => call.some(arg => arg.includes("google.com")))).toBe(false);
	});
	it("uses cmux 0.64.20 UUID identity output and rejects a mismatched UUID caller", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "00000000-0000-4000-8000-000000000003" },
			runner: runner(calls),
		});
		await adapter.presentResearch("https://example.com");
		expect(calls).toContainEqual(["--id-format", "uuids", "identify"]);
		expect(adapter.capability).toBe("verified");
	});
	it("disables activation after bounded retries when identify identity is stale", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "workspace-1", CMUX_SURFACE_ID: "surface-1" },
			runner: {
				async run(_command, args) {
					calls.push([...args]);
					if (args[0] === "help") return { exitCode: 0, stdout: HELP, stderr: "" };
					if (args[0] === "capabilities") return { exitCode: 0, stdout: "ok", stderr: "" };
					if (args.at(-1) === "identify")
						return {
							exitCode: 0,
							stdout: JSON.stringify({ caller: { workspace_id: "stale-workspace", surface_id: "surface-1" } }),
							stderr: "",
						};
					return { exitCode: 1, stdout: "", stderr: "unexpected command" };
				},
			},
		});
		await adapter.presentResearch("https://example.com");
		expect(adapter.capability).toBe("disabled");
		expect(calls.filter(call => call.at(-1) === "identify")).toHaveLength(2);
		expect(calls.some(call => call[0] === "browser")).toBe(false);
	});

	it("retries failed verification then opens a circuit and redacts bounded diagnostics", async () => {
		const calls: string[][] = [];
		const diagnostics: string[] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "workspace-1" },
			runner: runner(calls, new Set(["help"])),
			diagnostics: diagnostic => diagnostics.push(diagnostic.message),
		});
		await adapter.presentResearch("https://example.com");
		await adapter.presentResearch("https://example.com/again");
		expect(adapter.capability).toBe("disabled");
		expect(calls.filter(call => call[0] === "help")).toHaveLength(2);
		expect(diagnostics.join(" ")).not.toContain("secret");
		expect(diagnostics.join(" ")).not.toContain("private.example");
	});

	it("retains one no-focus agent surface per stable ID and coalesces identical updates", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "00000000-0000-4000-8000-000000000003" },
			runner: runner(calls),
		});
		await adapter.updateAgentSurface({ id: "child-1", status: "running", text: "hello" });
		await adapter.updateAgentSurface({ id: "child-1", status: "running", text: "hello" });
		expect(calls.filter(call => call[0] === "new-surface")).toHaveLength(1);
		expect(calls.find(call => call[0] === "new-surface")).toEqual([
			"new-surface",
			"--type",
			"agent-session",
			"--focus",
			"false",
		]);
		expect(calls.filter(call => call[0] === "rename-tab")).toHaveLength(1);
	});
	it("shares in-flight surface creation across concurrent updates", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "00000000-0000-4000-8000-000000000003" },
			runner: {
				async run(_command, args) {
					calls.push([...args]);
					if (args[0] === "help") return { exitCode: 0, stdout: HELP, stderr: "" };
					if (args[0] === "capabilities") return { exitCode: 0, stdout: "ok", stderr: "" };
					if (args.at(-1) === "identify")
						return {
							exitCode: 0,
							stdout: IDENTIFY_UUIDS_06420,
							stderr: "",
						};
					if (args[0] === "new-surface") {
						await Bun.sleep(1);
						return { exitCode: 0, stdout: "surface-1\n", stderr: "" };
					}
					return { exitCode: 0, stdout: "ok", stderr: "" };
				},
			},
		});
		await Promise.all([
			adapter.updateAgentSurface({ id: "child-1", status: "running", text: "progress" }),
			adapter.updateAgentSurface({ id: "child-1", status: "completed", text: "done" }),
		]);
		expect(calls.filter(call => call[0] === "new-surface")).toHaveLength(1);
	});
	it("serializes delayed progress before a terminal rename for the same stable ID", async () => {
		const calls: string[][] = [];
		let releaseProgress!: () => void;
		const progressBlocked = new Promise<void>(resolve => (releaseProgress = resolve));
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "workspace-1" },
			runner: {
				async run(_command, args) {
					calls.push([...args]);
					if (args[0] === "help") return { exitCode: 0, stdout: HELP, stderr: "" };
					if (args[0] === "capabilities") return { exitCode: 0, stdout: "ok", stderr: "" };
					if (args.at(-1) === "identify")
						return {
							exitCode: 0,
							stdout: JSON.stringify({ caller: { workspace_id: "workspace-1" } }),
							stderr: "",
						};
					if (args[0] === "new-surface") return { exitCode: 0, stdout: "surface-1", stderr: "" };
					if (args.at(-1)?.includes("running: progress")) await progressBlocked;
					return { exitCode: 0, stdout: "ok", stderr: "" };
				},
			},
		});
		const progress = adapter.updateAgentSurface({ id: "child-1", status: "running", text: "progress" });
		const terminal = adapter.updateAgentSurface({ id: "child-1", status: "completed", text: "done" });
		await Bun.sleep(0);
		expect(calls.filter(call => call[0] === "rename-tab")).toHaveLength(1);
		releaseProgress();
		await Promise.all([progress, terminal]);
		expect(calls.filter(call => call[0] === "rename-tab").map(call => call.at(-1))).toEqual([
			"GJC child-1 running: progress",
			"GJC child-1 completed: done",
		]);
	});
});

describe("CmuxProjectionSubscription", () => {
	it("uses existing channels, terminal fallback, and disposal only unsubscribes", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "00000000-0000-4000-8000-000000000003" },
			runner: runner(calls),
		});
		const bus = new EventBus();
		const subscription = new CmuxProjectionSubscription(bus, adapter);
		bus.emit("task:subagent:lifecycle", { id: "child-1", status: "completed" });
		await Bun.sleep(0);
		expect(calls.some(call => call.at(-1) === "GJC child-1 completed: No final progress snapshot")).toBe(true);
		subscription.dispose();
		const count = calls.length;
		bus.emit("task:subagent:progress", { progress: { id: "child-1", status: "completed", recentOutput: ["done"] } });
		await Bun.sleep(0);
		expect(calls).toHaveLength(count);
	});
	it("never projects raw output, descriptions, or secrets into tab titles", async () => {
		const calls: string[][] = [];
		const adapter = new CmuxPresentationAdapter({
			env: { CMUX_WORKSPACE_ID: "00000000-0000-4000-8000-000000000003" },
			runner: runner(calls),
		});
		const bus = new EventBus();
		const subscription = new CmuxProjectionSubscription(bus, adapter);
		bus.emit("task:subagent:progress", {
			progress: {
				id: "child-1",
				status: "running",
				agent: "executor",
				currentTool: "web_search",
				description: "reset token abc123",
				task: "DATABASE_URL=postgres://alice:password@db.internal/customer",
				recentOutput: ["X-Amz-Signature=secret-signature", "postgres://alice:password@db.internal"],
			},
		});
		await Bun.sleep(0);
		const title = calls.find(call => call[0] === "rename-tab")?.at(-1) ?? "";
		expect(title).toContain("executor");
		expect(title).toContain("Tool: web_search");
		expect(title).not.toContain("secret-signature");
		expect(title).not.toContain("password");
		expect(title).not.toContain("token");
		subscription.dispose();
	});
});
