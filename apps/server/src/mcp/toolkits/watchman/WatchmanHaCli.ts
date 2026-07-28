import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../../processRunner.ts";

export class WatchmanHaCliError extends Schema.TaggedErrorClass<WatchmanHaCliError>()(
  "WatchmanHaCliError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class WatchmanHaCli extends Context.Service<
  WatchmanHaCli,
  {
    readonly rest: (
      method: "GET" | "POST",
      path: string,
      payload?: unknown,
    ) => Effect.Effect<unknown, WatchmanHaCliError>;
  }
>()("t3/mcp/toolkits/watchman/WatchmanHaCli") {}

const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export const make = Effect.fn("WatchmanHaCli.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const command = process.env.WATCHMAN_HA_CLI?.trim() || "watchman-ha";

  const rest: WatchmanHaCli["Service"]["rest"] = Effect.fn("WatchmanHaCli.rest")(
    function* (method, path, payload) {
      const body =
        payload === undefined ? undefined : yield* encodeJson(payload).pipe(Effect.orDie);
      const output = yield* runner
        .run({
          command,
          args: ["rest", method, path, ...(body === undefined ? [] : [body])],
          timeout: "30 seconds",
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WatchmanHaCliError({
                operation: `${method} ${path}`,
                message: cause.message,
              }),
          ),
        );
      if (output.code !== 0) {
        return yield* new WatchmanHaCliError({
          operation: `${method} ${path}`,
          message: output.stderr.trim().slice(0, 500) || `watchman-ha exited ${output.code}`,
        });
      }
      return yield* decodeJson(output.stdout).pipe(
        Effect.mapError(
          () =>
            new WatchmanHaCliError({
              operation: `${method} ${path}`,
              message: "watchman-ha returned invalid JSON.",
            }),
        ),
      );
    },
  );

  return WatchmanHaCli.of({ rest });
});

export const layer = Layer.effect(WatchmanHaCli, make());
export const layerLive = layer.pipe(Layer.provide(ProcessRunner.layer));
