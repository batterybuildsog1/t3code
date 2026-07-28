import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../../../processRunner.ts";
import * as WatchmanHaCli from "./WatchmanHaCli.ts";

it.effect("passes exact REST arguments to the existing watchman-ha helper", () => {
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const RunnerLayer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) => {
        invocations.push(input);
        return Effect.succeed({
          stdout: '{"ok":true}',
          stderr: "",
          code: ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* WatchmanHaCli.WatchmanHaCli;
    expect(
      yield* cli.rest("POST", "/api/services/input_number/set_value", {
        entity_id: "input_number.well_user_max_hz",
        value: 110,
      }),
    ).toEqual({ ok: true });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: "watchman-ha",
      args: [
        "rest",
        "POST",
        "/api/services/input_number/set_value",
        '{"entity_id":"input_number.well_user_max_hz","value":110}',
      ],
      timeout: "30 seconds",
    });
  }).pipe(
    Effect.provide(
      WatchmanHaCli.layer.pipe(Layer.provide(RunnerLayer), Layer.provide(NodeServices.layer)),
    ),
  );
});

it.effect("includes the Home Assistant response body when the helper fails", () => {
  const RunnerLayer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          stdout: '{"message":"Data should be valid JSON."}',
          stderr: "curl: (22) The requested URL returned error: 400",
          code: ExitCode(22),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* WatchmanHaCli.WatchmanHaCli;
    const result = yield* Effect.result(
      cli.rest("POST", "/api/services/remote/turn_on", { entity_id: "remote.tv_d_streamer" }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    const error = result.failure;
    expect(error.message).toContain("requested URL returned error: 400");
    expect(error.message).toContain("Data should be valid JSON.");
  }).pipe(
    Effect.provide(
      WatchmanHaCli.layer.pipe(Layer.provide(RunnerLayer), Layer.provide(NodeServices.layer)),
    ),
  );
});
