import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
  type ModelSelection,
  type OrchestrationCommand,
  AuthWatchmanVoiceScope,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { WATCHMAN_CONTROL_AGENT } from "../provider/watchmanOpenCodeProfile.ts";
import { isWatchmanWorkspaceRoot } from "../watchmanWorkspace.ts";

function isWatchmanControlSelection(selection: ModelSelection | undefined): boolean {
  return (
    selection?.instanceId === "opencode" &&
    getModelSelectionStringOptionValue(selection, "agent") === WATCHMAN_CONTROL_AGENT
  );
}

export function watchmanVoiceDispatchIssue(
  command: OrchestrationCommand,
  snapshot: {
    readonly projects: ReadonlyArray<{
      readonly id: string;
      readonly workspaceRoot: string;
    }>;
    readonly threads: ReadonlyArray<{
      readonly id: string;
      readonly projectId: string;
      readonly modelSelection: ModelSelection;
    }>;
  },
  watchmanProjectRoot: string | undefined = process.env.WATCHMAN_PROJECT_ROOT,
): string | undefined {
  if (command.type === "thread.create") {
    const project = snapshot.projects.find((candidate) => candidate.id === command.projectId);
    if (!project || !isWatchmanWorkspaceRoot(project.workspaceRoot, watchmanProjectRoot)) {
      return "Voice may create threads only in the canonical Watchman project.";
    }
    if (
      !isWatchmanControlSelection(command.modelSelection) ||
      command.branch !== null ||
      command.worktreePath !== null
    ) {
      return "Voice may create only a Watchman Control thread without a worktree.";
    }
    return undefined;
  }
  if (command.type === "thread.turn.start") {
    const thread = snapshot.threads.find((candidate) => candidate.id === command.threadId);
    const project = snapshot.projects.find((candidate) => candidate.id === thread?.projectId);
    if (
      !thread ||
      !project ||
      !isWatchmanWorkspaceRoot(project.workspaceRoot, watchmanProjectRoot) ||
      !isWatchmanControlSelection(thread.modelSelection)
    ) {
      return "Voice may resume only an existing Watchman Control thread.";
    }
    if (
      !isWatchmanControlSelection(command.modelSelection) ||
      command.message.attachments.length !== 0 ||
      command.bootstrap !== undefined ||
      command.sourceProposedPlan !== undefined
    ) {
      return "Voice may submit only plain text to Watchman Control.";
    }
    return undefined;
  }
  return "Voice may only create a Control thread or start a Control turn.";
}

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          if (
            !principal.scopes.has(AuthOrchestrationReadScope) &&
            !principal.scopes.has(AuthWatchmanVoiceScope)
          ) {
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          }
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          if (
            !principal.scopes.has(AuthOrchestrationReadScope) &&
            !principal.scopes.has(AuthWatchmanVoiceScope)
          ) {
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          }
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const fullOperate = principal.scopes.has(AuthOrchestrationOperateScope);
          if (!fullOperate && !principal.scopes.has(AuthWatchmanVoiceScope)) {
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          }
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          if (!fullOperate) {
            const snapshot = yield* projectionSnapshotQuery
              .getShellSnapshot()
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_snapshot_failed", cause),
                ),
              );
            if (watchmanVoiceDispatchIssue(normalizedCommand, snapshot) !== undefined) {
              return yield* failEnvironmentInvalidRequest("invalid_command");
            }
          }
          return yield* orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      );
  }),
);
