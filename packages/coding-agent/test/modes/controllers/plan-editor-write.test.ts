import { afterAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../../../src/session/agent-session";
import type { SessionManager } from "../../../src/session/session-manager";
import * as realEditor from "../../../src/utils/external-editor";

let editorText: string | null = null;

mock.module("../../../src/utils/external-editor", () => ({
	...realEditor,
	getEditorCommand: () => "test-editor",
	openInEditor: async () => editorText,
}));

const { PlanModeController } = await import("../../../src/modes/controllers/plan-mode-controller");

afterAll(() => {
	mock.module("../../../src/utils/external-editor", () => realEditor);
});

function controllerFor(artifacts: string, root: string, warnings: string[]) {
	const seen = { preview: null as string | null, edited: null as string | null };
	const sessionManager = {
		getArtifactsDir: () => artifacts,
		isManagedDestination: () => false,
		getSessionId: () => "plan-editor-write",
		getCwd: () => root,
	} as SessionManager;
	const controller = new PlanModeController({
		session: { abort: async () => {} } as AgentSession,
		sessionManager,
		modeGate: undefined as never,
		chatContainer: undefined as never,
		inputCallback: undefined,
		externalEditorKey: "ctrl+g",
		externalEditorKeys: ["ctrl+g"],
		startPendingSubmission: () => {
			throw new Error("unused");
		},
		addChatChild: () => {},
		requestRender: () => {},
		stopUi: () => {},
		startUi: () => {},
		showStatus: () => {},
		showWarning: message => warnings.push(message),
		showError: message => warnings.push(message),
		showHookConfirm: async () => false,
		showPlanPreview: async (content, options) => {
			seen.preview = content;
			seen.edited = (await options?.onExternalEditor?.()) ?? null;
			return { comments: [], notes: "", snapshotHash: "unused" };
		},
		flushCompactionQueue: async () => {},
		updatePlanModeStatus: () => {},
		handleClearCommand: async () => false,
		handleCompactCommand: async () => "cancelled",
		updateEditorChrome: () => {},
	});
	return { controller, seen };
}

describe("plan editor local root", () => {
	it("writes an ordinary in-root plan file returned by the editor", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-write-"));
		const artifacts = path.join(root, "artifacts");
		const planPath = path.join(artifacts, "local", "PLAN.md");
		try {
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			await fs.writeFile(planPath, "original plan\n");
			editorText = "updated plan\n";
			const { controller, seen } = controllerFor(artifacts, root, []);
			controller.setEnabledForCompatibility(true);
			await controller.handleApproval({
				planFilePath: "local://PLAN.md",
				finalPlanFilePath: "local://PLAN.md",
				title: "Plan",
				planExists: true,
			});
			expect(seen.preview).toBe("original plan\n");
			expect(seen.edited).toBe("updated plan\n");
			expect(await fs.readFile(planPath, "utf8")).toBe("updated plan\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not modify a file outside the local root when the plan path is a symlink",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-write-"));
			const artifacts = path.join(root, "artifacts");
			const localRoot = path.join(artifacts, "local");
			const outside = path.join(root, "outside.txt");
			const link = path.join(localRoot, "LEAK.md");
			const warnings: string[] = [];
			try {
				await fs.mkdir(localRoot, { recursive: true });
				await fs.writeFile(outside, "secret\n");
				await fs.symlink(outside, link);
				editorText = "pwned\n";
				const { controller, seen } = controllerFor(artifacts, root, warnings);
				controller.setEnabledForCompatibility(true);
				await controller.handleApproval({
					planFilePath: "local://LEAK.md",
					finalPlanFilePath: "local://LEAK.md",
					title: "Plan",
					planExists: true,
				});
				expect(seen.preview).toBe("secret\n");
				expect(seen.edited).toBeNull();
				expect(await fs.readFile(outside, "utf8")).toBe("secret\n");
				expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
				expect(warnings.some(message => message.includes("outside trust boundary"))).toBe(true);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")("refuses a hard link that stays inside the local root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-write-"));
		const artifacts = path.join(root, "artifacts");
		const planPath = path.join(artifacts, "local", "PLAN.md");
		const copyPath = path.join(artifacts, "local", "COPY.md");
		const warnings: string[] = [];
		try {
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			await fs.writeFile(planPath, "original plan\n");
			await fs.link(planPath, copyPath);
			editorText = "updated plan\n";
			const { controller, seen } = controllerFor(artifacts, root, warnings);
			controller.setEnabledForCompatibility(true);
			await controller.handleApproval({
				planFilePath: "local://PLAN.md",
				finalPlanFilePath: "local://PLAN.md",
				title: "Plan",
				planExists: true,
			});
			expect(seen.edited).toBeNull();
			expect(await fs.readFile(planPath, "utf8")).toBe("original plan\n");
			expect(await fs.readFile(copyPath, "utf8")).toBe("original plan\n");
			expect(warnings.some(message => message.includes("link group"))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"refuses a writable plan whose parent directory is not writable",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-editor-write-"));
			const artifacts = path.join(root, "artifacts");
			const parent = path.join(artifacts, "local");
			const planPath = path.join(parent, "PLAN.md");
			const warnings: string[] = [];
			try {
				await fs.mkdir(parent, { recursive: true });
				await fs.writeFile(planPath, "original plan\n");
				await fs.chmod(planPath, 0o644);
				await fs.chmod(parent, 0o555);
				editorText = "updated plan\n";
				const { controller, seen } = controllerFor(artifacts, root, warnings);
				controller.setEnabledForCompatibility(true);
				await controller.handleApproval({
					planFilePath: "local://PLAN.md",
					finalPlanFilePath: "local://PLAN.md",
					title: "Plan",
					planExists: true,
				});
				expect(seen.edited).toBeNull();
				expect(await fs.readFile(planPath, "utf8")).toBe("original plan\n");
				expect(warnings.length).toBeGreaterThan(0);
			} finally {
				await fs.chmod(parent, 0o755);
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});
