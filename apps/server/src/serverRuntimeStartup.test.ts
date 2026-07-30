import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL,
  type OrchestrationCommand,
  type OrchestrationSession,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TURN_RESTART_INTERRUPTED_ACTIVITY_KIND,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex default for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it("uses Watchman Control as the Watchman project default", () => {
  assert.deepStrictEqual(
    ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection("/srv/watchman", "/srv/watchman"),
    {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "cerebras/zai-glm-4.7",
      options: [{ id: "agent", value: "watchman-control" }],
    },
  );
});

it("compares model selections structurally before updating Watchman project metadata", () => {
  const left = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "cerebras/zai-glm-4.7",
    options: [{ id: "agent", value: "watchman-control" }],
  };
  const right = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "cerebras/zai-glm-4.7",
    options: [{ id: "agent", value: "watchman-control" }],
  };

  assert.equal(ServerRuntimeStartup.modelSelectionsEqual(left, right), true);
  assert.equal(
    ServerRuntimeStartup.modelSelectionsEqual(left, {
      ...right,
      options: [{ id: "agent", value: "watchman-developer" }],
    }),
    false,
  );
});

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          listRunningTurns: () => Effect.die("unused"),
          getThreadSessionById: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        listRunningTurns: () => Effect.die("unused"),
        getThreadSessionById: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        listRunningTurns: () => Effect.die("unused"),
        getThreadSessionById: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        listRunningTurns: () => Effect.die("unused"),
        getThreadSessionById: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// ---------------------------------------------------------------------------
// reconcileOrphanedRunningTurns — boot-time dual of the live `session.exited`
// settling path. The container can be destroyed mid-turn, which leaves
// `projection_turns` on `state='running'` with no live executor to close it.
// ---------------------------------------------------------------------------

const RECONCILE_BOOT_AT = "2026-01-01T06:00:00.000Z";
const RECONCILE_LAST_SEEN_AT = "2026-01-01T00:23:00.000Z";
const reconcileThreadId = ThreadId.make("thread-orphaned-turn");
const reconcileTurnId = TurnId.make("turn-orphaned-1");
const reconcileSecondTurnId = TurnId.make("turn-orphaned-2");

const reconcileSession: OrchestrationSession = {
  threadId: reconcileThreadId,
  status: "running",
  providerName: "opencode",
  providerInstanceId: ProviderInstanceId.make("opencode"),
  runtimeMode: "auto-accept-edits",
  activeTurnId: reconcileTurnId,
  lastError: "earlier failure",
  updatedAt: RECONCILE_LAST_SEEN_AT,
};

const reconcileBinding = (
  overrides: Partial<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>,
): ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata => ({
  threadId: reconcileThreadId,
  provider: ProviderDriverKind.make("opencode"),
  providerInstanceId: ProviderInstanceId.make("opencode"),
  status: "stopped",
  runtimeMode: "auto-accept-edits",
  lastSeenAt: RECONCILE_LAST_SEEN_AT,
  ...overrides,
});

const reconcileProjectionSnapshotQuery = (
  overrides: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQueryShape>,
): ProjectionSnapshotQuery.ProjectionSnapshotQueryShape => ({
  getCommandReadModel: () => Effect.die("unused"),
  getSnapshot: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.die("unused"),
  getArchivedShellSnapshot: () => Effect.die("unused"),
  getSnapshotSequence: () => Effect.die("unused"),
  getCounts: () => Effect.die("unused"),
  getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
  getProjectShellById: () => Effect.die("unused"),
  getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
  listRunningTurns: () => Effect.succeed([]),
  getThreadSessionById: () => Effect.succeed(Option.some(reconcileSession)),
  getThreadCheckpointContext: () => Effect.die("unused"),
  getFullThreadDiffContext: () => Effect.die("unused"),
  getThreadShellById: () => Effect.die("unused"),
  getThreadDetailById: () => Effect.die("unused"),
  getThreadDetailSnapshot: () => Effect.die("unused"),
  ...overrides,
});

const reconcileProviderSessionDirectory = (
  bindings: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>,
): ProviderSessionDirectory.ProviderSessionDirectory["Service"] => ({
  upsert: () => Effect.die("unused"),
  getProvider: () => Effect.die("unused"),
  getBinding: () => Effect.die("unused"),
  listThreadIds: () => Effect.die("unused"),
  listBindings: () => Effect.succeed(bindings),
});

const runReconciliation = (input: {
  readonly runningTurns: ReadonlyArray<ProjectionSnapshotQuery.ProjectionRunningTurn>;
  readonly bindings: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>;
  readonly session?: Option.Option<OrchestrationSession>;
}) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    yield* ServerRuntimeStartup.reconcileOrphanedRunningTurns({
      bootAt: RECONCILE_BOOT_AT,
    }).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        reconcileProjectionSnapshotQuery({
          listRunningTurns: () => Effect.succeed(input.runningTurns),
          getThreadSessionById: () =>
            Effect.succeed(input.session ?? Option.some(reconcileSession)),
        }),
      ),
      Effect.provideService(
        ProviderSessionDirectory.ProviderSessionDirectory,
        reconcileProviderSessionDirectory(input.bindings),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
    );
    return yield* Ref.get(dispatched);
  });

const sessionSetCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.session.set" }> =>
      command.type === "thread.session.set",
  );

const activityAppendCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
      command.type === "thread.activity.append",
  );

