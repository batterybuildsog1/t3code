import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WatchmanToolkitHandlersLive } from "./handlers.ts";
import * as TvdSpool from "./TvdSpool.ts";
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
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

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

const TestCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const tvdNotFound = (operation: string) =>
  new TvdSpool.TvdSpoolError({
    operation,
    reason: "not_found",
    message: `${operation} not found`,
  });

const makeTvdLayer = (overrides: Partial<TvdSpool.TvdSpool["Service"]> = {}) =>
  Layer.succeed(
    TvdSpool.TvdSpool,
    TvdSpool.TvdSpool.of({
      fileRequest: () => Effect.void,
      readReceipt: () =>
        Effect.succeed({
          requested: { request_id: "daemon-request" },
          accepted: "accepted",
          applied: "verified",
          observed: { screens: { d: { state: "claimed" } } },
          evidence: "daemon witness postcondition satisfied",
        }),
      readHealth: () =>
        DateTime.now.pipe(
          Effect.map((now) => ({
            t: DateTime.toEpochMillis(now) / 1000,
            ok: true,
            mode: "active" as const,
            seq: 42,
          })),
        ),
      readSnapshot: () =>
        DateTime.now.pipe(
          Effect.map((now) => {
            const nowSeconds = DateTime.toEpochMillis(now) / 1000;
            return {
              t: nowSeconds - 12,
              shed_active: true,
              screens: {
                a: {
                  state: "pinned",
                  foreground_pkg: "de.ozerov.fully",
                  playing_pkg: null,
                  claim: null,
                  overlay: { name: null },
                },
                b: {
                  state: "idle",
                  foreground_pkg: "de.ozerov.fully",
                  playing_pkg: null,
                  claim: null,
                  overlay: { name: null },
                },
                c: {
                  state: "witness_unknown",
                  foreground_pkg: null,
                  playing_pkg: null,
                  claim: null,
                  overlay: { name: "unreachable" },
                },
                d: {
                  state: "claimed",
                  foreground_pkg: "com.amazon.amazonvideo.livingroom",
                  playing_pkg: "com.amazon.amazonvideo.livingroom",
                  claim: {
                    source: "external",
                    expires_at: nowSeconds + 3600,
                  },
                  overlay: { name: null },
                },
              },
            };
          }),
        ),
      receiptPollIntervalMs: 1,
      receiptPollBudgetMs: 5,
      ...overrides,
    }),
  );

const DefaultTvdLayer = makeTvdLayer();

