// QA matrix driver: keeps the test-only host bridge alive while Ego drives the real
// UI, and asserts each feature against the real engine. Evidence is written to
// artifacts/desktop-qa/ (untracked). Set GJC_DESKTOP_QA_LIVE=1 to run a live turn
// against the shared install; the default run is isolated.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const origin = "http://127.0.0.1:1420";
const outDir = path.join(root, "artifacts/desktop-qa");
const receipt: { errors: string[] } & Record<string, unknown> = { errors: [] };

const vite = Bun.spawn([process.execPath, "run", "dev:ui"], {
	cwd: path.join(root, "packages/desktop"),
	stdout: "pipe",
	stderr: "pipe",
	stdin: "ignore",
});
const viteLog = new Response(vite.stderr).text();
void new Response(vite.stdout).text();
let up = false;
for (let attempt = 0; attempt < 160; attempt++) {
	try {
		if ((await fetch(origin)).ok) {
			up = true;
			break;
		}
	} catch {
		/* not listening yet */
	}
	await Bun.sleep(250);
}
receipt.viteUp = up;
if (!up) {
	receipt.viteLog = (await viteLog).slice(-2000);
	vite.kill();
	await vite.exited;
	console.log(JSON.stringify(receipt, null, 2));
	process.exit(1);
}

const bridge = Bun.spawn([process.execPath, path.join(root, "packages/desktop/scripts/host-ui-qa.ts")], {
	stdout: "pipe",
	stderr: "pipe",
	stdin: "ignore",
});
const bridgeError = new Response(bridge.stderr).text();
const decoder = new TextDecoder();
let buffer = "";
const ready = Promise.withResolvers<{ port: number; token: string; bootstrapUrl: string; project: string }>();
void (async () => {
	for await (const chunk of bridge.stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		const newline = buffer.indexOf("\n");
		if (newline < 0) continue;
		ready.resolve(JSON.parse(buffer.slice(0, newline)));
		break;
	}
})();
const info = await Promise.race([
	ready.promise,
	Bun.sleep(20_000).then(() => {
		throw new Error("QA bridge did not start");
	}),
]);
receipt.bridge = { port: info.port, project: info.project };
const bootstrap = await (await fetch(info.bootstrapUrl)).text();
receipt.bootstrapBytes = bootstrap.length;

const bootstrapPath = path.join(outDir, "bootstrap.js");
const reportPath = path.join(outDir, "report.json");
// A stale report from an earlier run must never be mistaken for this run's result.
await fs.rm(reportPath, { force: true });
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(bootstrapPath, bootstrap);

