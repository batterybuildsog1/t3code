import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TURN_RESTART_INTERRUPTED_ACTIVITY_KIND,
  type TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";
import { isWatchmanWorkspaceRoot } from "./watchmanWorkspace.ts";

export { isWatchmanWorkspaceRoot } from "./watchmanWorkspace.ts";

export class ServerRuntimeStartupError extends Schema.TaggedErrorClass<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

/**
 * Bound on one boot's reconciliation scan, applied to each detection query.
 * Truncation is logged rather than silent, and the remainder settles on the
 * next boot.
 */
export const ORPHANED_SESSION_SCAN_LIMIT = 200;

/**
 * Timeline copy for a turn cut short by a server restart. Settling clears the
 * thread's active turn, which removes the turn from the thread shell, so this
 * note is the only thing left that reports the failure to the user.
 */
export const RESTART_INTERRUPTED_TURN_NOTE =
  "Watchman restarted while working on this, so this reply was cut short. Send your request again if you still need it.";

/**
 * Command ids are derived rather than random so a boot that repeats work
 * already committed short-circuits on the stored receipt.
 *
 * The discriminator is the settled turn where there is one. A session-only
 * orphan has no turn, so it uses the executor's last-seen instant instead:
 * stable for one death (a retried boot dedupes) and distinct for the next one
 * (a thread that goes dirty again is not silently skipped).
 */
const bootReconcileCommandId = (threadId: ThreadId, discriminator: string, tag: string) =>
  CommandId.make(`boot-reconcile:${threadId}:${discriminator}:${tag}`);

/**
 * Boot-time dual of the live executor-death path.
 *
 * When a provider process dies while this server is up, the adapter emits
 * `session.exited`, runtime ingestion writes a "stopped" session, and the
 * `thread.session-set` projector settles the thread's running turns. The one
 * death the server cannot observe live is its own: a killed or destroyed
 * process leaves rows claiming a live executor that no longer exists.
 *
 * The invariant enforced here is that no session may claim to be live when its
 * executor predates this process. Two shapes violate it:
 *
 *  - A turn still recorded as `running`, which every client renders as working
 *    forever.
 *  - A session still `running`/`starting`, or still holding an `activeTurnId`,
 *    after its turn was already settled. Pressing Stop settles the turn but
 *    leaves the session bound, so this outlives the first shape. It is not
 *    cosmetic: a stale `activeTurnId` makes the strict lifecycle guard in
 *    `ProviderRuntimeIngestion` treat the next real turn as conflicting and
 *    refuse its `turn.completed`, which produces a fresh immortal spinner on a
 *    thread that looked clean.
 *
 * Both are remedied by replaying the same settling path from persisted state
 * rather than from a runtime event, so settling keeps one implementation.
 */
