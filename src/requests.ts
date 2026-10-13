import type { CompletionResult } from "./endpoint";

const MAX_ACTIVE = 2;
// Covers candidatePaths, which is capped at 16.
const MAX_QUEUED = 16;

export const abortedCompletion = (): CompletionResult => ({ ok: false, failure: { kind: "aborted" } });

export type ForegroundRequest = {
  controller: AbortController;
  path: string;
  started: boolean;
  cancelled: boolean;
};

export type ForegroundRequests = {
  begin: (path: string) => ForegroundRequest;
  owns: (request: ForegroundRequest) => boolean;
  cancel: (request: ForegroundRequest) => void;
  reset: () => void;
  current: () => ForegroundRequest | undefined;
  previous: () => ForegroundRequest | undefined;
};

/** Claims the provider before its first await. */
export const createForegroundRequests = (): ForegroundRequests => {
  let current: ForegroundRequest | undefined;
  let previous: ForegroundRequest | undefined;

  const retainedFor = (path: string): ForegroundRequest | undefined => {
    if (current?.started === true) return current.path === path ? current : undefined;

    return previous?.path === path ? previous : undefined;
  };

  return {
    begin: (path) => {
      const retained = retainedFor(path);

      if (previous !== retained) previous?.controller.abort();

      if (current !== retained) current?.controller.abort();

      previous = retained;
      current = { controller: new AbortController(), path, started: false, cancelled: false };

      return current;
    },
    owns: request => current === request && !request.cancelled && !request.controller.signal.aborted,
    cancel: (request) => {
      request.cancelled = true;

      // A cancelled preparation must never acquire a server slot.
      if (!request.started) request.controller.abort();
    },
    reset: () => {
      current?.controller.abort();
      previous?.controller.abort();
      current = undefined;
      previous = undefined;
    },
    current: () => current,
    previous: () => previous,
  };
};

type Queued = {
  controller: AbortController;
  start: (signal: AbortSignal) => Promise<CompletionResult>;
  isRelevant: () => boolean;
  resolve: (result: CompletionResult) => void;
  dispose: () => void;
};

export type RequestScheduler = {
  schedule: (
    signal: AbortSignal,
    isAhead: boolean,
    start: (signal: AbortSignal) => Promise<CompletionResult>,
    isRelevant?: () => boolean,
  ) => Promise<CompletionResult>;
  reset: () => void;
  dispose: () => void;
};

/** Two client requests in total, counting aborted requests still settling. */
export const createRequestScheduler = (log: (message: string) => void): RequestScheduler => {
  const active = new Set<Queued>();
  const queued: Queued[] = [];
  let isDisposed = false;

  const launch = (job: Queued): void => {
    active.add(job);

    const execute = async (): Promise<void> => {
      let result: CompletionResult;

      try {
        result = job.controller.signal.aborted || !job.isRelevant() ? abortedCompletion() : await job.start(job.controller.signal);
      }
      catch {
        result = abortedCompletion();
      }

      job.dispose();
      active.delete(job);
      job.resolve(job.controller.signal.aborted ? abortedCompletion() : result);

      const next = queued.shift();

      if (next !== undefined) launch(next);
    };

    void execute();
  };

  const reset = (): void => {
    for (const job of queued) {
      job.dispose();
      job.resolve(abortedCompletion());
    }

    queued.length = 0;

    for (const job of active) job.controller.abort();
  };

  return {
    schedule: (signal, isAhead, start, isRelevant = () => true) => {
      const obsolete = queued.filter(held => !held.isRelevant());

      for (const job of obsolete) {
        queued.splice(queued.indexOf(job), 1);
        job.dispose();
        job.resolve(abortedCompletion());
      }

      if (isDisposed || signal.aborted || !isRelevant() || (isAhead && (active.size >= MAX_ACTIVE || queued.length > 0))) {
        return Promise.resolve(abortedCompletion());
      }

      return new Promise((resolve) => {
        const controller = new AbortController();
        const cancel = (): void => {
          controller.abort();

          const index = queued.indexOf(job);

          if (index === -1) return;

          queued.splice(index, 1);
          job.dispose();
          resolve(abortedCompletion());
        };
        const job: Queued = { controller, start, isRelevant, resolve, dispose: () => signal.removeEventListener("abort", cancel) };

        signal.addEventListener("abort", cancel, { once: true });

        if (active.size < MAX_ACTIVE) {
          launch(job);

          return;
        }

        if (queued.length >= MAX_QUEUED) {
          job.dispose();
          resolve(abortedCompletion());

          return;
        }

        const settling = [...active].filter(held => held.controller.signal.aborted).length;

        if (settling > 0) log(`request queued behind ${settling} cancelled request(s) that have not settled yet`);

        queued.push(job);
      });
    },
    reset,
    dispose: () => {
      isDisposed = true;
      reset();
    },
  };
};

type Owner = { isRelevant: () => boolean; };
type Shared = { reply: Promise<CompletionResult>; controller: AbortController; owners: Set<Owner>; };

export type SharedReplies = {
  /** Aborted only once every ask that joined the request has let go. */
  join: (prompt: string, signal: AbortSignal, isAhead: boolean, isRelevant: () => boolean, start: (signal: AbortSignal) => Promise<CompletionResult>) => Promise<CompletionResult>;
  isRunning: (prompt: string) => boolean;
};

export const createSharedReplies = (scheduler: RequestScheduler): SharedReplies => {
  const running = new Map<string, Shared>();

  const open = (prompt: string, owner: Owner, isAhead: boolean, start: (signal: AbortSignal) => Promise<CompletionResult>): Shared => {
    const controller = new AbortController();
    // The first owner is in place before the scheduler asks whether anyone wants it.
    const owners = new Set<Owner>([owner]);
    const settle = async (): Promise<CompletionResult> => {
      try {
        return await scheduler.schedule(controller.signal, isAhead, start, () => [...owners].some(held => held.isRelevant()));
      }
      finally {
        if (running.get(prompt)?.controller === controller) running.delete(prompt);
      }
    };
    const shared = { reply: settle(), controller, owners };

    running.set(prompt, shared);

    return shared;
  };

  return {
    isRunning: prompt => running.get(prompt)?.controller.signal.aborted === false,
    join: async (prompt, signal, isAhead, isRelevant, start) => {
      if (signal.aborted) return abortedCompletion();

      const owner: Owner = { isRelevant };
      const held = running.get(prompt);
      const shared = held === undefined || held.controller.signal.aborted ? open(prompt, owner, isAhead, start) : held;
      let release = (): void => undefined;
      const released = new Promise<CompletionResult>((resolve) => {
        release = (): void => {
          shared.owners.delete(owner);

          if (shared.owners.size === 0) shared.controller.abort();

          resolve(abortedCompletion());
        };
      });

      shared.owners.add(owner);
      signal.addEventListener("abort", release, { once: true });

      try {
        return await Promise.race([shared.reply, released]);
      }
      finally {
        signal.removeEventListener("abort", release);
      }
    },
  };
};
