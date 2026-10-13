import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { setAgentDir, setProjectDir } from "@gajae-code/utils";

function requireEnv(name: string, expected: string | undefined): void {
	if (expected === undefined) return;
	const actual = process.env[name];
	if (actual !== expected) {
		throw new Error(`precondition: ${name}=${actual ?? "<unset>"} expected ${expected}`);
	}
}

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		detachChild(child: unknown) {
			const index = this.children.indexOf(child);
			if (index !== -1) this.children.splice(index, 1);
		},
		clear() {
			this.children = [];
		},
	};
}

const agentDir = path.join(process.cwd(), "empty-agent");
await fs.mkdir(agentDir, { recursive: true });
setAgentDir(agentDir);

const moveTo = process.env.GJC_SHARE_MOVE_TO;
if (moveTo) setProjectDir(moveTo);

requireEnv("GH_HOST", process.env.GJC_SHARE_EXPECT_HOST);
requireEnv("GH_CONFIG_DIR", process.env.GJC_SHARE_EXPECT_CONFIG);

const theme = await getThemeByName("red-claw");
if (!theme) throw new Error("Expected red-claw theme");
setThemeInstance(theme);

const editor = {};
const editorContainer = createContainer();
editorContainer.addChild(editor);
const ctx = {
	session: {
		exportToHtml: async (file: string) => {
			await Bun.write(file, "session");
		},
	},
	editor,
	editorContainer,
	ui: { setFocus() {}, requestRender() {} },
	showError(message: string) {
		console.error(`SHARE_ERROR ${message}`);
	},
	showStatus() {},
} as unknown as InteractiveModeContext;

await new CommandController(ctx).handleShareCommand();