it.effect("keeps the Watchman MCP surface closed and controller-owned", () => {
  const calls: Array<{
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly payload?: unknown;
  }> = [];
  const oversizedTvMetadata = "x".repeat(50_000);
  const oversizedHvacMetadata = "y".repeat(50_000);
  const states = [
    state("sensor.parallel_group_a_battery_state_of_charge", "69.0", {
      unit_of_measurement: "%",
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.parallel_group_a_battery_power", "-5312.0", {
      unit_of_measurement: "W",
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.parallel_group_a_pv_total_power", "215.0", {
      unit_of_measurement: "W",
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.parallel_group_a_consumption_power", "5527.0", {
      unit_of_measurement: "W",
      arbitrary: oversizedHvacMetadata,
    }),
    state("binary_sensor.generator_running", "on", {
      evidence: "inferred_not_measured",
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.hvac_reserve_target", "59.1", {
      valid: true,
      reason: "weather reserve model",
      arbitrary: oversizedHvacMetadata,
    }),
    state("binary_sensor.well_pump_running", "off", {
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.well_pressure", "6.0", {
      calibration: "CAL-20260709a",
      source: "ID59",
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.well_flow_estimate", "0", {
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.well_rsi_output_frequency", "0.0", {
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.well_start_forecast", "11:45", {
      start_local: "11:45",
      spoken: "eleven forty five",
      confidence: "uncertain",
      reason: "heavy cloud could push it later",
      phase: "FAULT",
      arbitrary: oversizedHvacMetadata,
    }),
    state("weather.centennial", "cloudy", {
      temperature: 21,
      apparent_temperature: 20,
      humidity: 45,
      pressure: 1012,
      wind_speed: 14,
      wind_bearing: 220,
      temperature_unit: "°C",
      pressure_unit: "hPa",
      wind_speed_unit: "km/h",
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.watchman_site_event", "event-1", {
      occurred_at: "2026-07-28T22:23:42Z",
      system: "well",
      severity: "info",
      lifecycle: "resolved",
      headline: "Well pump off",
      reason: "target reached",
      impact: "none",
      risk: "normal",
      next_action: "",
      actor: "well_monitor",
      evidence: "telemetry",
      arbitrary: oversizedHvacMetadata,
    }),
    state("input_select.hvac_mode", "Off"),
    state("input_datetime.hvac_party_until", "2026-07-28 16:45:08"),
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
      pressure_cap_hz: 108,
      user_cap_hz: 110,
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.well_solar_controller", "HOLD", {
      requested_mode: "hold",
      reason: "operator_hold",
      armed: true,
      operator_mode: "automatic",
      fail_count: 0,
      safety_latch: null,
      arbitrary: oversizedHvacMetadata,
    }),
    state("sensor.watchman_hvac_controller", "ready", {
      mode: "shadow",
      actuation_compiled_in: false,
      profile: "off",
      computed_pair_mask: "0b0000",
      effective_pair_mask: "0b0000",
      effective_pair_count: 0,
      hall_effective: true,
      setpoint_f: 74,
      fan_mode: "medium",
      last_full_snapshot: "2026-07-28T23:37:17.008873+00:00",
      reason_chain: ["request:off"],
      pair_states: { A: "off", B: "off", C: "off", D: "full_on" },
      heads: Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          index + 1,
          { state: "off", debug: oversizedHvacMetadata },
        ]),
      ),
      ha_cache: { debug: oversizedHvacMetadata },
      arbitrary: oversizedHvacMetadata,
    }),
    ...["a", "b", "c", "d"].flatMap((screen) => [
      state(`media_player.tv_${screen}_streamer`, "on", {
        app_id: "de.ozerov.fully",
        app_name: oversizedTvMetadata,
        source: oversizedTvMetadata,
        supported_features: oversizedTvMetadata,
        arbitrary: oversizedTvMetadata,
      }),
      state(`media_player.tv_${screen}_panel`, "on", {
        source: "HDMI",
        source_list: Array.from({ length: 1_000 }, () => oversizedTvMetadata),
        arbitrary: oversizedTvMetadata,
      }),
      state(`remote.tv_${screen}_streamer`, "on"),
      state(
        `sensor.rec_${screen}_current_page`,
        screen === "d"
          ? "https://example.com/video"
          : `https://watchman.sunhomes.io/display.html?screen=${screen}`,
      ),
      state(`sensor.rec_${screen}_foreground_app`, "de.ozerov.fully"),
      state(`switch.rec_${screen}_screen`, "on"),
    ]),
    ...["a", "b", "c", "d"].map((pair) => state(`binary_sensor.hvac_pair_${pair}_active`, "off")),
  ];
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: (method, path, payload) => {
        calls.push({ method, path, ...(payload === undefined ? {} : { payload }) });
        return method === "GET" ? freshStates(states) : Effect.succeed([]);
      },
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(DefaultTvdLayer),
    Layer.provide(TestCryptoLayer),
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
        "watchman_status",
        "watchman_tv_control",
        "watchman_water_control",
      ].sort(),
    );
    for (const { tool } of server.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }

    const status = yield* call("watchman_status", { area: "water" });
    expect(status.isError).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/states" });
    expect(status.structuredContent).toMatchObject({
      observed: {
        pump_running: { state: "off" },
        pressure_psi: {
          state: "6.0",
          attributes: { calibration: "CAL-20260709a", source: "ID59" },
        },
        drive_control: {
          attributes: {
            ctrl_requested_mode: "hold",
            ctrl_applied_mode: "hold",
            ctrl_ack: true,
            ctrl_error: null,
            pressure_cap_hz: 108,
            user_cap_hz: 110,
          },
        },
        expected_start: {
          state: "11:45",
          attributes: {
            confidence: "uncertain",
            reason: "heavy cloud could push it later",
          },
        },
      },
    });
    const encodedWaterStatus = yield* encodeJson(status.structuredContent);
    expect(encodedWaterStatus.length).toBeLessThan(2_000);
    expect(encodedWaterStatus).not.toContain("arbitrary");
    expect(encodedWaterStatus).not.toContain(oversizedHvacMetadata.slice(0, 100));

    const powerStatus = yield* call("watchman_status", { area: "power" });
    expect(powerStatus.isError).toBe(false);
    expect(powerStatus.structuredContent).toMatchObject({
      observed: {
        control: {
          available_mutations: [],
          generator: "manual_until_two_wire_control_and_run_readback_exist",
        },
        battery_soc_pct: { state: "69.0" },
        generator_running: { state: "on", evidence: "inferred_not_measured" },
        reserve_model: {
          state: "59.1",
          attributes: { valid: true, reason: "weather reserve model" },
        },
      },
    });
    const encodedPowerStatus = yield* encodeJson(powerStatus.structuredContent);
    expect(encodedPowerStatus.length).toBeLessThan(1_200);
    expect(encodedPowerStatus).not.toContain("arbitrary");

    const siteStatus = yield* call("watchman_status", { area: "site" });
    expect(siteStatus.isError).toBe(false);
    expect(siteStatus.structuredContent).toMatchObject({
      observed: {
        power: { battery_soc_pct: { state: "69.0" } },
        water: { pump_running: { state: "off" } },
        hvac: { mode: { state: "Off" } },
        operations: {
          last_site_event: {
            state: "event-1",
            attributes: { headline: "Well pump off" },
          },
          party: { active: false },
        },
      },
    });
    const siteContent = siteStatus.structuredContent as {
      readonly observed: {
        readonly power: Record<string, unknown>;
        readonly water: Record<string, unknown>;
        readonly hvac: Record<string, unknown>;
        readonly operations: {
          readonly last_site_event: { readonly attributes: Record<string, unknown> };
        };
      };
    };
    expect(siteContent.observed.power).not.toHaveProperty("control");
    expect(siteContent.observed.water).not.toHaveProperty("drive_control");
    expect(siteContent.observed.hvac).not.toHaveProperty("direct_controller");
    expect(siteContent.observed.operations.last_site_event.attributes).not.toHaveProperty("reason");
    expect(siteContent.observed.operations.last_site_event.attributes).not.toHaveProperty("impact");
    const encodedSiteStatus = yield* encodeJson(siteStatus.structuredContent);
    expect(encodedSiteStatus.length).toBeLessThan(2_400);
    expect(encodedSiteStatus).not.toContain("arbitrary");

    const automation = yield* call("watchman_automation", {});
    expect(automation.isError).toBe(false);
    expect(automation.structuredContent).toMatchObject({
      installed: {
        hvac_mode: { state: "Off" },
        party: { active: false },
      },
      mutable_jobs: [],
    });
    expect(automation.structuredContent).not.toHaveProperty("installed.party_until");
    expect(automation.structuredContent).not.toHaveProperty("installed.party.until");
    const encodedAutomation = yield* encodeJson(automation.structuredContent);
    expect(encodedAutomation.length).toBeLessThan(1_600);
    expect(encodedAutomation).not.toContain("arbitrary");

    const hvacMode = states.find(({ entity_id }) => entity_id === "input_select.hvac_mode")!;
    const partyUntil = states.find(
      ({ entity_id }) => entity_id === "input_datetime.hvac_party_until",
    )!;
    hvacMode.state = "Party";
    partyUntil.state = "2026-07-29 02:00:00";
    const activeParty = yield* call("watchman_automation", {});
    expect(activeParty.structuredContent).toMatchObject({
      installed: {
        party: {
          active: true,
          until: { state: "2026-07-29 02:00:00" },
        },
      },
    });
    hvacMode.state = "unavailable";
    const unavailableParty = yield* call("watchman_automation", {});
    expect(unavailableParty.structuredContent).toMatchObject({
      installed: {
        party: {
          active: "unknown",
          reason: "hvac_mode_unavailable",
        },
      },
    });
    expect(unavailableParty.structuredContent).not.toHaveProperty("installed.party.until");
    hvacMode.state = "Off";

    const weatherStatus = yield* call("watchman_status", { area: "weather" });
    expect(weatherStatus.isError).toBe(false);
    expect(weatherStatus.structuredContent).toMatchObject({
      observed: {
        weather: {
          state: "cloudy",
          attributes: {
            temperature: 21,
            pressure: 1012,
            wind_speed: 14,
            temperature_unit: "°C",
            pressure_unit: "hPa",
            wind_speed_unit: "km/h",
          },
        },
      },
    });

    const tvStatus = yield* call("watchman_status", { area: "tv" });
    expect(tvStatus.isError).toBe(false);
    expect(tvStatus.structuredContent).toMatchObject({
      source: "tvd tv_latest.json",
      observed: {
        screen_d: {
          state: "claimed",
          foreground: "com.amazon.amazonvideo.livingroom",
          playing: "com.amazon.amazonvideo.livingroom",
          claim: { source: "external" },
          overlay: null,
        },
        screen_c: { state: "witness_unknown", overlay: "unreachable" },
        shed_active: true,
        snapshot_age_s: 12,
      },
    });
    const encodedTvStatus = yield* encodeJson(tvStatus.structuredContent);
    expect(encodedTvStatus.length).toBeLessThan(1_500);
    expect(encodedTvStatus).not.toContain("media_sessions");
    expect(encodedTvStatus).not.toContain("field_validity");

    const hvacStatus = yield* call("watchman_status", { area: "hvac" });
    expect(hvacStatus.isError).toBe(false);
    expect(hvacStatus.structuredContent).toMatchObject({
      observed: {
        direct_controller: {
          state: "ready",
          attributes: {
            mode: "shadow",
            actuation_compiled_in: false,
            profile: "off",
            computed_pair_mask: "0b0000",
            effective_pair_mask: "0b0000",
            effective_pair_count: 0,
            setpoint_f: 74,
            fan_mode: "medium",
            last_full_snapshot: "2026-07-28T23:37:17.008873+00:00",
            pair_states: { A: "off", B: "off", C: "off", D: "full_on" },
          },
        },
      },
    });
    const encodedHvacStatus = yield* encodeJson(hvacStatus.structuredContent);
    expect(encodedHvacStatus.length).toBeLessThan(6_000);
    const hvacContent = hvacStatus.structuredContent as {
      readonly observed: {
        readonly direct_controller: { readonly attributes: Record<string, unknown> };
      };
    };
    expect(hvacContent.observed.direct_controller.attributes).not.toHaveProperty("heads");
    expect(hvacContent.observed.direct_controller.attributes).not.toHaveProperty("ha_cache");
    expect(hvacContent.observed.direct_controller.attributes).not.toHaveProperty("arbitrary");

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
      operation: "show",
      screen: "d",
      view: "wall.dashboard",
      app: "netflix",
    });
    expect(irrelevantTvField.isError).toBe(true);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);

    const verifiedSafetyClampedSpeed = yield* call("watchman_water_control", {
      operation: "set_speed_cap",
      max_hz: 110,
    });
    expect(verifiedSafetyClampedSpeed.isError).toBe(false);
    expect(verifiedSafetyClampedSpeed.structuredContent).toMatchObject({
      accepted: true,
      applied: "verified",
      safety: {
        observed_user_cap_hz: 110,
        actual_id102_cap_hz: 108,
      },
    });

    const pendingUnconfirmedSpeed = yield* call("watchman_water_control", {
      operation: "set_speed_cap",
      max_hz: 109,
    });
    expect(pendingUnconfirmedSpeed.isError).toBe(false);
    expect(pendingUnconfirmedSpeed.structuredContent).toMatchObject({
      accepted: true,
      applied: "pending",
      safety: {
        observed_user_cap_hz: 110,
        actual_id102_cap_hz: 108,
      },
    });

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
      operation: "show",
      screen: "a",
      view: "wall.dashboard",
    });
    expect(tvA.isError).toBe(true);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(postsBeforeTvA);

    const tvDashboard = yield* call("watchman_tv_control", {
      operation: "show",
      screen: "d",
      view: "wall.dashboard",
    });
    expect(tvDashboard.isError).toBe(false);
    expect(tvDashboard.structuredContent).toMatchObject({
      accepted: "accepted",
      applied: "verified",
    });

    for (const unsupported of [
      {
        operation: "play",
        screen: "d",
        app: "youtube",
        title_query: "Bluey",
      },
      {
        operation: "show",
        screen: "d",
        url: "https://example.com/video",
      },
      {
        operation: "transport",
        screen: "d",
        action: "seek",
        seek_s: 30,
      },
      {
        operation: "volume",
        screen: "d",
        muted: false,
      },
      {
        operation: "navigate",
        screen: "d",
        moves: ["select"],
      },
      {
        operation: "input_text",
        screen: "d",
        text: "provider secret",
      },
    ]) {
      const result = yield* call("watchman_tv_control", unsupported);
      expect(result.isError).toBe(true);
    }

    const tvPower = yield* call("watchman_tv_control", {
      operation: "power",
      screen: "d",
      power: "on",
    });
    expect(tvPower.isError).toBe(false);
    expect(tvPower.structuredContent).toMatchObject({
      accepted: "accepted",
      applied: "verified",
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
  }).pipe(Effect.provide(TestLayer));
});