it.effect("reconciles an orphaned running turn through the existing turn settler", () =>
  Effect.gen(function* () {
    const commands = yield* runReconciliation({
      runningTurns: [{ threadId: reconcileThreadId, turnId: reconcileTurnId }],
      bindings: [reconcileBinding({})],
    });

    // The session write comes first: a restart note on a turn that is still
    // spinning would be worse than no note at all.
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      ["thread.session.set", "thread.activity.append"],
    );

    const [sessionCommand] = sessionSetCommands(commands);
    assert.isDefined(sessionCommand);
    // Deterministic so a repeated boot short-circuits on the stored receipt.
    assert.strictEqual(
      sessionCommand?.commandId,
      `boot-reconcile:${reconcileThreadId}:${reconcileTurnId}:session-set`,
    );
    assert.deepStrictEqual(sessionCommand?.session, {
      threadId: reconcileThreadId,
      // "interrupted", not "stopped": several ProviderCommandReactor paths
      // guard on `status !== "stopped"`, and both map to turn state
      // "interrupted".
      status: "interrupted",
      providerName: "opencode",
      providerInstanceId: ProviderInstanceId.make("opencode"),
      runtimeMode: "auto-accept-edits",
      activeTurnId: null,
      lastError: "earlier failure",
      // The settled turn's completedAt comes from here, so it has to be the
      // instant the executor was last alive — not this boot, six hours later.
      updatedAt: RECONCILE_LAST_SEEN_AT,
    });

    const [activityCommand] = activityAppendCommands(commands);
    assert.isDefined(activityCommand);
    assert.strictEqual(
      activityCommand?.commandId,
      `boot-reconcile:${reconcileThreadId}:${reconcileTurnId}:restart-note`,
    );
    assert.strictEqual(activityCommand?.activity.kind, TURN_RESTART_INTERRUPTED_ACTIVITY_KIND);
    assert.strictEqual(
      activityCommand?.activity.summary,
      ServerRuntimeStartup.RESTART_INTERRUPTED_TURN_NOTE,
    );
    assert.strictEqual(activityCommand?.activity.turnId, reconcileTurnId);
    assert.strictEqual(activityCommand?.activity.createdAt, RECONCILE_LAST_SEEN_AT);
  }),
);

it.effect("settles every running turn on a thread with one session write", () =>
  Effect.gen(function* () {
    const commands = yield* runReconciliation({
      runningTurns: [
        { threadId: reconcileThreadId, turnId: reconcileTurnId },
        { threadId: reconcileThreadId, turnId: reconcileSecondTurnId },
      ],
      bindings: [reconcileBinding({})],
    });

    assert.strictEqual(sessionSetCommands(commands).length, 1);
    assert.deepStrictEqual(
      activityAppendCommands(commands).map((command) => command.activity.turnId),
      [reconcileTurnId, reconcileSecondTurnId],
    );
  }),
);

it.effect("leaves a running turn alone while its executor still looks alive", () =>
  Effect.gen(function* () {
    const commands = yield* runReconciliation({
      runningTurns: [{ threadId: reconcileThreadId, turnId: reconcileTurnId }],
      bindings: [reconcileBinding({ status: "running", lastSeenAt: "2026-01-01T06:00:01.000Z" })],
    });

    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("leaves a running turn alone when no provider runtime row proves the executor died", () =>
  Effect.gen(function* () {
    const commands = yield* runReconciliation({
      runningTurns: [{ threadId: reconcileThreadId, turnId: reconcileTurnId }],
      bindings: [],
    });

    assert.deepStrictEqual(commands, []);
  }),
);

it.effect("still settles a running turn when the thread has no session row left", () =>
  Effect.gen(function* () {
    const commands = yield* runReconciliation({
      runningTurns: [{ threadId: reconcileThreadId, turnId: reconcileTurnId }],
      bindings: [reconcileBinding({})],
      session: Option.none(),
    });

    const [sessionCommand] = sessionSetCommands(commands);
    assert.deepStrictEqual(sessionCommand?.session, {
      threadId: reconcileThreadId,
      status: "interrupted",
      providerName: null,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: RECONCILE_LAST_SEEN_AT,
    });
  }),
);

it.effect("falls back to boot time only when the runtime row has no usable last-seen stamp", () =>
  Effect.gen(function* () {
    const commands = yield* runReconciliation({
      runningTurns: [{ threadId: reconcileThreadId, turnId: reconcileTurnId }],
      bindings: [reconcileBinding({ lastSeenAt: "" })],
    });

    const [sessionCommand] = sessionSetCommands(commands);
    assert.strictEqual(sessionCommand?.session.updatedAt, RECONCILE_BOOT_AT);
  }),
);

/**
 * `startup` runs under `Effect.exit`; a failure there fails command readiness
 * for the rest of the process while HTTP keeps answering. Reconciliation is
 * bookkeeping and must never reach that path.
 */
const runContainedReconciliation = (
  listRunningTurns: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["listRunningTurns"],
) =>
  ServerRuntimeStartup.runStartupTurnReconciliation({ bootAt: RECONCILE_BOOT_AT }).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      reconcileProjectionSnapshotQuery({ listRunningTurns }),
    ),
    Effect.provideService(
      ProviderSessionDirectory.ProviderSessionDirectory,
      reconcileProviderSessionDirectory([]),
    ),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("unused"),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
  );

it.effect("keeps a failing reconciliation from failing startup", () =>
  runContainedReconciliation(() =>
    Effect.fail(
      new PersistenceSqlError({
        operation: "ProjectionSnapshotQuery.listRunningTurns:query",
        cause: new Error("database is locked"),
      }),
    ),
  ),
);

it.effect("keeps a defective reconciliation from failing startup", () =>
  runContainedReconciliation(() => Effect.die(new Error("projection table is missing"))),
);
