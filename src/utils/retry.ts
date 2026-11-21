/** Return the backoff delay for retry attempts one through three. */
export const retryDelayMs = (retryCount: number): number => {
  if (!Number.isInteger(retryCount) || retryCount < 1 || retryCount > 3) {
    throw new Error('retryCount must be between 1 and 3');
  }

  return 30000 * 2 ** (retryCount - 1);
};

/** Wait until a persisted retry timestamp is due. */
export const waitUntil = async (availableAt?: number): Promise<void> => {
  const delayMs = Math.max(0, (availableAt || Date.now()) - Date.now());

  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
};