export const reconcileOrphanedSessions = (input: { readonly bootAt: string }) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

    const [runningTurns, liveClaimingThreadIds] = yield* Effect.all([
      projectionSnapshotQuery.listRunningTurns(ORPHANED_SESSION_SCAN_LIMIT),
      projectionSnapshotQuery.listThreadsWithLiveSessionClaims(ORPHANED_SESSION_SCAN_LIMIT),
    ]);
    if (runningTurns.length >= ORPHANED_SESSION_SCAN_LIMIT) {
      yield* Effect.logWarning("startup session reconciliation truncated its running-turn scan", {
        scanned: runningTurns.length,
        limit: ORPHANED_SESSION_SCAN_LIMIT,
      });
    }
    if (liveClaimingThreadIds.length >= ORPHANED_SESSION_SCAN_LIMIT) {
      yield* Effect.logWarning("startup session reconciliation truncated its session scan", {
        scanned: liveClaimingThreadIds.length,
        limit: ORPHANED_SESSION_SCAN_LIMIT,
      });
    }

    // Keyed by thread so a thread caught by both detections is settled once.
    // An empty turn list means a session-only orphan: there is no truncated
    // reply to annotate, so it gets no restart note.
    const turnIdsByThreadId = new Map<ThreadId, Array<TurnId>>();
    for (const runningTurn of runningTurns) {
      const existing = turnIdsByThreadId.get(runningTurn.threadId);
      if (existing) {
        existing.push(runningTurn.turnId);
        continue;
      }
      turnIdsByThreadId.set(runningTurn.threadId, [runningTurn.turnId]);
    }
    for (const threadId of liveClaimingThreadIds) {
      if (!turnIdsByThreadId.has(threadId)) {
        turnIdsByThreadId.set(threadId, []);
      }
    }
    if (turnIdsByThreadId.size === 0) {
      return;
    }

    const bindings = yield* providerSessionDirectory.listBindings();
    const bindingByThreadId = new Map(
      bindings.map((binding) => [binding.threadId, binding] as const),
    );
    const bootAtMs = Date.parse(input.bootAt);

    const settleThread = (threadId: ThreadId, turnIds: ReadonlyArray<TurnId>) =>
      Effect.gen(function* () {
        // This gate assumes T3 owns the provider processes it launches, so a
        // stopped or pre-boot runtime row means the executor is genuinely
        // gone. An externally configured OpenCode `serverUrl`
        // (`connectToOpenCodeServer` in `provider/opencodeRuntime.ts`) breaks
        // that assumption: such a server outlives this process and can still
        // be running the turn while these rows read dead. Reconciling
        // external executors needs a live-server probe here, not a
        // persisted-state gate.
        const binding = bindingByThreadId.get(threadId);
        if (!binding) {
          // A missing runtime row is an absence of evidence, not evidence of
          // death — settling on it would race any process that has bound a
          // session without writing its row yet.
          yield* Effect.logWarning(
            "startup session reconciliation skipped a thread with no provider runtime row",
            { threadId, runningTurnCount: turnIds.length },
          );
          return false;
        }

        const lastSeenAtMs = Date.parse(binding.lastSeenAt);
        const lastSeenBeforeBoot =
          Number.isFinite(lastSeenAtMs) && Number.isFinite(bootAtMs) && lastSeenAtMs < bootAtMs;
        if (binding.status !== "stopped" && !lastSeenBeforeBoot) {
          yield* Effect.logDebug(
            "startup session reconciliation skipped a thread whose executor still looks alive",
            { threadId, status: binding.status ?? null, lastSeenAt: binding.lastSeenAt },
          );
          return false;
        }

        // A settled turn's `completedAt` is taken from this timestamp, so it
        // has to be the instant the executor was last alive. Boot time would
        // report a turn killed at 19:23 and reconciled six hours later as a
        // six-hour turn.
        const settledAt = Number.isFinite(lastSeenAtMs) ? binding.lastSeenAt : input.bootAt;
        const settleTurnId = turnIds[0];
        // `thread.session-set` replaces the whole session row, so every field
        // has to be carried forward — a null `providerName` would wipe it.
        const session = Option.getOrUndefined(
          yield* projectionSnapshotQuery.getThreadSessionById(threadId),
        );

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: bootReconcileCommandId(
            threadId,
            settleTurnId ?? `session-${settledAt}`,
            "session-set",
          ),
          threadId,
          session: {
            threadId,
            status: "interrupted",
            providerName: session?.providerName ?? null,
            ...(session?.providerInstanceId !== undefined
              ? { providerInstanceId: session.providerInstanceId }
              : {}),
            runtimeMode: session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            lastError: session?.lastError ?? null,
            updatedAt: settledAt,
          },
          createdAt: input.bootAt,
        });

        // Annotated after the session write, and only for turns this pass
        // actually settled: a note on a turn that is still spinning would be
        // worse than no note at all, and a turn that was already terminal was
        // not cut short by this restart.
        yield* Effect.forEach(
          turnIds,
          (turnId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: bootReconcileCommandId(threadId, turnId, "restart-note"),
              threadId,
              activity: {
                id: EventId.make(`boot-reconcile:${threadId}:${turnId}`),
                tone: "info",
                kind: TURN_RESTART_INTERRUPTED_ACTIVITY_KIND,
                summary: RESTART_INTERRUPTED_TURN_NOTE,
                payload: null,
                turnId,
                createdAt: settledAt,
              },
              createdAt: input.bootAt,
            }),
          { concurrency: 1, discard: true },
        );

        yield* Effect.logInfo("startup session reconciliation settled an orphaned session", {
          threadId,
          turnIds,
          settledAt,
        });
        return true;
      }).pipe(
        // One unsettleable thread must not strand the rest of the scan.
        Effect.catchCause((cause) =>
          Effect.logWarning("startup session reconciliation failed for a thread", {
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

    const settled = yield* Effect.forEach(
      Array.from(turnIdsByThreadId),
      ([threadId, turnIds]) => settleThread(threadId, turnIds),
      { concurrency: 1 },
    );

    const settledThreadCount = settled.filter((wasSettled) => wasSettled).length;
    if (settledThreadCount > 0) {
      yield* Effect.logInfo("startup session reconciliation complete", {
        settledThreadCount,
        scannedThreadCount: turnIdsByThreadId.size,
        scannedTurnCount: runningTurns.length,
      });
    }
  });

/**
 * `startup` runs under `Effect.exit`, and a failure there calls
 * `failCommandReady`, after which `enqueueCommand` returns that error for the
 * rest of the process lifetime while HTTP keeps answering 200 — every client
 * command bricked. Reconciliation is bookkeeping, so nothing it does may
 * escape: a slow database, a typed failure, and a defect all resolve to a log
 * line and a successful phase.
 */
export const runStartupSessionReconciliation = (input: { readonly bootAt: string }) =>
  reconcileOrphanedSessions(input).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning("startup session reconciliation did not complete", { cause }),
    ),
    Effect.catchDefect((defect) =>
      Effect.logWarning("startup session reconciliation defect", { defect }),
    ),
  );

