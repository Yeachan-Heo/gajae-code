import { expect, test } from "bun:test";
import {
	DESKTOP_ATTACHMENT_REQUEST_BYTES,
	desktopAttachmentJsonBytes,
} from "@gajae-code/desktop-host/attachment-protocol";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { DesktopLocalRequestError, validateDesktopRequest } from "../src/bridge";
import type * as Recovery from "../src/delivery-recovery";
import { type DeliveryRecovery, recoveriesDroppedWithConversation, recoveryNotice } from "../src/delivery-recovery";
import { browserPath } from "./component-fixture";

test("recovery notices distinguish actionable outcomes from routine bookkeeping", () => {
	const entry: DeliveryRecovery = {
		id: "id",
		sessionId: "session",
		text: "payload",
		attachments: [],
		disposition: "pending",
	};
	for (const disposition of [
		"pending",
		"accepted",
		"queued",
		"completed",
		"cancelled",
		"refused",
		"removed",
	] as const) {
		expect(recoveryNotice({ ...entry, disposition }, false)).toBeNull();
	}
	const unknown = recoveryNotice({ ...entry, disposition: "unknown" }, false);
	expect(unknown).toContain("It may already have run");
	expect(unknown).toContain("will not resend it automatically");
	const failed = recoveryNotice({ ...entry, disposition: "failed" }, false);
	expect(failed).toContain("delivery failed");
	expect(failed).toContain("Some work may already have run");
	expect(recoveryNotice({ ...entry, disposition: "failed", finalizing: true }, false)).toBeNull();
	for (const changes of [{ prepared: true }, { restored: true }, { finalizing: true }]) {
		expect(recoveryNotice({ ...entry, ...changes }, true)).toContain("Retry restoring the saved draft");
	}
});

test("an orphan's notice never mentions restoring, which it cannot offer", () => {
	const entry: DeliveryRecovery = {
		id: "id",
		sessionId: "gone",
		text: "payload",
		attachments: [],
		disposition: "unknown",
	};
	const unknown = recoveryNotice(entry, false, true);
	expect(unknown).toContain("It may already have run");
	expect(unknown).not.toMatch(/restor/iu);
	const failed = recoveryNotice({ ...entry, disposition: "failed" }, false, true);
	expect(failed).toContain("Some work may already have run");
	expect(failed).not.toMatch(/restor/iu);
	// A listed failed card never shows its text: Restore draft is how the text comes back to review.
	const listedFailed = recoveryNotice({ ...entry, sessionId: "listed", disposition: "failed" }, false, false);
	expect(listedFailed).toContain("Some work may already have run");
	expect(listedFailed).not.toContain("Review the text");
	expect(listedFailed).toContain("Restore the draft to review its text in the message box");
	// A listed conversation keeps today's wording.
	expect(recoveryNotice(entry, false, false)).toBe(recoveryNotice(entry, false));
	expect(recoveryNotice(entry, false)).toContain("will not resend it automatically");
});

test("deleting a conversation names every record whose text it loses, from the same list it drops", () => {
	const record = (id: string, changes: Partial<DeliveryRecovery>): DeliveryRecovery => ({
		id,
		sessionId: "doomed",
		text: `text of ${id}`,
		attachments: [],
		disposition: "pending",
		...changes,
	});
	const entries = [
		record("ran", { disposition: "completed" }),
		record("stopped", { disposition: "cancelled" }),
		record("back-in-composer", { disposition: "unknown", restored: true }),
		record("being-discarded", { disposition: "unknown", finalizing: true }),
		// A refused input whose automatic restore failed: its text is neither run nor in the composer.
		record("refused-restore-failed", { disposition: "refused" }),
		record("removed-restore-failed", { disposition: "removed" }),
		record("unknown", { disposition: "unknown" }),
		record("failed", { disposition: "failed" }),
		record("unsent-repair", { disposition: "pending", prepared: true }),
		record("in-flight", { disposition: "accepted" }),
		{ ...record("elsewhere", { disposition: "unknown" }), sessionId: "other" },
	];
	const { dropped, lost } = recoveriesDroppedWithConversation(entries, "doomed");
	expect(dropped.map(entry => entry.id)).toEqual(
		entries.filter(entry => entry.sessionId === "doomed").map(entry => entry.id),
	);
	expect(lost.map(entry => entry.id)).toEqual([
		"refused-restore-failed",
		"removed-restore-failed",
		"unknown",
		"failed",
		"unsent-repair",
		"in-flight",
	]);
	// Every lost record is one that is dropped.
	expect(lost.every(entry => dropped.includes(entry))).toBe(true);
});