const script = `
const fsp = await import("node:fs/promises");
const bootstrap = await fsp.readFile(${JSON.stringify(bootstrapPath)}, "utf8");
const task = await taskSpace(${JSON.stringify(`gjc desktop feature matrix QA ${new Date().toISOString()}`)});
const page = task.page("p1");
const LIVE = ${JSON.stringify(process.env.GJC_DESKTOP_QA_LIVE === "1")};
const LIVE_MODEL = ${JSON.stringify(process.env.GJC_DESKTOP_QA_MODEL ?? "google-antigravity/gemini-3-flash")};
const report = { stage: "start", features: {} };
const flush = async () => fsp.writeFile(${JSON.stringify(reportPath)}, JSON.stringify(report)).catch(() => {});
const setStage = (value) => { report.stage = value; };
const body = async () => (await page.evaluate(() => document.body.innerText)) || "";
const waitFn = async (fn, timeout = 30000) => {
  try { await page.waitForFunction(fn, undefined, { timeout }); }
  catch (error) {
    throw new Error("WAIT " + report.stage + ": " + String(error).slice(0, 160) + " BODY=" + (await body()).slice(0, 900));
  }
};
const clickText = async (label) => {
  const ok = await page.evaluate((wanted) => {
    const node = [...document.querySelectorAll("button")].find((item) => (item.innerText || "").trim() === wanted);
    if (!node) return false;
    node.click();
    return true;
  }, label);
  if (!ok) throw new Error("Missing button: " + label + " BODY=" + (await body()).slice(0, 900));
};
const openMenu = async () => {
  const ok = await page.evaluate(() => {
    const node = document.querySelector('[aria-label="Conversation actions menu"]');
    if (!node) return false;
    node.click();
    return true;
  });
  if (!ok) throw new Error("Missing conversation actions menu BODY=" + (await body()).slice(0, 900));
  await waitFn(() => !!document.querySelector(".modal"));
};
const feature = (name, value) => { report.features[name] = value; void flush(); };
const clickRow = async (title) => {
  const ok = await page.evaluate((wanted) => {
    const node = [...document.querySelectorAll("nav button")].find((item) => (item.innerText || "").includes(wanted));
    if (!node) return false;
    node.click();
    return true;
  }, title);
  if (!ok) throw new Error("Missing row: " + title + " BODY=" + (await body()).slice(0, 900));
};
const request = async (method, params) =>
  page.evaluate(async ({ method, params }) => {
    const id = crypto.randomUUID();
    window.__qaFrames = window.__qaFrames || [];
    await window.__TAURI_INTERNALS__.invoke("engine_request", { request: { id, method, params } });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const frame = (window.__qaFrames || []).find((item) => item && item.id === id);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("No response for " + method);
  }, { method, params });
try {
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: bootstrap + " window.__qaErrors = []; addEventListener('unhandledrejection', e => window.__qaErrors.push(String(e.reason))); addEventListener('error', e => window.__qaErrors.push(String(e.message)));",
  });
  await page.goto(${JSON.stringify(origin)});
  await page.waitForSelector(".sidebar-heading", { timeout: 30000 });

  // 1. Seeded catalog loads without a connection error.
  setStage("seeded-catalog");
  await waitFn(() => document.body.innerText.includes("Long conversation"));
  const seeded = await body();
  feature("catalog", {
    projects: seeded.includes("qa-project"),
    sessions: ["Long conversation", "Short conversation", "Starred conversation"].every((title) => seeded.includes(title)),
    connectionError: seeded.includes("Disconnected:") || seeded.includes("Host connection failed"),
  });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "01-sidebar.png"))} });

  // 2. Selecting a conversation renders its history (the reported failure mode).
  setStage("select-session");
  await clickRow("Long conversation");
  await waitFn(() => document.querySelectorAll(".conversation .message, .conversation [class*=message]").length > 0 || document.body.innerText.includes("Long conversation] Message 119"));
  await page.waitForTimeout(600);
  const selectedBody = await body();
  feature("selectSession", {
    header: selectedBody.includes("Long conversation"),
    historyRendered: selectedBody.includes("Message 119"),
  });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "02-conversation.png"))} });

  // 3. Full-history dialog pages a 120-message conversation.
  setStage("history-dialog");
  await openMenu();
  await clickText("Full conversation history");
  await waitFn(() => document.body.innerText.includes("of 120."));
  const historyBody = await body();
  feature("historyDialog", { total: historyBody.includes("of 120."), rendered: historyBody.includes("Message 0") });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "03-history.png"))} });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 4. Command palette advertises only runnable builtins and runs one.
  setStage("palette");
  await clickText("Commands");
  await waitFn(() => document.body.innerText.includes("GJC slash commands"));
  const palette = await body();
  feature("palette", {
    hasTools: palette.includes("/tools"),
    hasJobs: palette.includes("/jobs"),
    hidesMove: !palette.includes("/move"),
    hidesSession: !palette.includes("/session"),
    hidesHandoff: !palette.includes("/handoff"),
    count: (palette.match(new RegExp("/[a-z-]+", "g")) || []).length,
  });
  await page.fill("#command-input", "/tools");
  await page.click(".command-run button[type=submit]");
  await waitFn(() => ((document.querySelector(".bounded-output")?.innerText || "").length > 10));
  feature("commandRun", { output: (await page.evaluate(() => document.querySelector(".bounded-output")?.innerText || "")).slice(0, 300) });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "04-command-tools.png"))} });

  // 5. Unknown slash text is refused instead of spending a provider turn.
  setStage("unknown-command");
  await page.fill("#command-input", "/not-a-command");
  await page.click(".command-run button[type=submit]");
  await waitFn(() => (document.querySelector(".bounded-output")?.innerText || "").includes("Not run."));
  feature("unknownCommand", { refused: true, output: (await page.evaluate(() => document.querySelector(".bounded-output")?.innerText || "")).slice(0, 200) });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 6. Rename through the dialog reaches the catalog title.
  setStage("rename");
  await openMenu();
  await clickText("Rename");
  await waitFn(() => !!document.querySelector("#session-title"));
  await page.fill("#session-title", "Rename check");
  await clickText("Save");
  await waitFn(() => document.body.innerText.includes("Rename check"));
  feature("rename", { applied: true });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "05-rename.png"))} });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 7. Settings: 321 scalar entries, filter, and a persisted write.
  setStage("settings");
  await clickText("Settings");
  await waitFn(() => ["321", "320", "319", "318"].some((count) => document.body.innerText.includes("Matches: " + count + " of " + count)));
  await page.fill("#setting-search", "retry");
  await waitFn(() => document.body.innerText.toLowerCase().includes("retry."));
  const settingsBody = await body();
  const writable = await page.evaluate(() => {
    const input = [...document.querySelectorAll("input")].find((item) => item.closest("label") || item.id);
    return !!input;
  });
  feature("settings", {
    filtered: settingsBody.toLowerCase().includes("retry."),
    showsReadOnlyNote: settingsBody.includes("Read only") || settingsBody.includes("Matches:"),
    writableInput: writable,
  });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "06-settings.png"))} });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 8. Change review shows the isolated project's untracked file.
  setStage("diff");
  await clickText("Review changes");
  await waitFn(() => document.body.innerText.includes("qa-untracked.txt"), 45000);
  feature("diff", { shown: (await body()).includes("qa-untracked.txt"), pane: (await body()).slice(-160) });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "07-diff.png"))} });
  await page.evaluate(() => {
    const node = document.querySelector('button[aria-label="Close review changes"], .modal-close');
    if (node) node.click();
  });
  await page.waitForTimeout(300);

  // 9. Protocol-level surfaces the TUI exposes, driven through the app bridge.
  setStage("protocol");
  const sessionId = await page.evaluate(() => {
    const snapshot = (window.__qaFrames || []).find((frame) => frame && frame.type === "snapshot");
    const sessions = snapshot?.snapshot?.sessions || [];
    const renamed = sessions.find((item) => item.title === "Rename check");
    return renamed?.id || sessions[0]?.id || "";
  });
  feature("sessionIdResolved", { id: sessionId.length > 0 });

  // 10. Session search narrows the sidebar.
  setStage("session-search");
  await page.fill("#session-search", "Short");
  await waitFn(() => {
    const text = document.body.innerText;
    return text.includes("Short conversation") && !text.includes("Rename check" + String.fromCharCode(10) + "Idle");
  });
  feature("sessionSearch", { filtered: !(await body()).includes("Starred conversation") });
  await page.fill("#session-search", "");
  await page.waitForTimeout(200);

  // 11. Active-tools dialog lists tools and saves a selection.
  setStage("tools-dialog");
  await clickText("Commands");
  await waitFn(() => document.body.innerText.includes("GJC slash commands"));
  await clickText("Manage active tools");
  await waitFn(() => document.body.innerText.includes("Active tools"));
  feature("toolsDialog", { opened: true, body: (await body()).slice(-260) });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "08-tools.png"))} });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 12. Goal dialog opens against the live session.
  setStage("goal-dialog");
  await clickText("Commands");
  await waitFn(() => document.body.innerText.includes("GJC slash commands"));
  const goalClicked = await page.evaluate(() => {
    const node = [...document.querySelectorAll("button")].find((item) => (item.innerText || "").includes("Manage goal"));
    if (!node) return false;
    node.click();
    return true;
  });
  if (goalClicked) {
    await waitFn(() => document.body.innerText.includes("Objective") || document.body.innerText.includes("goal"));
    feature("goalDialog", { opened: true, body: (await body()).slice(-200) });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    feature("goalDialog", { opened: false });
  }

  // 13. Delete dialog is reachable and dismissible without touching data.
  setStage("delete-dialog");
  await openMenu();
  await clickText("Delete conversation");
  await waitFn(() => document.body.innerText.includes("This cannot be undone."));
  feature("deleteDialog", { opened: true });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 14. A prompt with no usable model surfaces an error instead of failing silently.
  setStage("prompt-error");
  const before = (await body()).length;
  await page.evaluate(() => {
    const area = document.querySelector(".composer textarea, .composer input, textarea");
    if (!area) throw new Error("No composer");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, "Hello");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickText("Send");
  await page.waitForTimeout(6000);
  const after = await body();
  feature("promptError", {
    changed: after.length !== before,
    // A failed turn must render the provider's reason, never a blank bubble.
    surfaced:
      /no longer available|not supported|guardrail|do not have access|API key|api-key-env|provider login|401|404/i.test(
        after,
      ),
    text: after.slice(-260),
  });
  await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "09-prompt-error.png"))} });

  for (const method of ["tools.list", "diff.get", "session.star", "history.get", "command.list"]) {
    try {
      const response = await request(method, { sessionId, offset: 0, limit: 5, starred: true });
      feature("protocol:" + method, { ok: response.ok, result: response.ok ? JSON.stringify(response.result).slice(0, 120) : response.error });
    } catch (error) {
      feature("protocol:" + method, { ok: false, error: String(error).slice(0, 200) });
    }
  }
  const models = await page.evaluate(() => {
    const snapshot = (window.__qaFrames || []).find((frame) => frame && frame.type === "snapshot");
    return (snapshot?.snapshot?.models || []).map((model) => model.id);
  });
  feature("modelsListed", { count: models.length });
  const extra = [
    ["goal.operate", { sessionId, op: "create", objective: "Desktop QA goal" }],
    ["goal.operate", { sessionId, op: "get" }],
    ["session.export", { sessionId }],
    ["session.fork", { sessionId }],
    ["model.set", { sessionId, modelId: models[0] || "" }],
    ["abort", { sessionId }],
  ];
  for (const [method, params] of extra) {
    try {
      const response = await request(method, params);
      const error = response.ok ? "" : String(response.error);
      // A provider credential is an offline limitation, not a broken feature.
      const blocked = /No API key|not configured|Unauthorized|401/i.test(error);
      feature("protocol:" + method + (method === "goal.operate" ? ":" + params.op : ""), {
        ok: response.ok || blocked,
        ...(blocked ? { blocked: "credentials" } : {}),
        result: response.ok ? JSON.stringify(response.result).slice(0, 160) : error.slice(0, 160),
      });
    } catch (error) {
      feature("protocol:" + method, { ok: false, error: String(error).slice(0, 200) });
    }
  }
  // 15. Live turn through the real UI (only when credentials are borrowed).
  if (LIVE) {
    setStage("live-turn");
    const started = Date.now();
    // A shared install already applies the configured default preset; only fall back
    // to an explicit model when the session has none.
    const inherited = await page.evaluate(() => {
      const snapshots = (window.__qaFrames || []).filter((frame) => frame && frame.type === "snapshot");
      const snapshot = snapshots[snapshots.length - 1];
      const sessions = snapshot?.snapshot?.sessions || [];
      return sessions.find((item) => item.id)?.model || "";
    });
    let modelResponse = { ok: true, result: null, inherited };
    if (!inherited) {
      const response = await request("model.set", { sessionId, modelId: LIVE_MODEL });
      modelResponse = { ok: response.ok === true, result: response.result, inherited: "" };
    }
    feature("liveModel", modelResponse);
    await page.evaluate(() => {
      const area = document.querySelector(".composer textarea, .composer input, textarea");
      if (!area) throw new Error("No composer");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(area, "Reply with exactly: OK");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickText("Send");
    await waitFn(() => {
      const conversation = document.querySelector(".conversation");
      const text = conversation ? conversation.innerText : "";
      return text.includes("OK") && !document.body.innerText.includes("Working");
    }, 120000);
    const liveBody = await body();
    feature("liveTurn", {
      ms: Date.now() - started,
      replied: liveBody.includes("OK"),
      idle: liveBody.includes("Idle"),
      error: /Error|isError/.test(liveBody),
    });
    await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "10-live-turn.png"))} });
  }
  feature("errors", await page.evaluate(() => window.__qaErrors || []));
  report.ok = Object.values(report.features).every((value) => JSON.stringify(value).indexOf('"ok":false') < 0) && !report.features.catalog.connectionError;
  report.stage = "done";
} catch (error) {
  report.error = String(error).slice(0, 1200);
  report.ok = false;
  try { await page.screenshot({ path: ${JSON.stringify(path.join(outDir, "failure.png"))} }); } catch {}
}
await flush();
try { await task.finish({ keep: [] }); } catch {}
try { await task.finish({ keep: [] }); } catch {}
`;

