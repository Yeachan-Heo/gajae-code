import type {
  Api,
  AssistantMessageEventStream,
  Context,
  FetchImpl,
  Model,
  SimpleStreamOptions,
} from '@gajae-code/ai/core';
import { streamOpenAIResponses } from '@gajae-code/ai/providers/openai-responses';
import { getGrokCliVersion, updateVersionFromError } from './version-manager';

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * GJC Grok Build extension sends cli-chat-proxy headers (see agent.models.grok-cli.yml):
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 *   - x-grok-client-version: resolved dynamically from GitHub releases (cached)
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;

  // Get the cached Grok CLI version (or fallback if not yet fetched)
  // The version manager fetches from GitHub in the background on first call
  const grokCliVersion = getGrokCliVersion();

  const headers: Record<string, string> = {
    ...options?.headers,
    'x-grok-client-identifier': 'gjc-grok-cli',
    'x-grok-client-version': grokCliVersion,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': model.id,
  };

  if (sessionId) {
    headers['x-grok-conv-id'] = sessionId;
  }

  const responsesModel = {
    ...model,
    api: 'openai-responses',
  } as Model<'openai-responses'>;

  // Wrap fetch to intercept 426 errors and extract version info
  const baseFetch = options?.fetch ?? (globalThis.fetch.bind(globalThis) as FetchImpl);
  const wrappedFetch = wrapFetchForVersionHandling(baseFetch);

  return streamOpenAIResponses(responsesModel, context, {
    ...options,
    headers,
    fetch: wrappedFetch,
  });
}

/**
 * Wraps a fetch function to intercept HTTP 426 responses and extract version info.
 * When a 426 error is received, reads the response body and updates the version cache.
 */
function wrapFetchForVersionHandling(baseFetch: FetchImpl): FetchImpl {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const response = await baseFetch(input, init);

      // Handle HTTP 426 "version outdated" errors by reading the body and updating the cache
      if (response.status === 426) {
        try {
          const errorText = await response.text();
          updateVersionFromError(errorText);
          // Return a new response since we consumed the body
          return new Response(errorText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch {
          // If body reading fails, return the original response
          return response;
        }
      }

      return response;
    },
    { preconnect: baseFetch.preconnect },
  ) as FetchImpl;
}
