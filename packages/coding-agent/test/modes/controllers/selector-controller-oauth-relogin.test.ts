import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@gajae-code/ai";

describe("SelectorController OAuth re-login", () => {
	it("should keep disabled credential until new login succeeds", async () => {
		const authStorage = await AuthStorage.create(":memory:");

		// Set up a disabled OAuth credential
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "expired-refresh",
				expires: Date.now() - 60_000,
				accountId: "expired-account",
				email: "expired@example.com",
			},
		]);

		const inventory = authStorage.listCredentialInventory("anthropic");
		const disabledCredential = inventory[0];
		if (!disabledCredential) throw new Error("Expected OAuth credential");

		// Disable the credential
		expect(authStorage.disableCredentialById(disabledCredential.id, "oauth refresh failed")).toBe(true);

		// Verify it's disabled
		const disabledInventory = authStorage.listCredentialInventory("anthropic");
		expect(disabledInventory[0]?.disabled).toBe(true);

		// Get removal targets (which are the disabled credentials)
		const removalTargets = authStorage.listCredentialRemovalTargets("anthropic");
		expect(removalTargets).toHaveLength(1);
		expect(removalTargets[0]?.id).toBe(disabledCredential.id);

		// Simulate what happens in onReloginAccount when login fails
		// The current buggy code does this:
		// 1. removeAuthCredentialsHard(disabledCredential)  <- removes it immediately
		// 2. handleOAuthLogin(...)  <- login fails

		// Let's verify that after removeAuthCredentialsHard, the credential is gone
		const removalResult = authStorage.removeAuthCredentialsHard("anthropic", removalTargets);
		expect(removalResult.kind).toBe("removed");

		// After removal, there should be no credentials
		const inventoryAfterRemoval = authStorage.listCredentialInventory("anthropic");
		expect(inventoryAfterRemoval).toHaveLength(0);

		// This is the problem: if login fails at this point, the user has lost their old credential

		authStorage.close();
	});

	it("should remove disabled credential only after new login succeeds", async () => {
		const authStorage = await AuthStorage.create(":memory:");

		// Set up a disabled OAuth credential
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "expired-refresh",
				expires: Date.now() - 60_000,
				accountId: "expired-account",
				email: "expired@example.com",
			},
		]);

		const inventory = authStorage.listCredentialInventory("anthropic");
		const disabledCredential = inventory[0];
		if (!disabledCredential) throw new Error("Expected OAuth credential");

		// Disable the credential
		expect(authStorage.disableCredentialById(disabledCredential.id, "oauth refresh failed")).toBe(true);

		// Get the removal target
		const removalTargets = authStorage.listCredentialRemovalTargets("anthropic");
		expect(removalTargets).toHaveLength(1);

		// Fixed approach: Keep the disabled credential until login succeeds
		// 1. Don't remove it yet
		const inventoryBeforeLogin = authStorage.listCredentialInventory("anthropic");
		expect(inventoryBeforeLogin).toHaveLength(1);
		expect(inventoryBeforeLogin[0]?.disabled).toBe(true);

		// 2. Simulate successful login (add new credential)
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 60_000,
				accountId: "new-account",
				email: "new@example.com",
			},
		]);

		// Now we have both: old disabled + new active
		const inventoryAfterNewLogin = authStorage.listCredentialInventory("anthropic");
		expect(inventoryAfterNewLogin).toHaveLength(2);

		// 3. Now remove the old disabled credential
		const removalResult = authStorage.removeAuthCredentialsHard("anthropic", removalTargets);
		expect(removalResult.kind).toBe("removed");

		// Should have only the new credential
		const inventoryAfterRemoval = authStorage.listCredentialInventory("anthropic");
		expect(inventoryAfterRemoval).toHaveLength(1);
		expect(inventoryAfterRemoval[0]?.accountId).toBe("new-account");

		authStorage.close();
	});
});
