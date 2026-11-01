import * as fs from "node:fs/promises";
import * as path from "node:path";
import puppeteer from "puppeteer-core";

const directory = path.resolve(import.meta.dir, "../../../artifacts/desktop-visual-qa");
await fs.mkdir(directory, { recursive: true });
const server = Bun.spawn([process.execPath, "run", "dev:ui"], {
	cwd: path.resolve(import.meta.dir, ".."),
	stdin: "ignore",
	stdout: "ignore",
	stderr: "inherit",
});
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
	try {
		ready = (await fetch("http://127.0.0.1:1420/")).ok;
	} catch {
		/* Wait for the owned local server. */
	}
	if (ready) break;
	await Bun.sleep(100);
}
if (!ready) {
	server.kill();
	throw new Error("Visual QA server did not become ready");
}
const browser = await puppeteer.launch({
	executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
});
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(String(error)));
const captures: string[] = [];
try {
	for (const [width, height] of [
		[1280, 820],
		[900, 800],
		[720, 700],
		[390, 844],
	]) {
		await page.setViewport({ width, height });
		await page.goto("http://127.0.0.1:1420/?showcase", { waitUntil: "networkidle0" });
		const layout = await page.evaluate(() => ({
			width: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth,
			title: document.title,
			text: document.body.innerText.slice(0, 200),
		}));
		if (layout.scroll > layout.width) errors.push(`Horizontal overflow at ${width}: ${JSON.stringify(layout)}`);
		const file = `showcase-${width}.png`;
		await page.screenshot({ path: path.join(directory, file), fullPage: true });
		captures.push(file);
		await page
			.locator(".showcase .actions button")
			.filter(button => button.textContent === "Open settings")
			.click();
		await page.screenshot({ path: path.join(directory, `dialog-${width}.png`) });
		captures.push(`dialog-${width}.png`);
		await page.keyboard.press("Escape");
	}
	await page.setViewport({ width: 1280, height: 820 });
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
	await page.goto("http://127.0.0.1:1420/?showcase", { waitUntil: "networkidle0" });
	await page.screenshot({ path: path.join(directory, "showcase-dark.png"), fullPage: true });
	captures.push("showcase-dark.png");
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
	await page.goto("http://127.0.0.1:1420/", { waitUntil: "networkidle0" });
	await page.screenshot({ path: path.join(directory, "disconnected.png") });
	captures.push("disconnected.png");
	await Bun.write(
		path.join(directory, "receipt.json"),
		JSON.stringify(
			{
				captures,
				errors,
				capturedAt: new Date().toISOString(),
				note: "Browser showcase/disconnected evidence only; not real native/provider execution.",
			},
			null,
			2,
		),
	);
	process.stdout.write(`${JSON.stringify({ directory, captures: captures.length, errors })}\n`);
	if (errors.length) process.exitCode = 1;
} finally {
	await browser.close();
	server.kill();
	await server.exited;
}
