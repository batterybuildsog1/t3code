import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WatchmanToolkitHandlersLive } from "./handlers.ts";
import { WatchmanToolkit } from "./tools.ts";
import * as WatchmanHaCli from "./WatchmanHaCli.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-watchman-test"),
  threadId: ThreadId.make("thread-watchman-test"),
  providerSessionId: "provider-session-watchman-test",
  providerInstanceId: ProviderInstanceId.make("opencode"),
  capabilities: new Set(["preview", "watchman-control"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "watchman-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const state = (entity_id: string, value: string, attributes: Record<string, unknown> = {}) => ({
  entity_id,
  state: value,
  attributes,
});

const freshStates = (states: ReadonlyArray<ReturnType<typeof state>>) =>
  DateTime.now.pipe(
    Effect.map((now) => {
      const observedAt = DateTime.formatIso(now);
      return states.map((entity) => ({
        ...entity,
        last_changed: observedAt,
        last_updated: observedAt,
      }));
    }),
  );

it.effect("keeps the Watchman MCP surface closed and controller-owned", () => {
  const calls: Array<{
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly payload?: unknown;
  }> = [];
  const states = [
    state("input_select.hvac_mode", "Auto"),
    state("input_select.hvac_requested_pairs", "None"),
    state("input_number.hvac_party_setpoint_f", "74"),
    state("input_select.well_solar_operator_mode", "manual_hold"),
    state("input_number.well_user_max_hz", "110"),
    state("sensor.watchman_drive_snapshot", "True", {
      mode: "poller-v3",
      ctrl_requested_mode: "hold",
      ctrl_applied_mode: "hold",
      ctrl_ack: true,
      ctrl_error: null,
      ctrl_held: true,
      ctrl_command_age_s: 1,
    }),
    state("sensor.well_solar_controller", "HOLD", { safety_latch: null }),
    state("sensor.watchman_hvac_controller", "ready", {
      pair_states: { A: "off", B: "off", C: "off", D: "full_on" },
    }),
    ...["a", "b", "c", "d"].flatMap((screen) => [
      state(`media_player.tv_${screen}_streamer`, "on", { app_id: "de.ozerov.fully" }),
      state(`media_player.tv_${screen}_panel`, "on"),
    ]),
    ...["a", "b", "c", "d"].map((pair) => state(`binary_sensor.hvac_pair_${pair}_active`, "off")),
  ];
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      rest: (method, path, payload) => {
        calls.push({ method, path, ...(payload === undefined ? {} : { payload }) });
        return method === "GET" ? freshStates(states) : Effect.succeed([]);
      },
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  const call = (name: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual(
      [
        "watchman_automation",
        "watchman_history",
        "watchman_hvac_control",
        "watchman_power_control",
        "watchman_status",
        "watchman_tv_control",
        "watchman_water_control",
      ].sort(),
    );

    const status = yield* call("watchman_status", { area: "water" });
    expect(status.isError).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/states" });

    const invalidSpeed = yield* call("watchman_water_control", {
      operation: "set_speed_cap",
      max_hz: 101,
    });
    expect(invalidSpeed.isError).toBe(true);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);

    const irrelevantHvacField = yield* call("watchman_hvac_control", {
      operation: "mode",
      mode: "Auto",
      target_f: 72,
    });
    expect(irrelevantHvacField.isError).toBe(true);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);

    const irrelevantTvField = yield* call("watchman_tv_control", {
      operation: "dashboard",
      screen: "d",
      url: "https://example.com",
    });
    expect(irrelevantTvField.isError).toBe(true);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);

    const hold = yield* call("watchman_water_control", { operation: "hold" });
    expect(hold.isError).toBe(false);
    expect(calls.find(({ path }) => path === "/api/services/script/turn_on")).toMatchObject({
      payload: { entity_id: "script.well_solar_manual_hold" },
    });
    expect(hold.structuredContent).toMatchObject({
      accepted: true,
      applied: "verified",
    });

    const postsBeforeTvA = calls.filter(({ method }) => method === "POST").length;
    const tvA = yield* call("watchman_tv_control", {
      operation: "open_url",
      screen: "a",
      url: "https://example.com/video",
    });
    expect(tvA.isError).toBe(true);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(postsBeforeTvA);

    const tvUrl = yield* call("watchman_tv_control", {
      operation: "open_url",
      screen: "d",
      url: "https://example.com/video",
    });
    expect(tvUrl.isError).toBe(false);
    expect(tvUrl.structuredContent).toMatchObject({
      accepted: true,
      applied: "pending",
    });

    const tvPower = yield* call("watchman_tv_control", {
      operation: "power",
      screen: "d",
      power: "on",
    });
    expect(tvPower.isError).toBe(false);
    expect(calls.find(({ path }) => path === "/api/services/remote/turn_on")).toMatchObject({
      payload: { entity_id: ["remote.tv_d_streamer"] },
    });
    expect(tvPower.structuredContent).toMatchObject({
      accepted: true,
      applied: "pending",
    });

    const pairs = yield* call("watchman_hvac_control", {
      operation: "pairs",
      heads: [7],
      action: "only",
    });
    expect(pairs.isError).toBe(false);
    expect(
      calls.find(
        ({ path, payload }) =>
          path === "/api/services/input_select/select_option" &&
          (payload as { option?: string }).option === "D",
      ),
    ).toBeDefined();
    expect(pairs.structuredContent).toMatchObject({
      requested: { requested_pairs: "D" },
      applied: "verified",
    });

    const pairsWithTarget = yield* call("watchman_hvac_control", {
      operation: "pairs",
      heads: [7, 8],
      action: "only",
      target_f: 72,
    });
    expect(pairsWithTarget.isError).toBe(false);
    expect(pairsWithTarget.structuredContent).toMatchObject({
      requested: { requested_pairs: "D", target_f: 72 },
      applied: "pending",
    });

    const invalidPartyEnd = yield* call("watchman_hvac_control", {
      operation: "party",
      action: "end",
      minutes: 60,
    });
    expect(invalidPartyEnd.isError).toBe(true);

    const postsBeforePower = calls.filter(({ method }) => method === "POST").length;
    const power = yield* call("watchman_power_control", {});
    expect(power.isError).toBe(false);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(postsBeforePower);
    expect(power.structuredContent).toMatchObject({ available_mutations: [] });
  }).pipe(Effect.provide(TestLayer));
});

