// Test preload (node --import): every request to the Taiwan lodging register's hosts stays open until the caller
// gives up, as a first download on a slow link does; everything else goes to the real fetch (the tests' local mock).
// Never reaches the network.
const real = globalThis.fetch;
const REGISTER = /(^|\.)(taiwan\.net\.tw|data\.gov\.tw|data\.taipei)$/;
globalThis.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!REGISTER.test(url.hostname)) return real(input, init);
  return new Promise((_, reject) => {
    const stop = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (init.signal?.aborted) stop(); else init.signal?.addEventListener('abort', stop, { once: true });
  });
};
