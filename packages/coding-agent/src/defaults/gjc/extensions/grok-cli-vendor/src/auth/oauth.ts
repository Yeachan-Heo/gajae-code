/**
 * xAI Grok OAuth 2.0 + PKCE implementation.
 *
 * Uses Web Crypto API (crypto.subtle) for PKCE so the extension is
 * portable across Node versions and potential non-Node runtimes.
 *
 * SuperGrok OAuth (auth.x.ai OIDC) — same public client_id as the official Grok CLI app.
 * issuer. The difference is in the API endpoint: this extension targets
 * cli-chat-proxy.grok.com instead of api.x.ai.
 */

import { createServer } from 'node:http';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@gajae-code/ai/utils/oauth/types';
import { XaiErrorCode, XaiOAuthError } from '../shared/errors.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const ISSUER = 'https://auth.x.ai';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = process.env.GJC_GROK_CLI_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE =
  process.env.GJC_GROK_CLI_OAUTH_SCOPE ||
  'openid profile email offline_access grok-cli:access api:access';
const CALLBACK_HOST = process.env.GJC_GROK_CLI_CALLBACK_HOST || '127.0.0.1';
const CALLBACK_PORT = Number.parseInt(process.env.GJC_GROK_CLI_CALLBACK_PORT || '56122', 10);
const CALLBACK_PATH = '/callback';
/** Refresh 120s before actual expiry. */
const REFRESH_SKEW_MS = 120_000;
const TOKEN_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.GJC_GROK_CLI_TOKEN_TIMEOUT_MS || '30000',
  10,
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface XaiDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

export interface XaiOAuthCredentials extends OAuthCredentials {}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getBaseUrl(): string {
  return (
    process.env.GJC_GROK_CLI_BASE_URL ||
    process.env.GROK_CLI_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
}

function base64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(hash) };
}

// ─── Endpoint validation ──────────────────────────────────────────────────────

function validateEndpoint(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XaiOAuthError(
      `xAI OAuth discovery returned invalid ${field}: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  if (url.protocol !== 'https:') {
    throw new XaiOAuthError(
      `xAI OAuth ${field} must use HTTPS: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    host !== 'x.ai' &&
    host !== 'auth.x.ai' &&
    host !== 'accounts.x.ai' &&
    !host.endsWith('.x.ai')
  ) {
    throw new XaiOAuthError(
      `Refusing non-xAI OAuth ${field}: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  return url.toString();
}

// ─── OIDC Discovery ──────────────────────────────────────────────────────────

async function discover(): Promise<XaiDiscovery> {
  let response: Response;
  try {
    response = await fetch(DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI OIDC discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  if (!response.ok) {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned ${response.status}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  const authorizationEndpoint = validateEndpoint(
    String(payload.authorization_endpoint ?? ''),
    'authorization_endpoint',
  );
  const tokenEndpoint = validateEndpoint(String(payload.token_endpoint ?? ''), 'token_endpoint');
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  };
}

// ─── Loopback callback server ────────────────────────────────────────────────

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

function startCallbackServer(): Promise<{
  server: import('node:http').Server;
  redirectUri: string;
  waitForCallback: (timeoutMs: number) => Promise<CallbackResult>;
}> {
  let settle: ((value: CallbackResult) => void) | undefined;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });

  const server = createServer((req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin === 'https://accounts.x.ai' || origin === 'https://auth.x.ai') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${CALLBACK_HOST}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const result: CallbackResult = {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      };

      // Always 200 on the loopback page so the browser does not show HTTP 400.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const html = result.error
        ? '<html><body><h1>xAI authorization was not completed.</h1><p>Return to the terminal for details. You can close this tab.</p></body></html>'
        : '<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>';
      res.end(html);
      settle?.(result);
    } catch {
      res.statusCode = 500;
      res.end('Internal error');
    }
  });

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, CALLBACK_HOST, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });

  return (async () => {
    let actualPort: number;
    try {
      actualPort = await listen(CALLBACK_PORT);
    } catch (firstError) {
      try {
        actualPort = await listen(0);
      } catch (secondError) {
        const errorDescription = `Could not bind xAI OAuth callback server on ${CALLBACK_HOST}:${CALLBACK_PORT} or an ephemeral port: ${secondError instanceof Error ? secondError.message : String(secondError)} (initial error: ${firstError instanceof Error ? firstError.message : String(firstError)})`;
        return {
          server,
          redirectUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
          waitForCallback: async () => ({
            error: XaiErrorCode.CALLBACK_BIND_FAILED,
            errorDescription,
          }),
        };
      }
    }
    const redirectUri = `http://${CALLBACK_HOST}:${actualPort}${CALLBACK_PATH}`;
    return {
      server,
      redirectUri,
      waitForCallback: (timeoutMs: number) =>
        Promise.race([
          callbackPromise,
          new Promise<CallbackResult>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  error: XaiErrorCode.CALLBACK_TIMEOUT,
                  errorDescription: 'Timed out waiting for xAI OAuth callback.',
                }),
              timeoutMs,
            ),
          ),
        ]),
    };
  })();
}