it.effect("rejects Watchman tools for a preview-only credential", () => {
  const PreviewOnlyLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      rest: () => Effect.die("must not call Home Assistant"),
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(PreviewOnlyLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  const previewOnly = {
    ...invocation,
    capabilities: new Set(["preview"] as const),
  };
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "watchman_status", arguments: { area: "site" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, previewOnly),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(TestLayer));
});

it.effect("serializes Watchman mutations across concurrent tool calls", () => {
  let activePosts = 0;
  let maxActivePosts = 0;
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      rest: (method) =>
        method === "GET"
          ? freshStates([
              state("input_number.well_user_max_hz", "110"),
              state("sensor.watchman_drive_snapshot", "True", {
                mode: "poller-v3",
                ctrl_requested_mode: "hold",
                ctrl_applied_mode: "hold",
                ctrl_ack: true,
                ctrl_error: null,
                ctrl_held: true,
                ctrl_command_age_s: 1,
              }),
            ])
          : Effect.gen(function* () {
              activePosts += 1;
              maxActivePosts = Math.max(maxActivePosts, activePosts);
              yield* Effect.yieldNow;
              return [];
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  activePosts -= 1;
                }),
              ),
            ),
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (arguments_: Record<string, unknown>) =>
      server
        .callTool({ name: "watchman_water_control", arguments: arguments_ })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const results = yield* Effect.all(
      [call({ operation: "set_speed_cap", max_hz: 110 }), call({ operation: "hold" })],
      { concurrency: "unbounded" },
    );
    expect(results.every((result) => result.isError === false)).toBe(true);
    expect(maxActivePosts).toBe(1);
  }).pipe(Effect.provide(TestLayer));
});
