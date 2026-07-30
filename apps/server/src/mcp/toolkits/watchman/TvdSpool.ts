import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const strictJson = { parseOptions: { onExcessProperty: "error" } } as const;
const preserveJson = { parseOptions: { onExcessProperty: "preserve" } } as const;

export const TvdRequest = Schema.Struct({
  schema: Schema.Literal(1),
  request_id: Schema.String,
  source: Schema.Literal("t3"),
  screen: Schema.Literals(["a", "b", "c", "d", "all"]),
  intent: Schema.Literals(["play", "show", "scene", "transport", "power", "hold", "release"]),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  lease: Schema.optional(
    Schema.Struct({
      class: Schema.Literal("hold"),
      expires_at: Schema.Finite,
    }),
  ),
  issued_at: Schema.Finite,
  ttl_s: Schema.Literal(120),
}).annotate(strictJson);
export type TvdRequest = typeof TvdRequest.Type;

export const TvdReceipt = Schema.Struct({
  requested: Schema.Record(Schema.String, Schema.Unknown),
  accepted: Schema.String,
  applied: Schema.String,
  observed: Schema.Record(Schema.String, Schema.Unknown),
  evidence: Schema.String,
}).annotate(strictJson);
export type TvdReceipt = typeof TvdReceipt.Type;

export const TvdHealth = Schema.Struct({
  t: Schema.Finite,
  ok: Schema.Boolean,
  mode: Schema.Literals(["active", "observe"]),
  seq: Schema.Int,
}).annotate(preserveJson);
export type TvdHealth = typeof TvdHealth.Type;

const TvdClaim = Schema.Struct({
  source: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Finite),
}).annotate(preserveJson);

const TvdOverlay = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate(preserveJson);

const TvdScreenSnapshot = Schema.Struct({
  state: Schema.optional(Schema.NullOr(Schema.String)),
  foreground_pkg: Schema.optional(Schema.NullOr(Schema.String)),
  playing_pkg: Schema.optional(Schema.NullOr(Schema.String)),
  claim: Schema.optional(Schema.NullOr(TvdClaim)),
  overlay: Schema.optional(TvdOverlay),
}).annotate(preserveJson);

export const TvdSnapshot = Schema.Struct({
  t: Schema.Finite,
  shed_active: Schema.NullOr(Schema.Boolean),
  screens: Schema.Record(Schema.String, TvdScreenSnapshot),
}).annotate(preserveJson);
export type TvdSnapshot = typeof TvdSnapshot.Type;

export class TvdSpoolError extends Schema.TaggedErrorClass<TvdSpoolError>()("TvdSpoolError", {
  operation: Schema.String,
  reason: Schema.Literals(["collision", "not_found", "io", "invalid_json"]),
  message: Schema.String,
}) {}

export class TvdSpool extends Context.Service<
  TvdSpool,
  {
    readonly fileRequest: (request: TvdRequest) => Effect.Effect<void, TvdSpoolError>;
    readonly readReceipt: (id: string) => Effect.Effect<TvdReceipt, TvdSpoolError>;
    readonly readHealth: () => Effect.Effect<TvdHealth, TvdSpoolError>;
    readonly readSnapshot: () => Effect.Effect<TvdSnapshot, TvdSpoolError>;
    readonly receiptPollIntervalMs: number;
    readonly receiptPollBudgetMs: number;
  }
>()("t3/mcp/toolkits/watchman/TvdSpool") {}

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeReceipt = Schema.decodeUnknownEffect(TvdReceipt);
const decodeHealth = Schema.decodeUnknownEffect(TvdHealth);
const decodeSnapshot = Schema.decodeUnknownEffect(TvdSnapshot);

const readError = (operation: string, cause: PlatformError.PlatformError): TvdSpoolError =>
  new TvdSpoolError({
    operation,
    reason: cause.reason._tag === "NotFound" ? "not_found" : "io",
    message: cause.message,
  });

const invalidJson = (operation: string): TvdSpoolError =>
  new TvdSpoolError({
    operation,
    reason: "invalid_json",
    message: `${operation} returned invalid JSON.`,
  });

export interface MakeOptions {
  readonly base?: string;
  readonly receiptPollIntervalMs?: number;
  readonly receiptPollBudgetMs?: number;
}

export const make = Effect.fn("TvdSpool.make")(function* (options: MakeOptions = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const base =
    options.base ?? (process.env.WATCHMAN_DRIVE_LOGS?.trim() || "/homeassistant/drive_logs");

  const readAndDecode = <A>(
    operation: string,
    path: string,
    decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    Effect.gen(function* () {
      const raw = yield* fileSystem
        .readFileString(path)
        .pipe(Effect.mapError((cause) => readError(operation, cause)));
      const json = yield* decodeJson(raw).pipe(Effect.mapError(() => invalidJson(operation)));
      return yield* decode(json).pipe(Effect.mapError(() => invalidJson(operation)));
    });

  const fileRequest: TvdSpool["Service"]["fileRequest"] = Effect.fn("TvdSpool.fileRequest")(
    function* (request) {
      const path = `${base}/tv_requests/${request.request_id}.json`;
      const body = yield* encodeJson(request).pipe(Effect.orDie);
      const bytes = new TextEncoder().encode(body);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(path, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(bytes);
          yield* file.sync;
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TvdSpoolError({
              operation: "file TV request",
              reason: cause.reason._tag === "AlreadyExists" ? "collision" : "io",
              message: cause.message,
            }),
        ),
      );
    },
  );

  const readReceipt: TvdSpool["Service"]["readReceipt"] = Effect.fn("TvdSpool.readReceipt")((id) =>
    readAndDecode("read TV receipt", `${base}/tv_receipts/${id}.json`, decodeReceipt),
  );

  const readHealth: TvdSpool["Service"]["readHealth"] = Effect.fn("TvdSpool.readHealth")(() =>
    readAndDecode("read tvd health", `${base}/tvd_health.json`, decodeHealth),
  );

  const readSnapshot: TvdSpool["Service"]["readSnapshot"] = Effect.fn("TvdSpool.readSnapshot")(() =>
    readAndDecode("read tvd snapshot", `${base}/tv_latest.json`, decodeSnapshot),
  );

  return TvdSpool.of({
    fileRequest,
    readReceipt,
    readHealth,
    readSnapshot,
    receiptPollIntervalMs: options.receiptPollIntervalMs ?? 400,
    receiptPollBudgetMs: options.receiptPollBudgetMs ?? 10_000,
  });
});

export const layer = Layer.effect(TvdSpool, make());
export const layerLive = layer;