export function getAutoBootstrapDefaultModelSelection(
  workspaceRoot?: string,
  watchmanProjectRoot?: string,
): ModelSelection {
  return isWatchmanWorkspaceRoot(workspaceRoot, watchmanProjectRoot)
    ? {
        instanceId: ProviderInstanceId.make("opencode"),
        // Grok 4.5, not GLM: Cerebras hard-fails the turn once messages +
        // completion pass its 8,192-token ceiling (bit twice, 7/29 and 7/30).
        model: "xai/grok-4.5",
        options: [{ id: "agent", value: "watchman-control" }],
      }
    : {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };
}

export function modelSelectionsEqual(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  return (
    leftOptions.length === rightOptions.length &&
    leftOptions.every(
      (option, index) =>
        option.id === rightOptions[index]?.id && option.value === rightOptions[index]?.value,
    )
  );
}

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

export const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      const isWatchmanProject = isWatchmanWorkspaceRoot(serverConfig.cwd);
      const autoDefaultModelSelection = getAutoBootstrapDefaultModelSelection(serverConfig.cwd);
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = autoDefaultModelSelection;
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection = isWatchmanProject
          ? autoDefaultModelSelection
          : (existingProject.value.defaultModelSelection ?? autoDefaultModelSelection);
        if (
          isWatchmanProject &&
          !modelSelectionsEqual(
            existingProject.value.defaultModelSelection,
            nextProjectDefaultModelSelection,
          )
        ) {
          yield* orchestrationEngine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(yield* randomUUID),
            projectId: nextProjectId,
            defaultModelSelection: nextProjectDefaultModelSelection,
          });
        }
      }

      let existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (isWatchmanProject) {
        const snapshot = yield* projectionReadModelQuery.getShellSnapshot();
        const projectThreads = snapshot.threads.filter(
          (thread) => thread.projectId === nextProjectId && thread.archivedAt === null,
        );
        const watchmanThread = projectThreads.find((thread) => {
          const agent = getModelSelectionStringOptionValue(thread.modelSelection, "agent");
          return agent === "watchman-control" || agent === "watchman-developer";
        });
        if (watchmanThread) {
          existingThreadId = Option.some(watchmanThread.id);
        } else {
          const blankThread = projectThreads.find(
            (thread) =>
              thread.latestTurn === null &&
              thread.session === null &&
              thread.latestUserMessageAt === null,
          );
          if (blankThread) {
            yield* orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(yield* randomUUID),
              threadId: blankThread.id,
              modelSelection: nextProjectDefaultModelSelection,
            });
            existingThreadId = Option.some(blankThread.id);
          } else {
            existingThreadId = Option.none();
          }
        }
      }
      if (Option.isNone(existingThreadId)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const createdThreadId = ThreadId.make(yield* randomUUID);
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* randomUUID),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return yield* Effect.succeed(serverConfig.mode === "desktop" ? baseTarget : undefined).pipe(
    Effect.flatMap((target) =>
      target
        ? Effect.succeed(target)
        : serverAuth.issueStartupPairingUrl(baseTarget, serverConfig.publicBasePath ?? "/"),
    ),
  );
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const keybindings = yield* Keybindings.Keybindings;
  const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
  const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
  const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;

  // Captured before any startup phase runs: turn reconciliation treats a
  // provider runtime row last seen before this instant as belonging to a dead
  // executor, so the earliest available reading is the safest one.
  const runtimeStartedAt = DateTime.formatIso(yield* DateTime.now);

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const reactorScope = yield* Scope.make("sequential");

  yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

  const startup = Effect.gen(function* () {
    yield* Effect.logDebug("startup phase: starting keybindings runtime");
    yield* runStartupPhase(
      "keybindings.start",
      keybindings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start keybindings runtime", {
            path: error.configPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting server settings runtime");
    yield* runStartupPhase(
      "settings.start",
      serverSettings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start server settings runtime", {
            path: error.settingsPath,
            operation: error.operation,
            providerInstanceId: error.providerInstanceId,
            environmentVariable: error.environmentVariable,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
      Effect.gen(function* () {
        yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
        yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
      }),
    );

    // Runs after the reactors subscribe and before `signalCommandReady` opens
    // the command gate, so clients never read a session left claiming a dead
    // executor.
    yield* Effect.logDebug("startup phase: reconciling orphaned sessions");
    yield* runStartupPhase(
      "turns.reconcile",
      runStartupSessionReconciliation({ bootAt: runtimeStartedAt }),
    );

    const welcomeBase = yield* resolveWelcomeBase;
    const environment = yield* serverEnvironment.getDescriptor;
    yield* Effect.logDebug("startup phase: preparing welcome payload");
    yield* Effect.logDebug("startup phase: publishing welcome event", {
      environmentId: environment.environmentId,
      cwd: welcomeBase.cwd,
      projectName: welcomeBase.projectName,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: {
          environment,
          ...welcomeBase,
        },
      }),
    );

    if (serverConfig.autoBootstrapProjectFromCwd) {
      yield* Effect.forkScoped(
        runStartupPhase(
          "welcome.autobootstrap",
          Effect.gen(function* () {
            const bootstrapTargets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
              Effect.provideService(Crypto.Crypto, crypto),
            );
            if (!bootstrapTargets.bootstrapProjectId && !bootstrapTargets.bootstrapThreadId) {
              return;
            }

            yield* Effect.logDebug("startup phase: publishing bootstrapped welcome event", {
              environmentId: environment.environmentId,
              cwd: welcomeBase.cwd,
              projectName: welcomeBase.projectName,
              bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
              bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
            });
            yield* lifecycleEvents.publish({
              version: 1,
              type: "welcome",
              payload: {
                environment,
                ...welcomeBase,
                ...bootstrapTargets,
              },
            });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("startup auto-bootstrap welcome failed", {
                cause,
              }),
            ),
          ),
        ),
      );
    }
  }).pipe(
    Effect.annotateSpans({
      "server.mode": serverConfig.mode,
      "server.port": serverConfig.port,
      "server.host": serverConfig.host ?? "default",
    }),
    Effect.withSpan("server.startup", { kind: "server", root: true }),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const startupExit = yield* Effect.exit(startup);
      if (Exit.isFailure(startupExit)) {
        const error = new ServerRuntimeStartupError({
          mode: serverConfig.mode,
          host: serverConfig.host ?? null,
          port: serverConfig.port,
          cause: startupExit.cause,
        });
        yield* Effect.logError("server runtime startup failed", { cause: startupExit.cause });
        yield* commandGate.failCommandReady(error);
        return;
      }

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment: yield* serverEnvironment.getDescriptor,
          },
        }),
      );

      yield* Effect.logDebug("startup phase: recording startup heartbeat");
      yield* launchStartupHeartbeat;
      if (serverConfig.startupPresentation === "headless") {
        yield* Effect.logDebug("startup phase: headless access info");
        const accessInfo = yield* issueHeadlessServeAccessInfo();
        yield* runStartupPhase(
          "headless.output",
          Console.log(formatHeadlessServeOutput(accessInfo)),
        );
      } else {
        yield* Effect.logDebug("startup phase: browser open check");
        const startupBrowserTarget = yield* resolveStartupBrowserTarget;
        if (serverConfig.mode !== "desktop") {
          yield* Effect.logInfo(
            "Authentication required. Open T3 Code using the pairing URL.",
          ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
        }
        yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
      }
      yield* Effect.logDebug("startup phase: complete");
    }),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartup["Service"];
});

export const layer = Layer.effect(ServerRuntimeStartup, make);
