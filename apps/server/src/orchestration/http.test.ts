import { expect, it } from "@effect/vitest";
import { ModelSelection, OrchestrationCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { watchmanVoiceDispatchIssue } from "./http.ts";

const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeSelection = Schema.decodeUnknownSync(ModelSelection);
const project = {
  id: "project-watchman",
  workspaceRoot: "/srv/watchman",
};
const controlSelection = decodeSelection({
  instanceId: "opencode",
  model: "zai-coding-plan/glm-4.7",
  options: [{ id: "agent", value: "watchman-control" }],
});
const developerSelection = decodeSelection({
  ...controlSelection,
  options: [{ id: "agent", value: "watchman-developer" }],
});
const controlThread = {
  id: "thread-watchman-voice",
  projectId: project.id,
  modelSelection: controlSelection,
};
const snapshot = {
  projects: [project],
  threads: [controlThread],
};

const createCommand = (modelSelection: typeof controlSelection = controlSelection) =>
  decodeCommand({
    type: "thread.create",
    commandId: "command-create",
    threadId: controlThread.id,
    projectId: project.id,
    title: "Voice conversation",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-07-28T12:00:00.000Z",
  });

const turnCommand = (modelSelection: typeof controlSelection = controlSelection) =>
  decodeCommand({
    type: "thread.turn.start",
    commandId: "command-turn",
    threadId: controlThread.id,
    message: {
      messageId: "message-voice",
      role: "user",
      text: "What is the site status?",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-07-28T12:00:01.000Z",
  });

it("allows only canonical Watchman Control creates and turns for the voice scope", () => {
  expect(watchmanVoiceDispatchIssue(createCommand(), snapshot, "/srv/watchman")).toBeUndefined();
  expect(watchmanVoiceDispatchIssue(turnCommand(), snapshot, "/srv/watchman")).toBeUndefined();
});

it("rejects Developer selection and non-voice orchestration commands", () => {
  expect(
    watchmanVoiceDispatchIssue(createCommand(developerSelection), snapshot, "/srv/watchman"),
  ).toContain("Control");
  expect(
    watchmanVoiceDispatchIssue(turnCommand(developerSelection), snapshot, "/srv/watchman"),
  ).toContain("plain text");
  expect(
    watchmanVoiceDispatchIssue(
      decodeCommand({
        type: "project.delete",
        commandId: "command-delete",
        projectId: project.id,
        force: true,
      }),
      snapshot,
      "/srv/watchman",
    ),
  ).toContain("only create");
});

it("rejects another project and an existing Developer thread", () => {
  expect(
    watchmanVoiceDispatchIssue(
      createCommand(),
      { projects: [{ ...project, workspaceRoot: "/srv/other" }], threads: [] },
      "/srv/watchman",
    ),
  ).toContain("canonical");
  expect(
    watchmanVoiceDispatchIssue(
      turnCommand(),
      {
        projects: [project],
        threads: [{ ...controlThread, modelSelection: developerSelection }],
      },
      "/srv/watchman",
    ),
  ).toContain("existing Watchman Control");
});