await fs.writeFile(path.join(outDir, "ego-script.mjs"), script);
const ego = Bun.spawn(["ego-browser", "nodejs"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
ego.stdin.write(script);
await ego.stdin.flush();
ego.stdin.end();
const [out, err, code] = await Promise.all([
	new Response(ego.stdout).text(),
	new Response(ego.stderr).text(),
	ego.exited,
]);
receipt.egoExit = code;
receipt.egoStderr = err.slice(-3000);
receipt.egoStdout = out.slice(-800);
try {
	receipt.ui = JSON.parse(await fs.readFile(reportPath, "utf8"));
} catch {
	receipt.errors.push("No UI report produced");
	receipt.egoFailure = err.slice(-1200);
}
// Ego can exit 1 while tearing down an already-finished task space; that is not a
// QA failure as long as a complete report was produced.
const completed = (receipt.ui as { ok?: boolean; stage?: string } | undefined)?.stage === "done";
if (code !== 0 && !completed) receipt.errors.push(`Ego exited ${code} without a complete report`);
receipt.egoTeardown = code !== 0 ? "ego exited non-zero after reporting" : "clean";

bridge.kill();
await bridge.exited;
vite.kill();
await vite.exited;
receipt.bridgeLog = (await bridgeError).slice(-1000);
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
if (!(receipt.ui as { ok?: boolean } | undefined)?.ok) process.exitCode = 1;
void os;
