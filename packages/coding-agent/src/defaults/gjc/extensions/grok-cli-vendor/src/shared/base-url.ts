import { $credentialEnv, $pickCredentialEnv } from '@gajae-code/utils';

const DEFAULT_GROK_BUILD_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const ALLOWED_GROK_BUILD_HOSTS = new Set(['cli-chat-proxy.grok.com']);
const UNSAFE_BASE_URL_ENV = 'GJC_GROK_CLI_ALLOW_UNSAFE_BASE_URL';

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

/**
 * Operator environment only. `$credentialEnv` already drops a cwd dotenv value,
 * including a dynamic declaration, using the snapshot taken when the env module
 * loaded. A repository `.env` therefore cannot name the Grok Build base URL or
 * approve that URL with the unsafe opt-in.
 */
function trustedConfiguredBaseUrl(): string | undefined {
  return $pickCredentialEnv('GJC_GROK_CLI_BASE_URL', 'GROK_CLI_BASE_URL');
}

function unsafeOverrideAllowed(): boolean {
  return $credentialEnv(UNSAFE_BASE_URL_ENV) === '1';
}

export function getBaseUrl(): string {
  const configured = trustedConfiguredBaseUrl();
  if (!configured) return DEFAULT_GROK_BUILD_BASE_URL;

  const normalized = normalizeBaseUrl(configured);
  if (isAllowedCredentialHost(normalized)) return normalized;
  if (unsafeOverrideAllowed()) return normalized;

  return DEFAULT_GROK_BUILD_BASE_URL;
}

export function isGrokBuildBaseUrlOverrideIgnored(): boolean {
  const configured = trustedConfiguredBaseUrl();
  if (!configured) return false;
  const normalized = normalizeBaseUrl(configured);
  return !isAllowedCredentialHost(normalized) && !unsafeOverrideAllowed();
}
