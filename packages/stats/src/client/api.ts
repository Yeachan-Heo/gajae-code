import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	DashboardStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	RequestDetails,
} from "./types";

const API_BASE = "/api";

interface SyncResponse {
	processed: number;
	files: number;
	totalMessages: number;
}

export async function getStats(range = "24h"): Promise<DashboardStats> {
	const res = await fetch(`${API_BASE}/stats?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch stats");
	return res.json() as Promise<DashboardStats>;
}

export async function getOverviewStats(range = "24h"): Promise<OverviewStats> {
	const res = await fetch(`${API_BASE}/stats/overview?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch overview stats");
	return res.json() as Promise<OverviewStats>;
}

export async function getModelDashboardStats(range = "24h"): Promise<ModelDashboardStats> {
	const res = await fetch(`${API_BASE}/stats/model-dashboard?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch model stats");
	return res.json() as Promise<ModelDashboardStats>;
}

export async function getCostDashboardStats(range = "24h"): Promise<CostDashboardStats> {
	const res = await fetch(`${API_BASE}/stats/costs?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch cost stats");
	return res.json() as Promise<CostDashboardStats>;
}

export async function getRecentRequests(limit = 50): Promise<MessageStats[]> {
	const res = await fetch(`${API_BASE}/stats/recent?limit=${limit}`);
	if (!res.ok) throw new Error("Failed to fetch recent requests");
	return res.json() as Promise<MessageStats[]>;
}

export async function getRecentErrors(limit = 50): Promise<MessageStats[]> {
	const res = await fetch(`${API_BASE}/stats/errors?limit=${limit}`);
	if (!res.ok) throw new Error("Failed to fetch recent errors");
	return res.json() as Promise<MessageStats[]>;
}

export async function getRequestDetails(id: number): Promise<RequestDetails> {
	const res = await fetch(`${API_BASE}/request/${id}`);
	if (!res.ok) throw new Error("Failed to fetch request details");
	return res.json() as Promise<RequestDetails>;
}

export async function sync(): Promise<SyncResponse> {
	const res = await fetch(`${API_BASE}/sync`, { method: "POST" });
	if (!res.ok) throw new Error("Failed to sync");
	return res.json() as Promise<SyncResponse>;
}

export async function getBehaviorDashboardStats(range = "24h"): Promise<BehaviorDashboardStats> {
	const res = await fetch(`${API_BASE}/stats/behavior?range=${encodeURIComponent(range)}`);
	if (!res.ok) throw new Error("Failed to fetch behavior stats");
	return res.json() as Promise<BehaviorDashboardStats>;
}
