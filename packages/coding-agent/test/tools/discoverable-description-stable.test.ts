import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@gajae-code/coding-agent/config/settings";
import { BUILTIN_TOOL_DESCRIPTORS, LazyAgentTool, type ToolSession } from "@gajae-code/coding-agent/tools";

// A discoverable tool is advertised before its implementation loads. If the advertised description
// changes once the implementation loads, the provider-visible `tools` block changes mid-session and
// the prompt-cache prefix is lost (#5992).

const ENV_KEYS = ["GJC_PY", "PI_PY", "PI_JS"] as const;
let savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));
	for (const key of ENV_KEYS) delete Bun.env[key];
});
afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

function session(overrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(overrides),
	};
}

async function descriptionBeforeAndAfterLoad(name: string, toolSession: ToolSession) {
	const descriptor = BUILTIN_TOOL_DESCRIPTORS[name];
	if (!descriptor) throw new Error(`no descriptor for ${name}`);
	const facade = new LazyAgentTool(descriptor, undefined, () => descriptor.load(toolSession), toolSession);
	const before = facade.description;
	try {
		await facade.materializeForTests();
	} catch {
		return undefined;
	}
	return { before, after: facade.description };
}

const discoverable = Object.values(BUILTIN_TOOL_DESCRIPTORS)
	.filter(descriptor => descriptor.metadata.loadMode === "discoverable")
	.map(descriptor => descriptor.metadata.name);

describe("discoverable tool descriptions are stable across first load (#5992)", () => {
	it.each(
		discoverable,
	)("#given the default session #when %s loads #then its advertised description does not change", async name => {
		// given
		const toolSession = session();

		// when
		const observed = await descriptionBeforeAndAfterLoad(name, toolSession);

		// then
		if (observed === undefined) return;
		expect(observed.before).toBe(observed.after);
	});

	it.each([
		["line-number display", { readLineNumbers: true, readHashLines: false } as Partial<Record<SettingPath, unknown>>],
		["plain display", { readLineNumbers: false, readHashLines: false } as Partial<Record<SettingPath, unknown>>],
	])("#given a %s session #when search loads #then its advertised description does not change", async (_label, overrides) => {
		// given
		const toolSession = session(overrides);

		// when
		const observed = await descriptionBeforeAndAfterLoad("search", toolSession);

		// then
		expect(observed).toBeDefined();
		expect(observed?.before).toBe(observed?.after);
	});

	it.each([
		["python only", { "eval.py": true, "eval.js": false } as Partial<Record<SettingPath, unknown>>, undefined],
		["javascript only", { "eval.py": false, "eval.js": true } as Partial<Record<SettingPath, unknown>>, undefined],
		[
			"GJC_PY=js overriding settings",
			{ "eval.py": true, "eval.js": true } as Partial<Record<SettingPath, unknown>>,
			"js",
		],
	])("#given eval allowed for %s #when eval loads #then its advertised description does not change", async (_label, overrides, gjcPy) => {
		// given
		if (gjcPy !== undefined) Bun.env.GJC_PY = gjcPy;
		const toolSession = session(overrides);

		// when
		const observed = await descriptionBeforeAndAfterLoad("eval", toolSession);

		// then
		expect(observed).toBeDefined();
		expect(observed?.before).toBe(observed?.after);
	});
});
