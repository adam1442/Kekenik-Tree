/** Resolve on the next macrotask so input events / painting can run between evaluation slices. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = (): void => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    } else setTimeout(resolve, 0);
  });
}

export const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