test("prompt envelope validation includes exact UTF-8 bytes at the frame boundary", () => {
	const id = "request-id";
	const params = { sessionId: "세션", text: "", attachments: [{ kind: "text", name: "a.txt", text: "첨부" }] };
	const overhead = desktopAttachmentJsonBytes({ id, method: "prompt", params });
	params.text = "x".repeat(DESKTOP_ATTACHMENT_REQUEST_BYTES - overhead);
	expect(desktopAttachmentJsonBytes({ id, method: "prompt", params })).toBe(DESKTOP_ATTACHMENT_REQUEST_BYTES);
	expect(() => validateDesktopRequest("prompt", params, id)).not.toThrow();
	params.text += "x";
	try {
		validateDesktopRequest("prompt", params, id);
		throw new Error("Expected local refusal");
	} catch (error) {
		expect(error).toBeInstanceOf(DesktopLocalRequestError);
		expect((error as DesktopLocalRequestError).deliveryDisposition).toBe("refused");
	}
});

declare global {
	interface Window {
		testRecovery: typeof Recovery;
	}
}

async function injectRecovery(page: Page): Promise<void> {
	await page.addScriptTag({
		type: "module",
		content: 'import * as recovery from "/src/delivery-recovery.ts"; window.testRecovery = recovery;',
	});
	await page.waitForFunction(() => !!window.testRecovery);
}

// Exercise real IndexedDB transactions in an isolated browser origin.
test.skipIf(!browserPath)(
	"delivery and restored draft commit atomically and survive reload",
	async () => {
		const port = 36000 + Math.floor(Math.random() * 20000);
		const origin = `http://127.0.0.1:${port}`;
		const server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
			cwd: `${import.meta.dir}/..`,
			stdout: "ignore",
			stderr: "ignore",
		});
		let browser: Browser | undefined;
		try {
			for (let i = 0; i < 100; i++) {
				try {
					if ((await fetch(origin)).ok) break;
				} catch {
					/* starting */
				}
				await Bun.sleep(100);
			}
			if (!browserPath) return;
			browser = await puppeteer.launch({
				executablePath: browserPath,
				headless: true,
			});
			const page = await browser.newPage();
			await page.goto(`${origin}/?showcase`);
			await injectRecovery(page);
			await page.evaluate(async () => {
				await window.testRecovery.commitDraftAndDelivery(
					{ id: "id", sessionId: "s", text: "sent", attachments: [], disposition: "removed", restored: true },
					{ sessionId: "s", text: "sent\n\nnew", attachments: [] },
				);
			});
			const rejected = await page.evaluate(async () => {
				try {
					await window.testRecovery.commitDraftAndDelivery(
						{
							id: "bad",
							sessionId: "s",
							text: "x",
							attachments: [],
							disposition: "pending",
							error: (() => {}) as unknown as string,
						},
						{ sessionId: "s", text: "must not commit", attachments: [] },
					);
					return false;
				} catch {
					return true;
				}
			});
			expect(rejected).toBe(true);
			await page.reload();
			await injectRecovery(page);
			const result = await page.evaluate(async () => {
				return {
					entries: await window.testRecovery.loadDeliveries(),
					drafts: await window.testRecovery.loadDrafts(),
				};
			});
			expect(result.entries).toEqual([
				{ id: "id", sessionId: "s", text: "sent", attachments: [], disposition: "removed", restored: true },
			]);
			expect(result.drafts).toEqual([{ sessionId: "s", text: "sent\n\nnew", attachments: [] }]);
		} finally {
			await browser?.close();
			server.kill();
			await server.exited;
		}
	},
	30000,
);
