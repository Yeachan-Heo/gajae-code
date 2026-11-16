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
			'<｜DSML｜ invoke name="read">' +
				'<｜DSML｜ parameter name="path" string="true">src/index.ts</｜DSML｜ parameter>' +
				"</｜DSML｜ invoke>",
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
			'<｜DSML｜ invoke name="_i" string="true">정규식 매칭 검증</｜DSML｜ parameter>\n' +
				'<｜DSML｜ parameter name="command" string="true">cd ~/.gjc/agent/rules && node -e "..."</｜DSML｜ parameter>\n' +
				'<｜DSML｜ parameter name="timeout" string="false">60</｜DSML｜ parameter>\n' +
				"</｜DSML｜ invoke>\n" +
				"</｜DSML｜ calls>",
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
			'Visible <｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">echo hi',
		);

		expect(clean).toBe("Visible ");
		expect(healer.flushPending()).toBe("");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("consumeWithoutCalls strips markup and discards completed calls", () => {
		const healer = new DsmlToolCallHealer();
		const clean = healer.consumeWithoutCalls(
			"Before" +
				'<｜DSML｜invoke name="read">' +
				'<｜DSML｜parameter name="path">src/index.ts</｜DSML｜parameter>' +
				"</｜DSML｜invoke>" +
				"After",
		);

		expect(clean).toBe("BeforeAfter");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("marks calls with invalid JSON-typed parameters as incomplete", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed(
			'<｜DSML｜invoke name="first"><｜DSML｜parameter name="value" string="false">not-json</｜DSML｜parameter></｜DSML｜invoke>' +
				'<｜DSML｜invoke name="second"><｜DSML｜parameter name="value">text</｜DSML｜parameter></｜DSML｜invoke>',
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
			'<｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a</parameter></｜DSML｜ invoke>',
		);
		second.feed(
			'<｜DSML｜invoke name="read"><｜DSML｜ parameter name="path" string="true">b</parameter></｜DSML｜ invoke>',
		);

		expect(first.drainCompleted().map(call => call.id)).toEqual(["dsml_aaaaaaaa_1"]);
		expect(second.drainCompleted().map(call => call.id)).toEqual(["dsml_bbbbbbbb_1"]);
	});

	it("does not re-emit a call when structured calls suppress an open invocation", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed('<｜DSML｜invoke name="read"><｜DSML｜ parameter name="path" string="true">a</parameter>');
		expect(healer.consumeWithoutCalls("")).toBe("");
		expect(healer.drainCompleted()).toEqual([]);

		// The closing tag arrives in a later content-only delta; the structured
		// payload already covered this call, so nothing may be synthesized again.
		healer.feed("</｜DSML｜ invoke>");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("still recovers the next invocation after a suppressed one", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed('<｜DSML｜invoke name="first">');
		healer.consumeWithoutCalls("");
		healer.feed(
			"</｜DSML｜ invoke>" +
				'<｜DSML｜invoke name="second"><｜DSML｜ parameter name="x" string="true">1</parameter></｜DSML｜ invoke>',
		);

		const calls = healer.drainCompleted();
		expect(calls.map(call => call.name)).toEqual(["second"]);
	});

	it("marks an invocation closed with an open parameter as incomplete", () => {
		const healer = new DsmlToolCallHealer();
		expect(healer.feed('<｜DSML｜invoke name="read"><｜DSML｜parameter name="path">secret')).toBe("");
		expect(healer.drainCompleted()).toEqual([]);
		expect(healer.feed(".txt</｜DSML｜invoke>After")).toBe("After");
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		expect(calls[0].incomplete).toBe(true);
		expect(calls[0].arguments).toBe("{}");
		healer.feed('<｜DSML｜invoke name="next"></｜DSML｜invoke>');
		expect(healer.drainCompleted()[0].incomplete).toBeUndefined();
	});

	it("keeps suppressed parameter bytes hidden until the invocation closes", () => {
		const healer = new DsmlToolCallHealer();
		expect(healer.consumeWithoutCalls('<｜DSML｜invoke name="read"><｜DSML｜parameter name="path">sec')).toBe("");
		expect(healer.feed("ret.txt</｜DSML｜parameter>")).toBe("");
		expect(healer.feed("</｜DSML｜invoke>Visible")).toBe("Visible");
		expect(healer.drainCompleted()).toEqual([]);
	});

	it("preserves suppression when the opening invocation tag is split", () => {
		const healer = new DsmlToolCallHealer();
		expect(healer.consumeWithoutCalls("<｜DSML｜inv")).toBe("");
		expect(healer.feed('oke name="first"></｜DSML｜invoke>')).toBe("");
		expect(healer.drainCompleted()).toEqual([]);
		healer.feed('<｜DSML｜invoke name="second"></｜DSML｜invoke>');
		expect(healer.drainCompleted().map(call => call.name)).toEqual(["second"]);
	});

	// Finding 2: Reject invalid JSON-typed DSML arguments
	it("marks an invocation with invalid JSON-typed parameter as incomplete instead of falling back", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed(
			'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="code" string="false">{not valid json}</｜DSML｜parameter>' +
				"</｜DSML｜invoke>",
		);
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		// Should be marked incomplete, not fallen back to string
		expect(calls[0].incomplete).toBe(true);
	});

	// Finding 3: Preserve parameter structure errors
	it("marks an invocation incomplete when a parameter opens before the previous closes", () => {
		const healer = new DsmlToolCallHealer();
		healer.feed(
			'<｜DSML｜invoke name="bash">' +
				'<｜DSML｜parameter name="first">value1' +
				'<｜DSML｜parameter name="second">value2</｜DSML｜parameter>' + // opens before first closes
				"</｜DSML｜invoke>",
		);
		const calls = healer.drainCompleted();
		expect(calls).toHaveLength(1);
		// Should be marked incomplete due to structural error
		expect(calls[0].incomplete).toBe(true);
		// Should have lost the malformed parameters
		expect(JSON.parse(calls[0].arguments)).toEqual({});
	});
});
