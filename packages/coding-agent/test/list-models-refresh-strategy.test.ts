import { expect, it } from "bun:test";
import * as path from "node:path";
import { resolveListModelsRefreshStrategy } from "../src/cli/list-models-refresh";

it("reuses cached model discovery for --list-models by default", async () => {
	expect(resolveListModelsRefreshStrategy()).toBe("online-if-uncached");

	const mainSource = await Bun.file(path.join(import.meta.dir, "../src/main.ts")).text();
	expect(mainSource).toContain("await modelRegistry.refresh(resolveListModelsRefreshStrategy())");
});
