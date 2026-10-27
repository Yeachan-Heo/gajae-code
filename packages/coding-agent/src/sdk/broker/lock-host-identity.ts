import path from "node:path";
import { loadInstallationHostId, loadLegacyInstallationHostId } from "../../config/machine-identity";

export interface BrokerLockHostIdentity {
	ownerHostId: string;
	previousOwnerHostIds: readonly string[];
}

const brokerLockHostIdentityPromises = new Map<string, Promise<BrokerLockHostIdentity>>();

export async function brokerLockHostIdentity(agentDir: string): Promise<BrokerLockHostIdentity> {
	const coordinationRoot = path.resolve(agentDir, "sdk");
	const pending =
		brokerLockHostIdentityPromises.get(coordinationRoot) ??
		Promise.all([loadInstallationHostId({ configRootDir: coordinationRoot }), loadLegacyInstallationHostId()]).then(
			([ownerHostId, legacyHostId]) => ({
				ownerHostId,
				previousOwnerHostIds: legacyHostId === ownerHostId ? [] : [legacyHostId],
			}),
		);
	brokerLockHostIdentityPromises.set(coordinationRoot, pending);
	try {
		return await pending;
	} catch (error) {
		if (brokerLockHostIdentityPromises.get(coordinationRoot) === pending)
			brokerLockHostIdentityPromises.delete(coordinationRoot);
		throw error;
	}
}
