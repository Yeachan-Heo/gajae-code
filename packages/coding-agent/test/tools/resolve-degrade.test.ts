import { describe, expect, it } from "bun:test";
import type { ToolChoice } from "@gajae-code/ai";
import { ToolChoiceQueue } from "@gajae-code/coding-agent/session/tool-choice-queue";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { queueResolveHandler } from "@gajae-code/coding-agent/tools/resolve";

const forcedResolve = { type: "tool", name: "resolve" } as const satisfies ToolChoice;

type StandingHandler = (input: unknown) => Promise<unknown> | unknown;

function createSession(options: {
	exactNamed: boolean;
	queue?: ToolChoiceQueue;
	steers?: unknown[];
	standing?: { current: StandingHandler | undefined };
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: {} as ToolSession["settings"],
		getSessionFile: () => null,
		getSessionSpawns: () => "",
		getToolChoiceQueue: () => options.queue,
		buildToolChoiceResult: () => ({
			choice: options.exactNamed ? forcedResolve : undefined,
			exactNamed: options.exactNamed,
			resolved: undefined,
		}),
		steer: (message: { customType: string; content: string; details?: unknown }) => options.steers?.push(message),
		...(options.standing
			? {
					peekStandingResolveHandler: () => options.standing?.current,
					setStandingResolveHandler: (handler: StandingHandler | null) => {
						if (options.standing) options.standing.current = handler ?? undefined;
					},
				}
			: {}),
	} as unknown as ToolSession;
}

describe("queueResolveHandler tool-choice degradation", () => {
	it("pushes a resolve directive when exact named forcing is preserved", () => {
		const queue = new ToolChoiceQueue();
		const steers: unknown[] = [];

		queueResolveHandler(createSession({ exactNamed: true, queue, steers }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "applied" }] }),
		});

		expect(queue.inspect()).toEqual(["pending-action:ast_edit"]);
		expect(queue.nextToolChoice()).toEqual(forcedResolve);
		expect(steers).toHaveLength(1);
	});

	it("only steers the reminder when named forcing degrades", () => {
		const queue = new ToolChoiceQueue();
		const steers: unknown[] = [];

		queueResolveHandler(createSession({ exactNamed: false, queue, steers }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "applied" }] }),
		});

		expect(queue.inspect()).toEqual([]);
		expect(queue.nextToolChoice()).toBeUndefined();
		expect(steers).toHaveLength(1);
	});

	it("degradeInFlight drops an in-flight resolve directive without requeueing", () => {
		const queue = new ToolChoiceQueue();
		queueResolveHandler(createSession({ exactNamed: true, queue, steers: [] }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "applied" }] }),
		});

		expect(queue.nextToolChoice()).toEqual(forcedResolve);
		expect(queue.degradeInFlight("runtime unsupported")).toBe("pending-action:ast_edit");
		expect(queue.hasInFlight).toBe(false);
		expect(queue.inspect()).toEqual([]);
		expect(queue.nextToolChoice()).toBeUndefined();
	});
	it("degraded preview installs a standing fallback so voluntary resolve still dispatches", async () => {
		const queue = new ToolChoiceQueue();
		const standing = { current: undefined as StandingHandler | undefined };
		let applied = 0;

		queueResolveHandler(createSession({ exactNamed: false, queue, steers: [], standing }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => {
				applied++;
				return { content: [{ type: "text", text: "applied" }] };
			},
		});

		expect(queue.inspect()).toEqual([]);
		expect(standing.current).toBeDefined();
		await standing.current?.({ action: "apply", reason: "voluntary apply" });
		expect(applied).toBe(1);
		// Fallback self-clears after successful resolution.
		expect(standing.current).toBeUndefined();
	});

	it("latest degraded preview wins the fallback slot; resolving it clears the slot", async () => {
		const queue = new ToolChoiceQueue();
		const standing = { current: undefined as StandingHandler | undefined };
		const applies: string[] = [];
		const makeOptions = (label: string) => ({
			label,
			sourceToolName: "ast_edit",
			apply: async () => {
				applies.push(label);
				return { content: [{ type: "text" as const, text: `applied ${label}` }] };
			},
		});
		const session = createSession({ exactNamed: false, queue, steers: [], standing });

		queueResolveHandler(session, makeOptions("first"));
		const firstHandler = standing.current;
		queueResolveHandler(session, makeOptions("second"));

		// Second preview replaced the first preview's fallback.
		expect(standing.current).toBeDefined();
		expect(standing.current).not.toBe(firstHandler);

		await standing.current?.({ action: "apply", reason: "resolve newest preview" });
		expect(applies).toEqual(["second"]);
		expect(standing.current).toBeUndefined();
	});

	it("preview fallback never clobbers a mode-owned standing handler and never clears it", async () => {
		const queue = new ToolChoiceQueue();
		const planModeHandler: StandingHandler = async () => ({ content: [{ type: "text", text: "plan approved" }] });
		const standing = { current: planModeHandler as StandingHandler | undefined };

		queueResolveHandler(createSession({ exactNamed: false, queue, steers: [], standing }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "applied" }] }),
		});

		// Plan mode's handler stays installed; the degraded preview cannot displace it.
		expect(standing.current).toBe(planModeHandler);
	});

	it("clearFallback after queue-invoked resolution leaves a later mode-owned handler intact", async () => {
		const queue = new ToolChoiceQueue();
		const standing = { current: undefined as StandingHandler | undefined };

		queueResolveHandler(createSession({ exactNamed: true, queue, steers: [], standing }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "applied" }] }),
		});

		// Preview fallback armed alongside the forced directive.
		expect(standing.current).toBeDefined();

		// Plan mode registers AFTER the preview, taking over the slot.
		const planModeHandler: StandingHandler = async () => ({ content: [{ type: "text", text: "plan approved" }] });
		standing.current = planModeHandler;

		// Resolve through the queue invoker (the forced path).
		queue.nextToolChoice();
		const invoker = queue.peekInFlightInvoker();
		expect(invoker).toBeDefined();
		await invoker?.({ action: "apply", reason: "apply via forced directive" });

		// Identity-aware clear must NOT remove plan mode's handler.
		expect(standing.current).toBe(planModeHandler);
	});
});