it.effect("keeps unproven speed-cap receipts pending", () => {
  type ReceiptCase = {
    readonly name: string;
    readonly driveState: string;
    readonly attributes: Record<string, unknown>;
    readonly ageSeconds: number;
  };
  let receiptCase: ReceiptCase = {
    name: "stale",
    driveState: "True",
    attributes: { mode: "poller-v3", pressure_cap_hz: 110, user_cap_hz: 110 },
    ageSeconds: 31,
  };
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: (method) =>
        method === "POST"
          ? Effect.succeed([])
          : DateTime.now.pipe(
              Effect.map((now) => {
                const observedAt = DateTime.formatIso(
                  DateTime.add(now, { seconds: -receiptCase.ageSeconds }),
                );
                return [
                  {
                    ...state(
                      "sensor.watchman_drive_snapshot",
                      receiptCase.driveState,
                      receiptCase.attributes,
                    ),
                    last_changed: observedAt,
                    last_updated: observedAt,
                  },
                ];
              }),
            ),
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(DefaultTvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  const cases: ReadonlyArray<ReceiptCase> = [
    receiptCase,
    {
      name: "missing physical cap",
      driveState: "True",
      attributes: { mode: "poller-v3", user_cap_hz: 110 },
      ageSeconds: 0,
    },
    {
      name: "null physical cap",
      driveState: "True",
      attributes: { mode: "poller-v3", pressure_cap_hz: null, user_cap_hz: 110 },
      ageSeconds: 0,
    },
    {
      name: "non-numeric physical cap",
      driveState: "True",
      attributes: { mode: "poller-v3", pressure_cap_hz: "110", user_cap_hz: 110 },
      ageSeconds: 0,
    },
    {
      name: "cap above requested ceiling",
      driveState: "True",
      attributes: { mode: "poller-v3", pressure_cap_hz: 110.01, user_cap_hz: 110 },
      ageSeconds: 0,
    },
    {
      name: "cap below safety floor",
      driveState: "True",
      attributes: { mode: "poller-v3", pressure_cap_hz: 101.99, user_cap_hz: 110 },
      ageSeconds: 0,
    },
    {
      name: "near but unmatched user ceiling",
      driveState: "True",
      attributes: { mode: "poller-v3", pressure_cap_hz: 109.99, user_cap_hz: 109.99 },
      ageSeconds: 0,
    },
    {
      name: "offline poller",
      driveState: "False",
      attributes: { mode: "poller-v3", pressure_cap_hz: 110, user_cap_hz: 110 },
      ageSeconds: 0,
    },
  ];

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const testCase of cases) {
      receiptCase = testCase;
      const result = yield* server
        .callTool({
          name: "watchman_water_control",
          arguments: { operation: "set_speed_cap", max_hz: 110 },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError, testCase.name).toBe(false);
      expect(result.structuredContent, testCase.name).toMatchObject({
        accepted: true,
        applied: "pending",
      });
    }
  }).pipe(Effect.provide(TestLayer));
});

