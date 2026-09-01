import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GjcRuntimeSnapshotStore } from "../src/extensibility/gjc-plugins/runtime-quarantine";

/**
 * The Settings surface is only useful if the runtime evidence the session
 * publishes actually reaches it in production. Component tests inject a fake
 * provider, so they cannot see a missing wire: this suite pins the real
 * publish -> session -> selector-context -> component chain by source
 * inspection, which is what a broken wire would silently change.
 */

const srcRoot = path.join(import.meta.dir, "..", "src");

async function read(relative: string): Promise<string> {
	return await fs.readFile(path.join(srcRoot, relative), "utf8");
}

describe("GJC bundle Settings runtime wiring", () => {
	test("createAgentSession publishes the provider onto the session", async () => {
		const source = await read("sdk/session.ts");
		expect(source).toContain("session.gjcRuntimeSnapshot = gjcRuntimeStore;");
		expect(source).toContain("session.gjcActivationGeneration = gjcActivationGeneration;");
	});

	test("the session type carries the provider and generation", async () => {
		const source = await read("session/agent-session.ts");
		expect(source).toContain("gjcRuntimeSnapshot?: GjcRuntimeSnapshotProvider;");
		expect(source).toContain("gjcActivationGeneration?: number;");
	});

	test("the production selector passes both fields into the settings context", async () => {
		const source = await read("modes/controllers/selector-controller.ts");
		expect(source).toContain("gjcRuntimeSnapshot: this.ctx.session.gjcRuntimeSnapshot");
		expect(source).toContain("gjcActivationGeneration: this.ctx.session.gjcActivationGeneration");
	});

	test("the settings selector forwards them into the component dependencies", async () => {
		const source = await read("modes/components/settings-selector.ts");
		expect(source).toContain("runtimeSnapshotProvider: this.context.gjcRuntimeSnapshot");
		expect(source).toContain("activationGeneration: this.context.gjcActivationGeneration");
	});

	test("publication happens only after the last producer", async () => {
		const source = await read("sdk/session.ts");
		const appendix = source.indexOf("renderAlwaysOnSystemAppendices({");
		const publish = source.indexOf("gjcRuntimeStore.publish(");
		expect(appendix).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(appendix);
		// Exactly one publication site, guarded by the completeness flag and
		// fenced by the pass epoch so an older overlapping rebuild cannot publish
		// over a newer one.
		expect(source.split("gjcRuntimeStore.publish(").length - 1).toBe(1);
		expect(source).toContain(
			"if (gjcProducersComplete) gjcRuntimeStore.publish(gjcFindings.snapshot(), gjcPassEpoch)",
		);
		// The rebuild callback is reused, so the previous generation must be
		// retired at callback ENTRY. Invalidating next to the publish would leave
		// stale evidence readable across every await in between, or entirely if
		// an earlier step throws.
		const beginPass = source.indexOf("gjcRuntimeStore.beginPass()");
		expect(beginPass).toBeGreaterThan(-1);
		expect(beginPass).toBeLessThan(appendix);
		expect(source.split("gjcRuntimeStore.beginPass()").length - 1).toBe(1);
	});

	test("an overlapping or failed pass can never publish over a newer one", () => {
		const snapshot = (generation: number) => ({ generation, findings: [] });

		// A slow earlier pass must not publish after a newer pass has begun.
		const store = new GjcRuntimeSnapshotStore();
		const passA = store.beginPass();
		const passB = store.beginPass();
		store.publish(snapshot(1), passA);
		expect(store.current().status).toBe("unavailable");
		store.publish(snapshot(2), passB);
		expect(store.current()).toMatchObject({ status: "current", snapshot: { generation: 2 } });

		// And it must not overwrite a newer pass that already published.
		const raced = new GjcRuntimeSnapshotStore();
		const older = raced.beginPass();
		const newer = raced.beginPass();
		raced.publish(snapshot(20), newer);
		raced.publish(snapshot(10), older);
		expect(raced.current()).toMatchObject({ status: "current", snapshot: { generation: 20 } });

		// A pass that begins and then fails leaves consumers at unavailable rather
		// than reading the generation it superseded.
		const failed = new GjcRuntimeSnapshotStore();
		failed.publish(snapshot(1), failed.beginPass());
		expect(failed.current().status).toBe("current");
		failed.beginPass();
		expect(failed.current().status).toBe("unavailable");
	});
});
