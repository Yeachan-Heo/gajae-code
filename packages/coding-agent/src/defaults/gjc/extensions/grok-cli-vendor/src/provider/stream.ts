import type {
  Api,
  AssistantMessageEventStream,
  Context,
  FetchImpl,
  Model,
  SimpleStreamOptions,
} from '@gajae-code/ai/core';
import { streamOpenAIResponses } from '@gajae-code/ai/providers/openai-responses';
import {
  getGrokCliVersion,
  parseMinimumVersionFrom426,
  updateVersionFromError,
} from './version-manager';

type FetchInput = Parameters<FetchImpl>[0];

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * GJC Grok Build extension sends cli-chat-proxy headers (see agent.models.grok-cli.yml):
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 *   - x-grok-client-version: learned from HTTP 426 responses; defaults to 1.0.13 and retries once on upgrade
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;

  // Get the Grok CLI version: learned from 426 responses or fallback
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
    onResponse(response, _responseModel, scope, signal) {
      return options?.onResponse?.(response, model, scope, signal);
    },
  });
}

/**
 * Wraps a fetch function to learn from HTTP 426 responses and retry once with a newer version.
 */
function wrapFetchForVersionHandling(baseFetch: FetchImpl): FetchImpl {
  return Object.assign(
    async (input: FetchInput, init?: RequestInit): Promise<Response> => {
      const firstInput =
        input instanceof Request ? (input.clone() as unknown as FetchInput) : input;
      const response = await baseFetch(firstInput, init);

      if (response.status !== 426) return response;

      let errorText: string;
      try {
        errorText = await response.clone().text();
      } catch {
        return response;
      }

      if (!parseMinimumVersionFrom426(errorText)) return response;

      const retryHeaders = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const requestedVersion = retryHeaders.get('x-grok-client-version');
      const learnedVersion = updateVersionFromError(errorText);
      if (!requestedVersion || learnedVersion === requestedVersion) return response;

      retryHeaders.set('x-grok-client-version', learnedVersion);
      const retryInput =
        input instanceof Request ? (input.clone() as unknown as FetchInput) : input;
      const retryResponse = await baseFetch(retryInput, { ...init, headers: retryHeaders });

      if (retryResponse.status === 426) {
        try {
          updateVersionFromError(await retryResponse.clone().text());
        } catch {
          // Keep the retry response intact if its body cannot be inspected.
        }
      }

      return retryResponse;
    },
    { preconnect: baseFetch.preconnect },
  ) as FetchImpl;
}
