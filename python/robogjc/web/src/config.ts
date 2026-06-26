// Configuration injected by FastAPI at request time. The server replaces the
// `__ROBGJC_CONFIG__` sentinel in `static/index.html` with a JSON blob so the
// SPA never needs to make an extra round-trip just to learn whether the
// trigger surface is enabled.

export interface AppConfig {
  replayEnabled: boolean;
}

function readConfig(): AppConfig {
  const node = document.getElementById("robogjc-config");
  const text = node?.textContent?.trim();
  if (!text || text === "__ROBGJC_CONFIG__") {
    return { replayEnabled: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return { replayEnabled: false };
    }
    const record = parsed as Record<string, unknown>;
    return {
      replayEnabled: Boolean(record.replayEnabled),
    };
  } catch {
    return { replayEnabled: false };
  }
}

export const CONFIG: AppConfig = readConfig();

const REPLAY_TOKEN_STORAGE_KEY = "robogjc:replay-token";

export function replayAuthHeaders(): Record<string, string> {
  if (!CONFIG.replayEnabled) return {};
  const cached = window.sessionStorage.getItem(REPLAY_TOKEN_STORAGE_KEY)?.trim();
  if (cached) return { "X-Robogjc-Replay-Token": cached };
  const token = window.prompt("ROBGJC replay token")?.trim();
  if (!token) return {};
  window.sessionStorage.setItem(REPLAY_TOKEN_STORAGE_KEY, token);
  return { "X-Robogjc-Replay-Token": token };
}

export const POLL_INTERVAL_MS = 3000;
