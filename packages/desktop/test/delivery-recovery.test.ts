import { expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import {
	DESKTOP_ATTACHMENT_REQUEST_BYTES,
	desktopAttachmentJsonBytes,
} from "../../desktop-host/src/attachment-protocol";
import { DesktopLocalRequestError, validateDesktopRequest } from "../src/bridge";
import type * as Recovery from "../src/delivery-recovery";
import { type DeliveryRecovery, recoveryNotice } from "../src/delivery-recovery";

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
	expect(unknown).toContain("이미 실행되었을 수 있습니다");
	expect(unknown).toContain("자동으로 다시 보내지 않습니다");
	const failed = recoveryNotice({ ...entry, disposition: "failed" }, false);
	expect(failed).toContain("실패했습니다");
	expect(failed).toContain("이미 실행되었을 수 있습니다");
	expect(recoveryNotice({ ...entry, disposition: "failed", finalizing: true }, false)).toBeNull();
	for (const changes of [{ prepared: true }, { restored: true }, { finalizing: true }]) {
		expect(recoveryNotice({ ...entry, ...changes }, true)).toContain("저장 복구를 다시 시도");
	}
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
test("delivery and restored draft commit atomically and survive reload", async () => {
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
		browser = await puppeteer.launch({
			executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
			return { entries: await window.testRecovery.loadDeliveries(), drafts: await window.testRecovery.loadDrafts() };
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
}, 30000);
