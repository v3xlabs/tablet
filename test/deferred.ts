/** ES2023 target: Promise.withResolvers is not available. */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};
