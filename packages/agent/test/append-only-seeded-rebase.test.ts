import { describe, expect, it } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { AppendOnlyContextManager, type BuildOptions } from "../src/append-only-context";
import type { AgentContext } from "../src/types";

const BUILD_OPTS: BuildOptions = { intentTracing: false };

function makeContext(): AgentContext {
	return { systemPrompt: ["sys"], messages: [], tools: [] };
}
const msg = (content: string, role: Message["role"] = "user"): Message => ({ role, content }) as Message;
const contents = (mgr: AppendOnlyContextManager): unknown[] =>
	mgr.build(makeContext(), BUILD_OPTS).messages.map(m => m.content);

describe("AppendOnlyContextManager seeded-fork rebase (W4 / F9)", () => {
	it("rebases (not throws) when a seeded fork's provider context shrinks below the last sync", () => {
		const seed = [msg("s1"), msg("s2", "assistant")];
		const mgr = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		// Grow: seed + child turns (still starts with the seed prefix).
		mgr.syncMessages([...seed, msg("c1"), msg("c2", "assistant"), msg("c3")]);
		expect(contents(mgr)).toEqual(["s1", "s2", "c1", "c2", "c3"]);

		// Provider compacts to a SHORTER array that still begins with the seed prefix.
		expect(() => mgr.syncMessages([...seed, msg("c1")])).not.toThrow();
		expect(contents(mgr)).toEqual(["s1", "s2", "c1"]);

		// After rebase the inherited seed remains active, and explicit seed input is not duplicated.
		mgr.syncMessages([...seed, msg("c1"), msg("c4", "assistant")]);
		expect(contents(mgr)).toEqual(["s1", "s2", "c1", "c4"]);
	});

	it("rebases (not throws) when an already-synced message in a seeded fork is rewritten in place", () => {
		const seed = [msg("s1"), msg("s2", "assistant")];
		const mgr = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		mgr.syncMessages([...seed, msg("c1")]);
		expect(contents(mgr)).toEqual(["s1", "s2", "c1"]);

		// Same length, but the synced child message changed content (in-place rewrite).
		expect(() => mgr.syncMessages([seed[0]!, seed[1]!, msg("c1-rewritten")])).not.toThrow();
		expect(contents(mgr)).toEqual(["s1", "s2", "c1-rewritten"]);
	});

	it("still appends normally for a seeded fork that grows without rewriting the seed", () => {
		const seed = [msg("s1")];
		const mgr = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		mgr.syncMessages([...seed, msg("a", "assistant")]);
		mgr.syncMessages([...seed, msg("a", "assistant"), msg("b")]);
		expect(contents(mgr)).toEqual(["s1", "a", "b"]);
	});

	it("preserves inherited seed when compacted child context omits the seed prefix", () => {
		const seed = [msg("s1"), msg("s2", "assistant")];
		const mgr = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		mgr.syncMessages([...seed, msg("c1"), msg("c2", "assistant"), msg("c3")]);

		// Real forked task sessions can compact child-local entries without persisting
		// the inherited seed as session messages. The manager must rebase to the
		// synthetic seed + compacted child context, not the seedless normalized input.
		expect(() => mgr.syncMessages([msg("child-summary"), msg("c3")])).not.toThrow();
		expect(contents(mgr)).toEqual(["s1", "s2", "child-summary", "c3"]);
	});

	it("preserves inherited seed across successive seedless child compactions", () => {
		const seed = [msg("s1"), msg("s2", "assistant")];
		const mgr = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		mgr.syncMessages([...seed, msg("c1"), msg("c2", "assistant"), msg("c3")]);

		expect(() => mgr.syncMessages([msg("child-summary-1"), msg("c3")])).not.toThrow();
		expect(contents(mgr)).toEqual(["s1", "s2", "child-summary-1", "c3"]);

		expect(() => mgr.syncMessages([msg("child-summary-2")])).not.toThrow();
		expect(contents(mgr)).toEqual(["s1", "s2", "child-summary-2"]);
	});

	it("does not duplicate inherited seed when compacted child context includes the seed prefix", () => {
		const seed = [msg("s1"), msg("s2", "assistant")];
		const mgr = AppendOnlyContextManager.forkFromSeed({ messages: seed, options: BUILD_OPTS });
		mgr.syncMessages([...seed, msg("c1"), msg("c2", "assistant")]);

		expect(() => mgr.syncMessages([...seed, msg("child-summary")])).not.toThrow();
		expect(contents(mgr)).toEqual(["s1", "s2", "child-summary"]);
	});

	it("keeps ordinary no-seed compaction behavior unchanged", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.syncMessages([msg("a"), msg("b", "assistant"), msg("c")]);
		expect(contents(mgr)).toEqual(["a", "b", "c"]);

		expect(() => mgr.syncMessages([msg("summary")])).not.toThrow();
		expect(contents(mgr)).toEqual(["summary"]);
	});
});
