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

		// After rebase the seed binding is gone; further syncs behave as a normal baseline.
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
});
