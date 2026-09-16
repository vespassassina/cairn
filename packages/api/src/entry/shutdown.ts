import type { Server } from "node:http";

/**
 * Stopping on purpose, within the time the platform allows (ADR-046).
 *
 * Cairn used to have no signal handler at all, so it wrote until the instant
 * it was killed. On Azure that is a real cost rather than an untidiness:
 * Container Apps sends SIGTERM and then SIGKILL thirty seconds later, and
 * Litestream is streaming the database to blob storage the whole time. A
 * process killed mid-write leaves Litestream shipping a transaction it never
 * finishes, and a truncated transaction in the replica is what took the Azure
 * Cairn down for four days on 2026-09-15 (docs/LESSONS.md).
 *
 * So shutdown is a sequence with a deadline:
 *
 * 1. Stop listening, so nothing new arrives.
 * 2. Let requests already in flight finish.
 * 3. Run the steps, in order. Backing up comes before closing the database,
 *    because a backup of a closed database is not possible.
 * 4. Close the database. SQLite checkpoints the WAL and removes it when the
 *    last connection to it closes, which is what leaves Litestream a clean,
 *    finished file rather than a moving one.
 *
 * Every phase is bounded by one deadline. Running out of time is not a reason
 * to hang: it is a reason to say which step did not finish and stop anyway,
 * because the alternative is being killed without saying anything at all.
 */

export interface ShutdownStep {
  /** Named in the log, so a step that runs out of time can be identified. */
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownOptions {
  /** The listening servers. Usually one per bound address. */
  servers: Server[];
  /** Run in order, after the servers stop and before the process exits. */
  steps: ShutdownStep[];
  /**
   * Total milliseconds to finish in. Must be under the platform's own grace
   * period, or the platform kills us part way through and we are back to the
   * problem this file exists to solve.
   */
  budgetMs: number;
  log: (line: string) => void;
  exit: (code: number) => void;
}

/** Resolves to true if `work` finished in time, false if the deadline came first. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    // A pending timer must not be the reason the process stays alive.
    timer.unref?.();
  });
  try {
    return (await Promise.race([work.then(() => true), expired])) as boolean;
  } finally {
    clearTimeout(timer);
  }
}

function stopListening(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Keep-alive sockets sit idle between requests and would hold `close` open
    // for as long as the client cared to wait. Ending the idle ones costs
    // nothing: by definition no request is on them.
    server.closeIdleConnections?.();
  });
}

/**
 * Shut down once, within `budgetMs`. Returns the exit code rather than exiting,
 * so a test can run the whole sequence.
 */
export async function runShutdown(
  options: Omit<ShutdownOptions, "exit">,
  reason: string,
): Promise<number> {
  const { servers, steps, budgetMs, log } = options;
  const started = Date.now();
  const left = (): number => budgetMs - (Date.now() - started);

  log(`stopping on ${reason}, with ${Math.round(budgetMs / 1000)}s to do it tidily`);

  // Draining gets at most half the budget, however long requests take. The
  // steps after it are the ones that protect the replica, and an abandoned
  // request is a far smaller loss than a database left open to be killed
  // mid-write. A handler stuck on something outside our control must not be
  // able to spend the time that closing the database needs.
  const drained = await within(
    Promise.all(servers.map(stopListening)),
    Math.min(left(), budgetMs / 2),
  );
  if (drained) {
    log("stopped listening, and requests in flight have finished");
  } else {
    log(
      `warning: requests were still running after ${Math.round((Date.now() - started) / 1000)}s, so they are being abandoned. ` +
        "Whatever they had written is committed; whatever they had not is lost, which is the same as any other sudden stop.",
    );
  }

  let failed = false;
  for (const step of steps) {
    const remaining = left();
    if (remaining <= 0) {
      log(
        `warning: no time left for "${step.name}", so it was skipped. ` +
          "Raise CAIRN_SHUTDOWN_SECONDS, and the platform's own grace period with it, if this keeps happening.",
      );
      failed = true;
      continue;
    }
    const at = Date.now();
    let error: unknown = null;
    const finished = await within(
      step.run().catch((caught: unknown) => {
        error = caught;
      }),
      remaining,
    );
    if (error !== null) {
      log(`warning: "${step.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    } else if (!finished) {
      log(
        `warning: "${step.name}" ran out of time after ${Math.round(remaining / 1000)}s and did not finish. ` +
          "It is being left where it is rather than stopping the shutdown, because the platform will not wait.",
      );
      failed = true;
    } else {
      log(`${step.name}, in ${Date.now() - at}ms`);
    }
  }

  log(`stopped after ${Date.now() - started}ms`);
  // A step that did not finish is worth a non-zero code: on a platform that
  // reports it, an operator sees that the stop was untidy rather than clean.
  return failed ? 1 : 0;
}

/**
 * Listen for the signals that mean "stop", and run the sequence once.
 *
 * A second signal stops immediately. Someone pressing Ctrl-C twice, or a
 * platform escalating, is asking to stop now, and honouring that is better
 * than appearing hung.
 */
export function installShutdown(options: ShutdownOptions): void {
  const { log, exit } = options;
  let running = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (running) {
      log(`${signal} again, so stopping now without finishing`);
      exit(1);
      return;
    }
    running = true;
    void runShutdown(options, signal).then(exit, (error: unknown) => {
      log(`warning: shutting down failed: ${error instanceof Error ? error.message : String(error)}`);
      exit(1);
    });
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, handle);
  }
}
