import { describe, expect, it } from "bun:test";
import { DsmlToolCallHealer } from "../src/utils/tool-call-healing";

describe("DeepSeek DSML tool-call healing", () => {
	it("parses string and JSON-typed parameters and strips all markup", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed(
			"Before" +
				"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>' +
				'<｜DSML｜parameter name="timeout" string="false">60</｜DSML｜parameter>' +
				"</｜DSML｜invoke>" +
				"</｜DSML｜tool_calls>" +
				"After",
		);

		expect(clean).toBe("BeforeAfter");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("dsml_1");
		expect(calls[0].name).toBe("bash");
		expect(JSON.parse(calls[0].arguments)).toEqual({ command: "pwd", timeout: 60 });
		expect(clean).not.toContain("DSML");
	});

	it("accepts whitespace after the DSML delimiter", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed(
			"<｜DSML｜ tool_calls>" +
				'<｜DSML｜ invoke name="read">' +
				'<｜DSML｜ parameter name="path" string="true">src/index.ts</｜DSML｜ parameter>' +
				"</｜DSML｜ invoke>" +
				"</｜DSML｜ tool_calls>",
		);

		expect(clean).toBe("");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("read");
		expect(JSON.parse(calls[0].arguments)).toEqual({ path: "src/index.ts" });
	});

	it("accepts ASCII pipe delimiters", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed(
			"<|DSML|tool_calls>" +
				'<|DSML|invoke name="read">' +
				'<|DSML|parameter name="path" string="true">src/index.ts</|DSML|parameter>' +
				"</|DSML|invoke>" +
				"</|DSML|tool_calls>",
		);

		expect(clean).toBe("");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("read");
		expect(JSON.parse(calls[0].arguments)).toEqual({ path: "src/index.ts" });
	});

	it("recovers the real Venice leak including its direct _i parameter", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed(
			"<｜DSML｜ tool_calls>\n" +
				'<｜DSML｜ invoke name="_i" string="true">정규식 매칭 검증</｜DSML｜ parameter>\n' +
				'<｜DSML｜ parameter name="command" string="true">cd ~/.gjc/agent/rules && node -e "..."</｜DSML｜ parameter>\n' +
				'<｜DSML｜ parameter name="timeout" string="false">60</｜DSML｜ parameter>\n' +
				"</｜DSML｜ invoke>\n" +
				"</｜DSML｜ tool_calls>",
		);

		expect(clean.trim()).toBe("");
		expect(clean).not.toContain("DSML");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("_i");
		expect(JSON.parse(calls[0].arguments)).toEqual({
			_i: "정규식 매칭 검증",
			command: 'cd ~/.gjc/agent/rules && node -e "..."',
			timeout: 60,
		});
	});

	it("holds markup across small chunks, including inside the delimiter", () => {
		const healer = new DsmlToolCallHealer();
		const leaked =
			"Visible " +
			"<｜DSML｜calls>" +
			'<｜DSML｜invoke name="write">' +
			'<｜DSML｜parameter name="path" string="true">out.txt</｜DSML｜parameter>' +
			'<｜DSML｜parameter name="content" string="true">hello</｜DSML｜parameter>' +
			"</｜DSML｜invoke>" +
			"</｜DSML｜calls>" +
			" done";

		let clean = "";
		for (const ch of leaked) clean += healer.feed(ch);
		clean += healer.flushPending();

		expect(clean).toBe("Visible  done");
		expect(clean).not.toContain("DSML");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write");
		expect(JSON.parse(calls[0].arguments)).toEqual({ path: "out.txt", content: "hello" });
	});

	it("passes prose through and releases a trailing lone less-than sign at flush", () => {
		const healer = new DsmlToolCallHealer();
		expect(healer.feed("Plain < text ")).toBe("Plain < text ");
		expect(healer.feed("<")).toBe("");
		expect(healer.drainCompleted()).toEqual([]);
		expect(healer.flushPending()).toBe("<");
	});

	it("drops an unterminated invocation without emitting a call or markup", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed(
			'Visible <｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">echo hi',
		);

		expect(clean).toBe("Visible ");
		expect(healer.flushPending()).toBe("");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("marks calls with invalid JSON-typed parameters as incomplete", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="first"><｜DSML｜parameter name="value" string="false">not-json</｜DSML｜parameter></｜DSML｜invoke>' +
				'<｜DSML｜invoke name="second"><｜DSML｜parameter name="value">text</｜DSML｜parameter></｜DSML｜invoke>' +
				"</｜DSML｜tool_calls>",
		);

		const calls = healer.drainCompleted();
		expect(calls.map(call => call.id)).toEqual(["dsml_1", "dsml_2"]);
		expect(calls.map(call => call.name)).toEqual(["first", "second"]);
		// First call has invalid JSON, so marked incomplete with empty args
		expect(calls[0].incomplete).toBe(true);
		expect(JSON.parse(calls[0].arguments)).toEqual({});
		// Second call is valid string parameter
		expect(calls[1].incomplete).toBeUndefined();
		expect(JSON.parse(calls[1].arguments)).toEqual({ value: "text" });
	});

	it("keeps ids unique across streams through the prefix", () => {
		const first = new DsmlToolCallHealer("dsml_aaaaaaaa");
		const second = new DsmlToolCallHealer("dsml_bbbbbbbb");
		first.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a</parameter></｜DSML｜ invoke>' +
				"</｜DSML｜tool_calls>",
		);
		second.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="read"><｜DSML｜ parameter name="path" string="true">b</parameter></｜DSML｜ invoke>' +
				"</｜DSML｜tool_calls>",
		);

		expect(first.drainCompleted().map(call => call.id)).toEqual(["dsml_aaaaaaaa_1"]);
		expect(second.drainCompleted().map(call => call.id)).toEqual(["dsml_bbbbbbbb_1"]);
	});

	it("marks an invocation closed with an open parameter as incomplete", () => {
		const healer = new DsmlToolCallHealer();
		expect(healer.feed('<｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path">secret')).toBe(
			"",
		);
		expect(healer.drainCompleted()).toEqual([]);
		expect(healer.feed(".txt</｜DSML｜invoke></｜DSML｜tool_calls>After")).toBe("After");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].incomplete).toBe(true);
		expect(calls[0].arguments).toBe("{}");
		healer.feed('<｜DSML｜tool_calls><｜DSML｜invoke name="next"></｜DSML｜invoke></｜DSML｜tool_calls>');
		expect(healer.drainCompleted()[0].incomplete).toBeUndefined();
	});

	it("marks an invocation with invalid JSON-typed parameter as incomplete instead of falling back", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="code" string="false">{not valid json}</｜DSML｜parameter>' +
				"</｜DSML｜invoke>" +
				"</｜DSML｜tool_calls>",
		);
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		// Should be marked incomplete, not fallen back to string
		expect(calls[0].incomplete).toBe(true);
	});

	it("marks an invocation incomplete when a parameter opens before the previous closes", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="first">value1' +
				'<｜DSML｜parameter name="second">value2</｜DSML｜parameter>' + // opens before first closes
				"</｜DSML｜invoke>" +
				"</｜DSML｜tool_calls>",
		);
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].incomplete).toBe(true);
	});

	it("does not promote bare invoke tags outside wrapper as tool calls", () => {
		const healer = new DsmlToolCallHealer();
		// Bare invoke tag without wrapper framing should be treated as text
		const quoted =
			'This is an example: <｜DSML｜invoke name="bash"><｜DSML｜parameter name="cmd">echo test</｜DSML｜parameter></｜DSML｜invoke>';
		const clean = healer.feed(quoted) + healer.flushPending();

		expect(healer.drainCompleted()).toHaveLength(0);
		expect(clean).toBe(quoted);
	});

	it("requires wrapper framing for invoke tags to be processed", () => {
		const healer = new DsmlToolCallHealer();
		// With wrapper, invoke should be processed
		const clean = healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash"><｜DSML｜parameter name="cmd" string="true">echo test</｜DSML｜parameter></｜DSML｜invoke>' +
				"</｜DSML｜tool_calls>",
		);

		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("bash");
		expect(clean).not.toContain("invoke");
	});

	it("rejects nested invoke tags instead of resetting state", () => {
		const healer = new DsmlToolCallHealer();
		// Nested invoke tags (invoke opened while another is in progress)
		healer.feed(
			`<｜DSML｜tool_calls>` +
				`<｜DSML｜invoke name="first"><｜DSML｜parameter name="param1">value1` +
				`<｜DSML｜invoke name="second"><｜DSML｜parameter name="param2">value2</｜DSML｜parameter></｜DSML｜invoke>` + // nested!
				`</｜DSML｜invoke>` +
				`</｜DSML｜tool_calls>`,
		);

		// Should mark the first call as incomplete due to nesting
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("first");
		expect(calls[0].incomplete).toBe(true);
	});

	it("emits malformed DSML-like tags as text when they exceed buffer limit", () => {
		const healer = new DsmlToolCallHealer();
		// Create a malformed tag that exceeds MAX_PARTIAL_HOLD (64 bytes)
		const malformedTag = `<${"x".repeat(100)}`; // Very long malformed tag
		const clean = healer.feed(`Visible ${malformedTag} more text`);

		// Should emit the malformed tag as text
		expect(clean).toContain("Visible");
		expect(clean).toContain("more text");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("releases incomplete tags at flush when stream ends", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed("Text with <｜DSML｜");
		// Incomplete DSML prefix at end of stream
		const flushed = healer.flushPending();
		expect(flushed).toContain("<｜DSML｜");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("emits malformed tags as text that don't match DSML patterns", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed("<｜DSML｜ incomplete tag");
		expect(clean).toBe("");
		// Incomplete tag still held at buffer limit
		const flushed = healer.flushPending();
		expect(flushed).toBe("<｜DSML｜ incomplete tag");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("marks a call incomplete when wrapper closes before invoke closes", () => {
		const healer = new DsmlToolCallHealer();
		// Wrapper closes after parameter closes but before invoke closes.
		// This should mark the invocation as incomplete.
		const clean = healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>' +
				"</｜DSML｜tool_calls>", // wrapper closes before invoke closes
		);

		expect(clean).toBe("");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].incomplete).toBe(true);
		expect(calls[0].name).toBe("bash");
		expect(JSON.parse(calls[0].arguments)).toEqual({ command: "pwd" });
	});

	it("rejects a call whose argument contained unknown DSML markup", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="command" string="true">rm -rf /tmp/a<｜DSML｜note>b</｜DSML｜parameter>' +
				"</｜DSML｜invoke>" +
				"</｜DSML｜tool_calls>",
		);

		expect(clean).toBe("");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		// Without the marker the argument would silently become "rm -rf /tmp/ab".
		expect(calls[0].incomplete).toBe(true);
	});

	it("keeps unknown DSML markup outside an invocation as visible text", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.feed("see <｜DSML｜note> here");
		expect(clean).toBe("see <｜DSML｜note> here");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("releases prose after an unterminated recognized DSML prefix without waiting for completion", () => {
		const healer = new DsmlToolCallHealer();
		const prose = "x".repeat(600);
		const clean = healer.feed(`Intro <｜DSML｜${prose}`);
		expect(clean.startsWith("Intro <｜DSML｜")).toBe(true);
		expect(clean.length).toBeGreaterThan(600);
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("fails an invocation closed when a recognized prefix inside it never terminates", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="command" string="true">pwd' +
				`<｜DSML｜${"y".repeat(600)}` +
				"</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>",
		);
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].incomplete).toBe(true);
	});

	it("suppresses two nested invocations through the matching outer close", () => {
		const healer = new DsmlToolCallHealer();
		// A malformed outer invocation containing two nested invocations.
		// The first nested closing tag should NOT finalize the outer call.
		// Both nested invocations should be suppressed.
		healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="outer">' +
				'<｜DSML｜parameter name="arg">data' +
				// First nested invoke
				'<｜DSML｜invoke name="inner1"><｜DSML｜parameter name="cmd">cmd1</｜DSML｜parameter></｜DSML｜invoke>' +
				// Second nested invoke
				'<｜DSML｜invoke name="inner2"><｜DSML｜parameter name="cmd">cmd2</｜DSML｜parameter></｜DSML｜invoke>' +
				// Close outer
				"</｜DSML｜invoke>" +
				"</｜DSML｜tool_calls>",
		);

		const calls = healer.drainCompleted();
		// Should have exactly one call: the outer one, marked incomplete
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("outer");
		expect(calls[0].incomplete).toBe(true);
		// The nested invocations (inner1, inner2) should NOT be emitted as separate calls
	});

	it("marks a call incomplete when wrapper opener appears inside a parameter", () => {
		const healer = new DsmlToolCallHealer();
		// A wrapper opener inside a parameter value indicates a malformed call.
		const clean = healer.feed(
			"<｜DSML｜tool_calls>" +
				'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="command" string="true">rm -rf /tmp/a<｜DSML｜tool_calls>b</｜DSML｜parameter>' +
				"</｜DSML｜invoke>" +
				"</｜DSML｜tool_calls>",
		);

		expect(clean).toBe("");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		// The leaked wrapper should not modify the argument silently
		expect(calls[0].incomplete).toBe(true);
		expect(calls[0].name).toBe("bash");
	});
});