// ─── Token exchange ───────────────────────────────────────────────────────────

async function fetchTokenResponse(
  tokenEndpoint: string,
  body: URLSearchParams,
  errorCode: string,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
    });
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI ${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      errorCode,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function tokenResponseText(response: Response) {
  try {
    return await response.text();
  } catch (cause) {
    return `unable to read response body: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

async function tokenResponseJson(
  response: Response,
  errorCode: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI ${label} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      errorCode,
    );
  }
}

async function exchangeCode(
  tokenEndpoint: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<XaiOAuthCredentials> {
  const response = await fetchTokenResponse(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    XaiErrorCode.TOKEN_EXCHANGE_FAILED,
    'token exchange',
  );
  if (!response.ok) {
    throw new XaiOAuthError(
      `xAI token exchange failed: ${response.status} ${await tokenResponseText(response)}`,
      XaiErrorCode.TOKEN_EXCHANGE_FAILED,
    );
  }
  const payload = await tokenResponseJson(
    response,
    XaiErrorCode.TOKEN_EXCHANGE_FAILED,
    'token exchange',
  );
  const access = String(payload.access_token ?? '');
  const refresh = String(payload.refresh_token ?? '');
  if (!access) {
    throw new XaiOAuthError(
      'xAI token exchange did not return access_token.',
      XaiErrorCode.TOKEN_EXCHANGE_INVALID,
    );
  }
  if (!refresh) {
    throw new XaiOAuthError(
      'xAI token exchange did not return refresh_token.',
      XaiErrorCode.TOKEN_EXCHANGE_INVALID,
    );
  }
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : Number(payload.expires_in ?? 3600);
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
  };
}

// ─── Login (GJC /login OAuth flow) ──────────────────────────────────────

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const discovery = await discover();
  const { verifier, challenge } = await generatePKCE();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const callback = await startCallbackServer();

  try {
    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', callback.redirectUri);
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('plan', 'generic');
    authUrl.searchParams.set('referrer', 'gjc-grok-cli');

    callbacks.onAuth({
      url: authUrl.toString(),
      instructions: `Authorize xAI in your browser, then return to gjc. Callback: ${callback.redirectUri}`,
    });

    const result = await callback.waitForCallback(180_000);

    if (result.error) {
      const code =
        result.error === XaiErrorCode.CALLBACK_BIND_FAILED ||
        result.error === XaiErrorCode.CALLBACK_TIMEOUT
          ? result.error
          : XaiErrorCode.AUTHORIZATION_FAILED;
      throw new XaiOAuthError(result.errorDescription ?? result.error, code);
    }
    if (result.state !== state) {
      throw new XaiOAuthError(
        'xAI OAuth state mismatch — possible CSRF.',
        XaiErrorCode.STATE_MISMATCH,
      );
    }
    if (!result.code) {
      throw new XaiOAuthError(
        'xAI OAuth callback did not include an authorization code.',
        XaiErrorCode.CODE_MISSING,
      );
    }

    const credentials = await exchangeCode(
      discovery.token_endpoint,
      result.code,
      callback.redirectUri,
      verifier,
    );
    return credentials;
  } finally {
    callback.server.close();
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const tokenEndpoint = (await discover()).token_endpoint;
  validateEndpoint(tokenEndpoint, 'token_endpoint');

  if (!credentials.refresh) {
    throw new XaiOAuthError(
      'Missing refresh_token. Re-login required.',
      XaiErrorCode.REFRESH_MISSING,
      true,
    );
  }

  const response = await fetchTokenResponse(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
    XaiErrorCode.REFRESH_FAILED,
    'token refresh',
  );

  if (!response.ok) {
    const isFatal = response.status === 400 || response.status === 401 || response.status === 403;
    throw new XaiOAuthError(
      `xAI token refresh failed: ${response.status} ${await tokenResponseText(response)}`,
      XaiErrorCode.REFRESH_FAILED,
      isFatal,
    );
  }

  const payload = await tokenResponseJson(response, XaiErrorCode.REFRESH_FAILED, 'token refresh');
  const access = String(payload.access_token ?? '');
  if (!access) {
    throw new XaiOAuthError(
      'xAI token refresh did not return access_token.',
      XaiErrorCode.REFRESH_FAILED,
      true,
    );
  }

  const refresh_new = String(payload.refresh_token ?? credentials.refresh);
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : Number(payload.expires_in ?? 3600);

  return {
    ...credentials,
    access,
    refresh: refresh_new,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
  };
}
