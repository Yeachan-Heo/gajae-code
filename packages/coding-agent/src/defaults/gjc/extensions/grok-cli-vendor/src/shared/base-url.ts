const DEFAULT_GROK_BUILD_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const ALLOWED_GROK_BUILD_HOSTS = new Set(['cli-chat-proxy.grok.com']);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function isAllowedCredentialHost(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && ALLOWED_GROK_BUILD_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function getBaseUrl(): string {
  const configured = process.env.GJC_GROK_CLI_BASE_URL || process.env.GROK_CLI_BASE_URL;
  if (!configured) return DEFAULT_GROK_BUILD_BASE_URL;

  const normalized = normalizeBaseUrl(configured);
  if (isAllowedCredentialHost(normalized)) return normalized;

  if (process.env.GJC_GROK_CLI_ALLOW_UNSAFE_BASE_URL === '1') return normalized;

  return DEFAULT_GROK_BUILD_BASE_URL;
}

export function isGrokBuildBaseUrlOverrideIgnored(): boolean {
  const configured = process.env.GJC_GROK_CLI_BASE_URL || process.env.GROK_CLI_BASE_URL;
  if (!configured) return false;
  const normalized = normalizeBaseUrl(configured);
  return (
    !isAllowedCredentialHost(normalized) && process.env.GJC_GROK_CLI_ALLOW_UNSAFE_BASE_URL !== '1'
  );
}
