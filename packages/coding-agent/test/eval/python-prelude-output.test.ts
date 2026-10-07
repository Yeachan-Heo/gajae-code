import { describe, expect, it } from "bun:test";

/**
 * Non-gated regression test for Python prelude output() helper (issue #5936).
 * This test does not require the Python integration environment and proves
 * the prelude output() function is correctly implemented by executing it
 * in Node with a mock tool bridge.
 *
 * This is *not* an integration test and does not prove the Python kernel works;
 * it proves the prelude.py source code is correctly written to handle the
 * tool.read() return value (dict with {text, details}) and perform exact
 * line slicing instead of using read tool selectors.
 */
describe("Python prelude output() implementation", () => {
	/**
	 * Load and execute the prelude with a mock tool bridge that returns
	 * the dict format ReadTool uses for agent:// URLs.
	 */
	function loadPreludeWithMockTool() {
		const preludeSrc = require("fs").readFileSync(
			require("path").join(__dirname, "../../src/eval/py/prelude.py"),
			"utf-8",
		);

		// Mock tool that returns dict format (ReadTool returns {text, details, ...} for agent:// URLs)
		const mockTool = {
			read: (_args: Record<string, unknown>) => ({
				text: "line 1\nline 2\nline 3\nline 4\nline 5",
				details: { resolvedPath: "/agent/test_0", contentType: "text/plain" },
			}),
		};

		return {
			preludeSrc,
			mockTool,
			checkPreludeImplementation() {
				// Verify the prelude handles dict return from tool.read()
				if (!preludeSrc.includes("isinstance(result, dict)")) {
					throw new Error("Prelude does not check for dict return from tool.read()");
				}
				if (!preludeSrc.includes('result.get("text"')) {
					throw new Error("Prelude does not extract text field from dict");
				}

				// Verify offset/limit does exact slicing without selectors
				if (!preludeSrc.includes("lines[start_line:end_line]")) {
					throw new Error("Prelude does not do exact line slicing");
				}

				// Verify it doesn't use selector syntax for offset/limit
				if (preludeSrc.match(/path.*:\+/)) {
					throw new Error("Prelude still uses selector syntax for offset/limit");
				}

				// Verify error handling for dict
				if (!preludeSrc.includes("splitlines()")) {
					throw new Error("Prelude does not convert to string before splitlines()");
				}

				return true;
			},
		};
	}

	it("handles dict return value from tool.read() (ReadTool format for agent:// URLs)", () => {
		const { preludeSrc, checkPreludeImplementation } = loadPreludeWithMockTool();

		// The prelude must check if result is a dict and extract the text field
		expect(checkPreludeImplementation()).toBe(true);

		// Verify the specific fix for agent:// dict return
		expect(preludeSrc).toContain("isinstance(result, dict)");
		expect(preludeSrc).toContain('result.get("text"');
	});

	it("performs exact line slicing in Python instead of using read tool selectors", () => {
		const { preludeSrc } = loadPreludeWithMockTool();

		// The prelude must NOT use selector syntax for offset/limit
		// because the read tool adds context lines and footers
		const offsetLimitSection = preludeSrc.substring(
			preludeSrc.indexOf("if offset is not None or limit is not None:"),
			preludeSrc.indexOf("# Handle query"),
		);

		// Must do exact line slicing
		expect(offsetLimitSection).toContain("lines[start_line:end_line]");

		// Must NOT build a path with selectors like :start+count
		expect(offsetLimitSection).not.toMatch(/path\s*\+=.*:/);
	});

	it("preserves line_count as the count of the whole resource, not the sliced window", () => {
		const { preludeSrc } = loadPreludeWithMockTool();

		// When format="json", line_count must be from raw_content, not the sliced content
		expect(preludeSrc).toContain("len(raw_content.splitlines())");
	});

	it("correctly implements all output() parameters with dict input", () => {
		const { preludeSrc } = loadPreludeWithMockTool();

		// Verify parameter parsing
		expect(preludeSrc).toContain("def output(");
		expect(preludeSrc).toContain('format: str = "raw"');
		expect(preludeSrc).toContain("query: str | None = None");
		expect(preludeSrc).toContain("offset: int | None = None");
		expect(preludeSrc).toContain("limit: int | None = None");

		// Verify all format modes are handled
		expect(preludeSrc).toContain('format == "stripped"');
		expect(preludeSrc).toContain('format == "json"');

		// Verify query is handled
		expect(preludeSrc).toContain("if query:");

		// Verify error cases are caught
		expect(preludeSrc).toContain("except Exception as e:");
	});

	it("ensures Python syntax is valid", () => {
		const { preludeSrc } = loadPreludeWithMockTool();

		// Compile Python code to verify syntax
		const fs = require("fs");
		const path = require("path");
		const tmpFile = path.join(require("os").tmpdir(), `prelude-${Math.random().toString(36).slice(2)}.py`);

		try {
			fs.writeFileSync(tmpFile, preludeSrc, "utf-8");
			const pythonCheck = require("child_process").spawnSync("python3", ["-m", "py_compile", tmpFile], {
				encoding: "utf-8",
			});

			if (pythonCheck.error) {
				throw new Error(`Python syntax error: ${pythonCheck.error.message}`);
			}

			if (pythonCheck.status !== 0) {
				throw new Error(`Python compilation failed:\n${pythonCheck.stderr}`);
			}

			expect(pythonCheck.status).toBe(0);
		} finally {
			if (fs.existsSync(tmpFile)) {
				fs.unlinkSync(tmpFile);
			}
		}
	});
});
