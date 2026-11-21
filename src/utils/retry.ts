/** Failure classes based on Gemini's documented HTTP error behavior. */
export type FailureKind =
  'transient' | 'rateLimit' | 'quota' | 'configuration' | 'invalidRequest' | 'unclassified';

export interface FailureDecision {
  kind: FailureKind;
}

interface GeminiApiError {
  status?: number;
  message?: string;
  code?: string | number;
}

/**
 * Classify Gemini SDK failures using ApiError.status and documented HTTP
 * semantics. Retry timing is handled by RabbitMQ's quorum queue policy.
 */
export const classifyProviderError = ({ error }: { error: unknown }): FailureDecision => {
  if (!(error instanceof Error)) return { kind: 'unclassified' };

  const providerError = error as GeminiApiError;
  const status = providerError.status;

  if (status === 429) {
    return { kind: 'rateLimit' };
  }

  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return { kind: 'transient' };
  }
  if (status === 402) return { kind: 'quota' };
  if (status === 401 || status === 403) return { kind: 'configuration' };
  if (status === 400 || status === 404 || status === 422) return { kind: 'invalidRequest' };

  const transportErrorCodes = new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  const errorCode = (error as Error & { code?: unknown }).code;
  if (typeof errorCode === 'string' && transportErrorCodes.has(errorCode)) {
    return { kind: 'transient' };
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return { kind: 'transient' };

  return { kind: 'unclassified' };
};
