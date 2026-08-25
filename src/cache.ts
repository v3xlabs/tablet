export type Cache<T> = {
  entries: Map<string, T>;
  limit: number;
};

export const emptyCache = <T>(limit: number): Cache<T> => ({ entries: new Map(), limit });

export const readCache = <T>(cache: Cache<T>, key: string): T | undefined => {
  const held = cache.entries.get(key);

  if (held === undefined) return undefined;

  cache.entries.delete(key);
  cache.entries.set(key, held);

  return held;
};

export const writeCache = <T>(cache: Cache<T>, key: string, value: T): void => {
  cache.entries.delete(key);
  cache.entries.set(key, value);

  while (cache.entries.size > cache.limit) {
    const oldest = cache.entries.keys().next();

    if (oldest.done === true) return;

    cache.entries.delete(oldest.value);
  }
};
