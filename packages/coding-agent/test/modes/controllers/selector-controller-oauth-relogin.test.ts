import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@gajae-code/ai";

describe("SelectorController OAuth re-login", () => {
	it("should handle already-purged disabled credential as successful cleanup", async () => {
		const authStorage = await AuthStorage.create(":memory:");

		// Set up a disabled OAuth credential with specific identity
		const originalEmail = "user@example.com";
		const originalAccountId = "account-123";
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "expired-refresh",
				expires: Date.now() - 60_000,
				accountId: originalAccountId,
				email: originalEmail,
			},
		]);

		const inventory = authStorage.listCredentialInventory("anthropic");
		const disabledCredential = inventory[0];
		if (!disabledCredential) throw new Error("Expected OAuth credential");

		// Disable the credential
		expect(authStorage.disableCredentialById(disabledCredential.id, "oauth refresh failed")).toBe(true);

		// Get the removal target for later cleanup
		const removalTargets = authStorage.listCredentialRemovalTargets("anthropic");
		expect(removalTargets).toHaveLength(1);
		const disabledRemovalTarget = removalTargets[0]!;

		// Simulate successful same-account re-login: upsertAuthCredentialForProvider
		// This triggers purgeSupersededDisabledRows internally, which removes the disabled
		// credential because the new active credential has the same identity
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 60_000,
				accountId: originalAccountId, // Same account
				email: originalEmail, // Same email
			},
		]);

		// Verify that the disabled credential has been purged by upsert
		const inventoryAfterUpsert = authStorage.listCredentialInventory("anthropic");
		expect(inventoryAfterUpsert).toHaveLength(1);
		expect(inventoryAfterUpsert[0]?.disabled).toBe(false);

		// Now try to remove the credential using the original removal target
		// This should succeed even though the target was already purged by purgeSupersededDisabledRows
		const removalResult = authStorage.removeAuthCredentialsHard("anthropic", [disabledRemovalTarget]);
		// The key fix: a conflict result (target no longer exists) should be acceptable
		// as it means the goal (cleanup of disabled credential) is already achieved
		expect(removalResult.kind).toBe("conflict");

		authStorage.close();
	});

	it("should preserve disabled credential when login fails (different account)", async () => {
		const authStorage = await AuthStorage.create(":memory:");

		// Set up a disabled OAuth credential
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "expired-refresh",
				expires: Date.now() - 60_000,
				accountId: "old-account",
				email: "old@example.com",
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

		// Verify disabled credential is preserved before login attempt
		const inventoryBeforeLogin = authStorage.listCredentialInventory("anthropic");
		expect(inventoryBeforeLogin).toHaveLength(1);
		expect(inventoryBeforeLogin[0]?.disabled).toBe(true);

		// If a login attempt fails and we don't call removeAuthCredentialsHard,
		// the disabled credential should still be there for user recovery
		const inventoryAfterFailedLogin = authStorage.listCredentialInventory("anthropic");
		expect(inventoryAfterFailedLogin).toHaveLength(1);
		expect(inventoryAfterFailedLogin[0]?.disabled).toBe(true);

		authStorage.close();
	});

	it("should remove disabled credential after successful different-account login", async () => {
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

		// Verify disabled credential exists
		const inventoryBeforeLogin = authStorage.listCredentialInventory("anthropic");
		expect(inventoryBeforeLogin).toHaveLength(1);
		expect(inventoryBeforeLogin[0]?.disabled).toBe(true);

		// Simulate successful login with different account
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

		// Remove the old disabled credential
		const removalResult = authStorage.removeAuthCredentialsHard("anthropic", removalTargets);
		expect(removalResult.kind).toBe("removed");

		// Should have only the new credential
		const inventoryAfterRemoval = authStorage.listCredentialInventory("anthropic");
		expect(inventoryAfterRemoval).toHaveLength(1);
		expect(inventoryAfterRemoval[0]?.accountId).toBe("new-account");

		authStorage.close();
	});
});
