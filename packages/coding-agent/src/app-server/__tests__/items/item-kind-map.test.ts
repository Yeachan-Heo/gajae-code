import { expect, test } from "bun:test";
import { AGENT_WIRE_EVENT_TYPES } from "../../../modes/shared/agent-wire/event-contract";
import {
	ASSISTANT_MESSAGE_EVENT_KIND_MAP,
	classifyGjcTool,
	FIXED_UNMAPPED_ITEM_KINDS,
	ITEM_EVENT_KIND_MAP,
	ITEM_KIND_MAP,
} from "../../items/item-kind-map";
import sourceEventInventory from "../../items/source-event-inventory.json" with { type: "json" };

const unmappedKinds: ReadonlySet<string> = new Set(FIXED_UNMAPPED_ITEM_KINDS.map(entry => entry.kind));

test("the category map is exhaustive and has no third state", () => {
	const kinds = ["read", "edit", "delete", "move", "execute", "search", "fetch", "think", "other"] as const;
	expect(Object.keys(ITEM_KIND_MAP).sort()).toEqual([...kinds].sort());
	for (const kind of kinds) {
		const mapping = ITEM_KIND_MAP[kind];
		if (mapping.type === null) expect(unmappedKinds.has(kind)).toBe(true);
		else expect(unmappedKinds.has(kind)).toBe(false);
	}
	for (const entry of FIXED_UNMAPPED_ITEM_KINDS) {
		expect(entry.reason.length).toBeGreaterThan(0);
		expect(ITEM_KIND_MAP[entry.kind].type).toBeNull();
	}
});

test("canonical tool classification maps only proven stable item families", () => {
	expect(classifyGjcTool("bash")).toMatchObject({ kind: "execute", type: "commandExecution", mapped: true });
	expect(classifyGjcTool("edit")).toMatchObject({ kind: "edit", type: "fileChange", mapped: true });
	expect(classifyGjcTool("web_search")).toMatchObject({ kind: "fetch", type: "webSearch", mapped: true });
	expect(classifyGjcTool("todo_write")).toMatchObject({ kind: "think", type: "plan", mapped: true });
	expect(classifyGjcTool("read")).toMatchObject({ kind: "read", type: null, mapped: false });
	expect(classifyGjcTool("search")).toMatchObject({ kind: "search", type: null, mapped: false });
	expect(classifyGjcTool("mcp__calendar__list_events")).toMatchObject({
		kind: "other",
		type: "mcpToolCall",
		mapped: true,
		mcp: { server: "calendar", tool: "list_events" },
	});
	expect(classifyGjcTool("mcp__calendar_list_events")).toMatchObject({
		kind: "other",
		type: "mcpToolCall",
		mapped: true,
		mcp: { server: "calendar", tool: "list_events" },
	});
});
test("every source event and assistant inner event is catalogued", () => {
	expect(Object.keys(ITEM_EVENT_KIND_MAP).sort()).toEqual([...AGENT_WIRE_EVENT_TYPES].sort());
	expect(sourceEventInventory.events.map(event => event.discriminator).sort()).toEqual(
		[...AGENT_WIRE_EVENT_TYPES].sort(),
	);
	expect(sourceEventInventory.permittedUnmapped).toEqual(
		sourceEventInventory.events
			.filter(event => event.classification === "permitted-unmapped")
			.map(event => event.discriminator),
	);
	expect(Object.keys(ASSISTANT_MESSAGE_EVENT_KIND_MAP).sort()).toEqual(
		sourceEventInventory.assistantMessageEvents.map(event => event.discriminator).sort(),
	);
	for (const event of sourceEventInventory.events) {
		expect(event.reason.length, event.discriminator).toBeGreaterThan(0);
	}
});

test("named tools with a pinned catalog type are not hidden behind the unmapped policy", () => {
	// `mapToolKind` collapses these into `other`, but the pinned union really can represent them,
	// so leaving them unmapped would make the documented-unmapped list dishonest.
	expect(classifyGjcTool("generate_image")).toMatchObject({ kind: "other", type: "imageGeneration", mapped: true });
	expect(classifyGjcTool("computer")).toMatchObject({ kind: "other", type: "dynamicToolCall", mapped: true });
	// The `other` CATEGORY itself stays unmapped: an unknown tool still fails closed.
	expect(classifyGjcTool("some_unknown_tool")).toMatchObject({ kind: "other", type: null, mapped: false });
});