it.effect("bounds Recorder history instead of returning raw state arrays", () => {
  const oversized = "z".repeat(50_000);
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: () =>
        Effect.succeed([
          Array.from({ length: 240 }, (_, index) => ({
            entity_id: "sensor.well_rsi_output_frequency",
            state: String(index % 120),
            attributes: { arbitrary: oversized },
            last_changed: "2026-07-28T12:00:00.000Z",
            last_updated: "2026-07-28T12:00:00.000Z",
          })),
        ]),
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(DefaultTvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "watchman_history",
        arguments: { metric: "well_frequency", days: 1 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      source: "Home Assistant Recorder",
      metric: "well_frequency",
      requested_days: 1,
      summary: {
        unit: "Hz",
        point_count: 240,
        numeric_point_count: 240,
        min: 0,
        max: 119,
        first_numeric: { value: 0, at: "2026-07-28T12:00:00.000Z" },
        latest_numeric: { value: 119, at: "2026-07-28T12:00:00.000Z" },
        latest_observation: { state: "119", at: "2026-07-28T12:00:00.000Z" },
      },
    });
    expect(result.structuredContent).not.toHaveProperty("data");
    const encoded = yield* encodeJson(result.structuredContent);
    expect(encoded.length).toBeLessThan(800);
    expect(encoded).not.toContain("arbitrary");
    expect(encoded).not.toContain(oversized.slice(0, 100));
  }).pipe(Effect.provide(TestLayer));
});

