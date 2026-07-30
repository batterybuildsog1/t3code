import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as TvdSpool from "./TvdSpool.ts";

const decodeTvdRequest = Schema.decodeUnknownEffect(TvdSpool.TvdRequest);
const request: TvdSpool.TvdRequest = {
  schema: 1,
  request_id: "00000000-0000-4000-8000-000000000001",
  source: "t3",
  screen: "d",
  intent: "power",
  payload: { state: "on" },
  issued_at: 1_000_000,
  ttl_s: 120,
};

it.effect("rejects removed generic and unwitnessed intents at the spool boundary", () =>
  Effect.gen(function* () {
    for (const intent of ["volume", "navigate", "input_text"]) {
      const result = yield* Effect.result(
        decodeTvdRequest({
          ...request,
          intent,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
    }
  }),
);

it.effect("creates mode-0600 requests exclusively and decodes tvd files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tvd-spool-" });
      yield* fileSystem.makeDirectory(`${base}/tv_requests`);
      yield* fileSystem.makeDirectory(`${base}/tv_receipts`);
      const spool = yield* TvdSpool.make({ base });

      yield* spool.fileRequest(request);
      const requestPath = `${base}/tv_requests/${request.request_id}.json`;
      expect(yield* fileSystem.readFileString(requestPath)).toBe(
        '{"schema":1,"request_id":"00000000-0000-4000-8000-000000000001","source":"t3","screen":"d","intent":"power","payload":{"state":"on"},"issued_at":1000000,"ttl_s":120}',
      );
      expect((yield* fileSystem.stat(requestPath)).mode & 0o777).toBe(0o600);

      const collision = yield* Effect.result(spool.fileRequest(request));
      expect(Result.isFailure(collision)).toBe(true);
      if (Result.isSuccess(collision)) return;
      expect(collision.failure.reason).toBe("collision");

      yield* fileSystem.writeFileString(
        `${base}/tv_receipts/${request.request_id}.json`,
        '{"requested":{"request_id":"00000000-0000-4000-8000-000000000001"},"accepted":"rejected(observe_only)","applied":"failed","observed":{"screens":{}},"evidence":"no write occurred"}',
      );
      yield* fileSystem.writeFileString(
        `${base}/tvd_health.json`,
        '{"t":1000000,"ok":true,"mode":"observe","seq":9,"reachable":4}',
      );
      yield* fileSystem.writeFileString(
        `${base}/tv_latest.json`,
        '{"t":1000000,"shed_active":false,"screens":{"d":{"state":"idle","foreground_pkg":"de.ozerov.fully","playing_pkg":null,"claim":null,"overlay":{"name":null},"raw_witness":"ignored"}}}',
      );

      expect(yield* spool.readReceipt(request.request_id)).toEqual({
        requested: { request_id: request.request_id },
        accepted: "rejected(observe_only)",
        applied: "failed",
        observed: { screens: {} },
        evidence: "no write occurred",
      });
      expect(yield* spool.readHealth()).toMatchObject({
        t: 1_000_000,
        ok: true,
        mode: "observe",
        seq: 9,
        reachable: 4,
      });
      expect(yield* spool.readSnapshot()).toMatchObject({
        t: 1_000_000,
        shed_active: false,
        screens: {
          d: {
            state: "idle",
            foreground_pkg: "de.ozerov.fully",
            raw_witness: "ignored",
          },
        },
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
