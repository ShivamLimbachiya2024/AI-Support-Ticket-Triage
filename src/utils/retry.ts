import _ from 'lodash';

import { GEMINI_FAILURE_KIND } from '../rabbitmq/enums';

interface FailureDecision {
  kind: GEMINI_FAILURE_KIND;
}

interface GeminiApiError {
  status?: unknown;
  code?: unknown;
  name?: unknown;
  cause?: unknown;
}

const retryableHttpStatuses = [408, 500, 502, 503, 504];
const authenticationStatuses = [401, 403];
const retryableTransportErrorNames: unknown[] = [
  'TimeoutError',
  'RequestTimeoutError',
  'APIConnectionTimeoutError',
  'ConnectionError',
  'APIConnectionError',
];
const transportErrorCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export const classifyProviderError = ({ error }: { error: unknown }): FailureDecision => {
  const visited = new Set<object>();
  let current = error;
  let hasTransportFailure = false;

  while (_.isObject(current) && !visited.has(current)) {
    visited.add(current);
    const { status, code, name, cause } = current as GeminiApiError;
    // generateContent reports an explicit HTTP response as ApiError.status.
    if (typeof status === 'number') {
      if (status === 429) return { kind: GEMINI_FAILURE_KIND.RATE_LIMIT };
      if (retryableHttpStatuses.includes(status)) return { kind: GEMINI_FAILURE_KIND.TRANSIENT };
      if (status === 402) return { kind: GEMINI_FAILURE_KIND.PAYMENT_REQUIRED };
      if (authenticationStatuses.includes(status))
        return { kind: GEMINI_FAILURE_KIND.CONFIGURATION };
      if ([400, 404, 422].includes(status)) return { kind: GEMINI_FAILURE_KIND.INVALID_REQUEST };
      return { kind: GEMINI_FAILURE_KIND.UNCLASSIFIED };
    }

    // The SDK may keep these names after wrapping a low-level timeout or connection failure.
    const codeIsTransportFailure = typeof code === 'string' && transportErrorCodes.has(code);
    if (codeIsTransportFailure) hasTransportFailure = true;
    const nameIsRetryableTransportFailure = retryableTransportErrorNames.includes(name);
    if (nameIsRetryableTransportFailure) hasTransportFailure = true;
    current = cause;
  }

  if (hasTransportFailure) return { kind: GEMINI_FAILURE_KIND.CONNECTION };
  return { kind: GEMINI_FAILURE_KIND.UNCLASSIFIED };
};

export class GeminiRequestError extends Error {
  readonly kind: GEMINI_FAILURE_KIND;

  constructor(cause: unknown) {
    super('Gemini request failed');
    this.kind = classifyProviderError({ error: cause }).kind;
  }
}