it.effect("hard-bounds operations and HVAC Recorder projections", () => {
  const oversized = "z".repeat(50_000);
  const operationPoints = Array.from({ length: 100 }, (_, index) => ({
    entity_id: "sensor.watchman_site_event",
    state: `event-${index}-${oversized}`,
    attributes: {
      occurred_at: oversized,
      system: oversized,
      severity: oversized,
      lifecycle: oversized,
      headline: oversized,
      reason: oversized,
      impact: oversized,
      risk: oversized,
      next_action: oversized,
      actor: oversized,
      evidence: oversized,
      arbitrary: oversized,
    },
    last_changed: `2026-07-28T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
  }));
  const hvacPoints = Array.from({ length: 100 }, (_, index) => ({
    entity_id: "input_select.hvac_mode",
    state: `${index}-${oversized}`,
    last_changed: `2026-07-28T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
  }));
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: (_method, path) =>
        Effect.succeed([path.includes("watchman_site_event") ? operationPoints : hvacPoints]),
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(DefaultTvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const callHistory = (metric: "operations" | "hvac_mode") =>
      server
        .callTool({
          name: "watchman_history",
          arguments: { metric, days: 1 },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const operations = yield* callHistory("operations");
    expect(operations.isError).toBe(false);
    expect(operations.structuredContent).toMatchObject({
      summary: {
        point_count: 100,
        recent_events: [
          { state: `event-98-${"z".repeat(55)}` },
          { state: `event-99-${"z".repeat(55)}` },
        ],
      },
    });
    const encodedOperations = yield* encodeJson(operations.structuredContent);
    expect(encodedOperations.length).toBeLessThan(2_000);
    expect(encodedOperations).not.toContain("arbitrary");

    const hvac = yield* callHistory("hvac_mode");
    expect(hvac.isError).toBe(false);
    expect(hvac.structuredContent).toMatchObject({
      summary: {
        point_count: 100,
        recent_transitions: Array.from({ length: 8 }, (_, offset) => {
          const index = 92 + offset;
          return {
            state: `${index}-${"z".repeat(37)}`,
            at: `2026-07-28T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
          };
        }),
      },
    });
    const encodedHvac = yield* encodeJson(hvac.structuredContent);
    expect(encodedHvac.length).toBeLessThan(1_200);
  }).pipe(Effect.provide(TestLayer));
});

it.effect("summarizes Recorder series larger than argument-spread limits", () => {
  const pointCount = 130_000;
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: () =>
        Effect.succeed([
          Array.from({ length: pointCount }, (_, index) => ({
            entity_id: "sensor.well_rsi_output_frequency",
            state: String(index % 120),
            last_changed: "2026-07-28T12:00:00.000Z",
          })),
        ]),
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(DefaultTvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "watchman_history",
        arguments: { metric: "well_frequency", days: 30 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      summary: {
        point_count: pointCount,
        numeric_point_count: pointCount,
        min: 0,
        max: 119,
      },
    });
    const encoded = yield* encodeJson(result.structuredContent);
    expect(encoded.length).toBeLessThan(800);
  }).pipe(Effect.provide(TestLayer));
});

it.effect("returns only the fresh controller-produced well summary", () => {
  let mode: "valid" | "missing" | "invalid" | "stale" | "future" | "previous_day" | "negative" =
    "valid";
  let reads = 0;
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      rest: () => Effect.die("well_runs must not query Recorder"),
      readWellRunHistory: () => {
        reads += 1;
        if (mode === "missing") {
          return new WatchmanHaCli.WatchmanHaCliError({
            operation: "read well run history",
            message: "runhistory.json is missing",
          });
        }
        if (mode === "invalid") return Effect.succeed({ generated: "not enough fields" });
        return DateTime.now.pipe(
          Effect.map((now) => ({
            generated: DateTime.formatIso(
              DateTime.add(now, {
                seconds:
                  mode === "stale"
                    ? -16 * 60
                    : mode === "future"
                      ? 60
                      : mode === "previous_day"
                        ? -10 * 60
                        : -1,
              }),
            ),
            drives: {
              well: {
                running_now: true,
                today: {
                  runtime_min: mode === "negative" ? -1 : 239.7,
                  runs: 4,
                  brief_cycles: 1,
                  kwh: 123.45,
                },
                runs_24h: Array.from({ length: 100 }, () => ({
                  large: "field omitted from tool result",
                })),
              },
            },
          })),
        );
      },
    }),
  );
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(DefaultTvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-29T06:05:00.000Z")),
    );
    const server = yield* McpServer.McpServer;
    const call = (arguments_: Record<string, unknown>) =>
      server
        .callTool({ name: "watchman_history", arguments: arguments_ })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const expectedLocalDate = DateTime.formatIsoDate(
      DateTime.setZoneNamedUnsafe(yield* DateTime.now, "America/Denver"),
    );
    const valid = yield* call({ metric: "well_runs", days: 1 });
    expect(valid.isError).toBe(false);
    expect(valid.structuredContent).toMatchObject({
      source: "Watchman controller-derived run history",
      timezone: "America/Denver",
      local_date: expectedLocalDate,
      summary: {
        ran: true,
        runtime_minutes: 239.7,
        run_count: 4,
        brief_cycles: 1,
        currently_running: true,
      },
    });
    expect(valid.structuredContent).not.toHaveProperty("runs_24h");
    expect(valid.structuredContent).not.toHaveProperty("data");

    const readsBeforeInvalidDays = reads;
    expect((yield* call({ metric: "well_runs", days: 2 })).isError).toBe(true);
    expect(reads).toBe(readsBeforeInvalidDays);

    mode = "missing";
    expect((yield* call({ metric: "well_runs" })).isError).toBe(true);
    mode = "invalid";
    expect((yield* call({ metric: "well_runs" })).isError).toBe(true);
    mode = "stale";
    expect((yield* call({ metric: "well_runs" })).isError).toBe(true);
    mode = "future";
    expect((yield* call({ metric: "well_runs" })).isError).toBe(true);
    mode = "previous_day";
    expect((yield* call({ metric: "well_runs" })).isError).toBe(true);
    mode = "negative";
    expect((yield* call({ metric: "well_runs" })).isError).toBe(true);
  }).pipe(Effect.provide(TestLayer));
});

it.effect("rejects Watchman tools for a preview-only credential", () => {
  let files = 0;
  const PreviewOnlyLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("must not read well history"),
      rest: () => Effect.die("must not call Home Assistant"),
    }),
  );
  const CapabilityTvdLayer = makeTvdLayer({
    fileRequest: () =>
      Effect.sync(() => {
        files += 1;
      }),
  });
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(PreviewOnlyLayer),
    Layer.provide(CapabilityTvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  const previewOnly = {
    ...invocation,
    capabilities: new Set(["preview"] as const),
  };
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "watchman_tv_control",
        arguments: { operation: "power", screen: "d", power: "on" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, previewOnly),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(files).toBe(0);
  }).pipe(Effect.provide(TestLayer));
});

it.effect("files exact tvd requests and passes daemon receipts through unchanged", () => {
  const filed: Array<TvdSpool.TvdRequest> = [];
  let receiptMode: "third_poll" | "observe_only" = "third_poll";
  let receiptPolls = 0;
  let expectedReceipt: TvdSpool.TvdReceipt | undefined;
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: () => Effect.die("TV control must not call Home Assistant"),
    }),
  );
  const TvdLayer = makeTvdLayer({
    fileRequest: (request) =>
      Effect.sync(() => {
        filed.push(request);
      }),
    readReceipt: (id) => {
      receiptPolls += 1;
      if (receiptMode === "third_poll" && receiptPolls < 3) {
        return tvdNotFound("read TV receipt");
      }
      expectedReceipt =
        receiptMode === "observe_only"
          ? {
              requested: { request_id: id, intent: "power", screen: "d" },
              accepted: "rejected(observe_only)",
              applied: "failed",
              observed: { screens: { d: { wakefulness: { value: "Awake" } } } },
              evidence: "valid request; observe-only mode performed no TV write",
            }
          : {
              requested: { request_id: id, intent: "hold", screen: "d" },
              accepted: "accepted",
              applied: "verified",
              observed: { screens: { d: { state: "claimed", overlay: null } } },
              evidence: "hold state was journaled and witnessed",
            };
      return Effect.succeed(expectedReceipt);
    },
    receiptPollIntervalMs: 1,
    receiptPollBudgetMs: 10,
  });
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(TvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    yield* TestClock.setTime(1_000_000_000);
    const server = yield* McpServer.McpServer;
    const call = (arguments_: Record<string, unknown>) =>
      server
        .callTool({ name: "watchman_tv_control", arguments: arguments_ })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const holdFiber = yield* Effect.forkChild(
      call({
        operation: "hold",
        screen: "d",
        expires_at: 1_003_600,
      }),
    );
    yield* TestClock.adjust("2 millis");
    const hold = yield* Fiber.join(holdFiber);
    expect(hold.isError).toBe(false);
    expect(hold.structuredContent).toEqual(expectedReceipt);
    expect(receiptPolls).toBe(3);
    expect(filed).toHaveLength(1);
    const request = filed[0]!;
    expect(request.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(request.request_id).toBe(request.request_id.toLowerCase());
    expect(typeof request.issued_at).toBe("number");
    const filedBytes = yield* encodeJson(request);
    expect(filedBytes).toBe(
      `{"schema":1,"request_id":"${request.request_id}","source":"t3","screen":"d","intent":"hold","payload":{"expires_at":1003600},"lease":{"class":"hold","expires_at":1003600},"issued_at":1000000,"ttl_s":120}`,
    );

    receiptMode = "observe_only";
    receiptPolls = 0;
    const observeOnly = yield* call({
      operation: "power",
      screen: "d",
      power: "on",
    });
    expect(observeOnly.isError).toBe(false);
    expect(observeOnly.structuredContent).toEqual(expectedReceipt);
    expect(observeOnly.structuredContent).toMatchObject({
      accepted: "rejected(observe_only)",
      applied: "failed",
    });
  }).pipe(Effect.provide(TestLayer));
});

it.effect("returns pending after the receipt budget and names the durable receipt path", () => {
  const filed: Array<TvdSpool.TvdRequest> = [];
  let receiptPolls = 0;
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: () => Effect.die("TV control must not call Home Assistant"),
    }),
  );
  const TvdLayer = makeTvdLayer({
    fileRequest: (request) =>
      Effect.sync(() => {
        filed.push(request);
      }),
    readReceipt: () => {
      receiptPolls += 1;
      return tvdNotFound("read TV receipt");
    },
    receiptPollIntervalMs: 1,
    receiptPollBudgetMs: 3,
  });
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(TvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const pendingFiber = yield* Effect.forkChild(
      server
        .callTool({
          name: "watchman_tv_control",
          arguments: { operation: "power", screen: "d", power: "on" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        ),
    );
    yield* TestClock.adjust("3 millis");
    const pending = yield* Fiber.join(pendingFiber);
    expect(pending.isError).toBe(false);
    expect(filed).toHaveLength(1);
    expect(receiptPolls).toBe(4);
    const requestId = filed[0]!.request_id;
    expect(pending.structuredContent).toMatchObject({
      requested: { request_id: requestId },
      accepted: "filed",
      applied: "pending",
      observed: { request_id: requestId },
    });
    expect(pending.structuredContent?.evidence).toContain(`request_id ${requestId}`);
    expect(pending.structuredContent?.evidence).toContain(`tv_receipts/${requestId}.json`);
  }).pipe(Effect.provide(TestLayer));
});

it.effect("fails closed before filing and surfaces exclusive-create collisions", () => {
  let mode: "normal" | "stale" | "collision" = "normal";
  const filed: Array<TvdSpool.TvdRequest> = [];
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
      rest: () => Effect.die("TV control must not call Home Assistant"),
    }),
  );
  const TvdLayer = makeTvdLayer({
    readHealth: () =>
      DateTime.now.pipe(
        Effect.map((now) => ({
          t: DateTime.toEpochMillis(now) / 1000 - (mode === "stale" ? 181 : 0),
          ok: true,
          mode: "active" as const,
          seq: 7,
        })),
      ),
    fileRequest: (request) => {
      if (mode === "collision") {
        return new TvdSpool.TvdSpoolError({
          operation: "file TV request",
          reason: "collision",
          message: "AlreadyExists: exclusive request path",
        });
      }
      return Effect.sync(() => {
        filed.push(request);
      });
    },
  });
  const TestLayer = McpServer.toolkit(WatchmanToolkit).pipe(
    Layer.provide(WatchmanToolkitHandlersLive),
    Layer.provide(CliLayer),
    Layer.provide(TvdLayer),
    Layer.provide(TestCryptoLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (arguments_: Record<string, unknown>) =>
      server
        .callTool({ name: "watchman_tv_control", arguments: arguments_ })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const tvAPowerOff = yield* call({
      operation: "power",
      screen: "a",
      power: "off",
    });
    expect(tvAPowerOff.isError).toBe(true);
    expect(filed).toHaveLength(0);

    const allTransport = yield* call({
      operation: "transport",
      screen: "all",
      action: "pause",
    });
    expect(allTransport.isError).toBe(true);
    expect(filed).toHaveLength(0);

    mode = "stale";
    const stale = yield* call({
      operation: "power",
      screen: "d",
      power: "on",
    });
    expect(stale.isError).toBe(false);
    expect(stale.structuredContent).toMatchObject({
      accepted: "unavailable(tvd_health_stale)",
      applied: "unavailable",
      observed: { health: { age_s: 181 } },
    });
    expect(filed).toHaveLength(0);

    mode = "collision";
    const collision = yield* call({
      operation: "power",
      screen: "d",
      power: "on",
    });
    expect(collision.isError).toBe(true);
    expect(collision.structuredContent).toBeUndefined();
    expect(filed).toHaveLength(0);
  }).pipe(Effect.provide(TestLayer));
});

it.effect("serializes Watchman mutations across concurrent tool calls", () => {
  let activePosts = 0;
  let maxActivePosts = 0;
  const CliLayer = Layer.succeed(
    WatchmanHaCli.WatchmanHaCli,
    WatchmanHaCli.WatchmanHaCli.of({
      readWellRunHistory: () => Effect.die("unused"),
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
    Layer.provide(DefaultTvdLayer),
    Layer.provide(TestCryptoLayer),
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
