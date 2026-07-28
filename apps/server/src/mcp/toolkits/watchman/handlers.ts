import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WatchmanHaCli from "./WatchmanHaCli.ts";
import { WatchmanControlError, WatchmanToolkit } from "./tools.ts";

type WatchmanToolName =
  | "watchman_status"
  | "watchman_history"
  | "watchman_tv_control"
  | "watchman_hvac_control"
  | "watchman_water_control"
  | "watchman_power_control"
  | "watchman_automation";

const HaState = Schema.Struct({
  entity_id: Schema.String,
  state: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  last_changed: Schema.optional(Schema.String),
  last_updated: Schema.optional(Schema.String),
});
type HaState = typeof HaState.Type;
const HaStates = Schema.Array(HaState);
const decodeStates = Schema.decodeUnknownEffect(HaStates);
const WellRunHistory = Schema.Struct({
  generated: Schema.String,
  drives: Schema.Struct({
    well: Schema.Struct({
      running_now: Schema.Boolean,
      today: Schema.Struct({
        runtime_min: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
        runs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        brief_cycles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    }),
  }),
});
const decodeWellRunHistory = Schema.decodeUnknownEffect(WellRunHistory);
const WELL_RUN_HISTORY_MAX_AGE_SECONDS = 15 * 60;
const mutationSemaphore = Effect.runSync(Semaphore.make(1));

const screenLetters = ["a", "b", "c", "d"] as const;
type Screen = (typeof screenLetters)[number];
type AppliedState = "verified" | "pending" | "rejected" | "unavailable";
type ServiceCall = {
  readonly domain: string;
  readonly service: string;
  readonly data: Record<string, unknown>;
};
const dashboardUrls: Record<Screen, string> = {
  a: "https://watchman.sunhomes.io/switchboard.html#tv",
  b: "https://watchman.sunhomes.io/display.html?screens=4&screen=2&deck=wall&interval=15",
  c: "https://watchman.sunhomes.io/display.html?screens=4&screen=3&deck=wall&interval=15",
  d: "https://watchman.sunhomes.io/display.html?screens=4&screen=4&deck=wall&interval=15",
};
const tvApps = {
  prime_video: "com.amazon.amazonvideo.livingroom",
  netflix: "com.netflix.ninja",
  youtube: "com.google.android.youtube.tv",
} as const;
const pairHeads = {
  A: [1, 2],
  B: [3, 4],
  C: [5, 6],
  D: [7, 8],
} as const;
const hallCelsius = new Map([
  [75, 23.9],
  [76, 24.4],
  [77, 25.0],
  [78, 25.6],
  [79, 26.1],
  [80, 26.7],
  [81, 27.2],
  [82, 27.7],
  [83, 28.3],
  [84, 28.9],
  [85, 29.4],
]);

const fail = (tool: WatchmanToolName, reason: WatchmanControlError["reason"], message: string) =>
  new WatchmanControlError({ tool, reason, message });

const irrelevantParameter = (
  tool: WatchmanToolName,
  input: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
) => {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  return unexpected
    ? fail(tool, "controller", `${input.operation} does not accept ${unexpected}.`)
    : undefined;
};

const requireCapability = Effect.fn("WatchmanToolkit.requireCapability")(function* (
  tool: WatchmanToolName,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("watchman-control")) {
    return yield* fail(
      tool,
      "capability",
      "This conversation is not scoped to the canonical Watchman Control environment.",
    );
  }
});

const controller = <A>(
  tool: WatchmanToolName,
  effect: Effect.Effect<A, WatchmanHaCli.WatchmanHaCliError>,
) => effect.pipe(Effect.mapError((cause) => fail(tool, "controller", cause.message)));

const readStates = Effect.fn("WatchmanToolkit.readStates")(function* (tool: WatchmanToolName) {
  const cli = yield* WatchmanHaCli.WatchmanHaCli;
  const raw = yield* controller(tool, cli.rest("GET", "/api/states"));
  const states = yield* decodeStates(raw).pipe(
    Effect.mapError(() =>
      fail(tool, "invalid_response", "Home Assistant returned invalid state data."),
    ),
  );
  return new Map(states.map((state) => [state.entity_id, state]));
});

const callService = Effect.fn("WatchmanToolkit.callService")(function* (
  tool: WatchmanToolName,
  domain: string,
  service: string,
  data: Record<string, unknown>,
) {
  const cli = yield* WatchmanHaCli.WatchmanHaCli;
  yield* controller(tool, cli.rest("POST", `/api/services/${domain}/${service}`, data));
});

const service = (domain: string, name: string, data: Record<string, unknown>): ServiceCall => ({
  domain,
  service: name,
  data,
});

const compactState = (states: ReadonlyMap<string, HaState>, entityId: string) => {
  const entity = states.get(entityId);
  return entity
    ? {
        state: entity.state,
        attributes: entity.attributes,
        last_updated: entity.last_updated,
      }
    : { state: "unavailable", missing: true };
};

const compactTvState = (states: ReadonlyMap<string, HaState>, entityId: string) => {
  const entity = states.get(entityId);
  if (!entity) return { state: "unavailable", missing: true };
  const selectedAttributes: Record<string, string | number | boolean> = {};
  for (const name of ["app_id", "app_name", "source"] as const) {
    const value = entity.attributes[name];
    if (typeof value === "string") selectedAttributes[name] = value.slice(0, 160);
  }
  const volumeLevel = entity.attributes.volume_level;
  if (typeof volumeLevel === "number" && Number.isFinite(volumeLevel)) {
    selectedAttributes.volume_level = volumeLevel;
  }
  const muted = entity.attributes.is_volume_muted;
  if (typeof muted === "boolean") selectedAttributes.is_volume_muted = muted;
  return {
    state: entity.state.slice(0, 120),
    ...(Object.keys(selectedAttributes).length === 0 ? {} : { attributes: selectedAttributes }),
    ...(entity.last_updated === undefined
      ? {}
      : { last_updated: entity.last_updated.slice(0, 64) }),
  };
};

const stateValue = (states: ReadonlyMap<string, HaState>, entityId: string): string =>
  states.get(entityId)?.state ?? "unavailable";

const stateUnavailable = (states: ReadonlyMap<string, HaState>, entityId: string): boolean =>
  !states.has(entityId) || ["unknown", "unavailable"].includes(stateValue(states, entityId));

const attribute = (states: ReadonlyMap<string, HaState>, entityId: string, name: string): unknown =>
  states.get(entityId)?.attributes[name];

const statusForArea = (
  states: ReadonlyMap<string, HaState>,
  area: "power" | "water" | "hvac" | "tv" | "weather" | "operations",
): Record<string, unknown> => {
  if (area === "power") {
    return {
      battery_soc_pct: compactState(states, "sensor.parallel_group_a_battery_state_of_charge"),
      battery_power_w_negative_is_charging: compactState(
        states,
        "sensor.parallel_group_a_battery_power",
      ),
      solar_w: compactState(states, "sensor.parallel_group_a_pv_total_power"),
      site_load_w: compactState(states, "sensor.parallel_group_a_consumption_power"),
      generator_running: {
        ...compactState(states, "binary_sensor.generator_running"),
        evidence: "inferred",
      },
      reserve_model: compactState(states, "sensor.hvac_reserve_target"),
    };
  }
  if (area === "water") {
    return {
      pump_running: compactState(states, "binary_sensor.well_pump_running"),
      pressure_psi: compactState(states, "sensor.well_pressure"),
      flow_gpm: {
        ...compactState(states, "sensor.well_flow_estimate"),
        evidence: "estimated",
      },
      drive_hz: compactState(states, "sensor.well_rsi_output_frequency"),
      user_speed_cap_hz: compactState(states, "input_number.well_user_max_hz"),
      controller: compactState(states, "sensor.well_solar_controller"),
      drive_control: compactState(states, "sensor.watchman_drive_snapshot"),
      expected_start: compactState(states, "sensor.well_start_forecast"),
      tanks: { state: "unavailable", reason: "No installed tank telemetry/control surface." },
      reverse_osmosis: {
        state: "unavailable",
        reason: "No installed RO telemetry/control surface.",
      },
    };
  }
  if (area === "hvac") {
    return {
      mode: compactState(states, "input_select.hvac_mode"),
      target_f: compactState(states, "input_number.hvac_party_setpoint_f"),
      requested_pairs: compactState(states, "input_select.hvac_requested_pairs"),
      guard_cap: compactState(states, "sensor.hvac_guard_cap"),
      controller_reason: compactState(states, "sensor.hvac_controller_reason"),
      direct_controller: compactState(states, "sensor.watchman_hvac_controller"),
      inverter_hall: {
        ...compactState(states, "climate.hvac_inverter_hall"),
        evidence: "cloud_reported",
      },
    };
  }
  if (area === "tv") {
    return Object.fromEntries(
      screenLetters.map((screen) => [
        `screen_${screen}`,
        {
          streamer: compactTvState(states, `media_player.tv_${screen}_streamer`),
          panel: compactTvState(states, `media_player.tv_${screen}_panel`),
          policy: screen === "a" ? "dedicated_solar_dashboard" : "flexible",
        },
      ]),
    );
  }
  if (area === "weather") {
    return {
      weather: compactState(states, "weather.centennial"),
      sun: compactState(states, "sun.sun"),
    };
  }
  return {
    last_site_event: compactState(states, "sensor.watchman_site_event"),
    hvac_mode: compactState(states, "input_select.hvac_mode"),
    party_until: compactState(states, "input_datetime.hvac_party_until"),
    well_mode: compactState(states, "input_select.well_solar_operator_mode"),
    tv_night_shed: compactState(states, "input_boolean.tv_night_shed_active"),
  };
};

const status = Effect.fn("WatchmanToolkit.status")(function* (input: {
  readonly area: "site" | "power" | "water" | "hvac" | "tv" | "weather" | "operations";
}) {
  const tool = "watchman_status";
  yield* requireCapability(tool);
  const states = yield* readStates(tool);
  if (input.area === "site") {
    return {
      source: "Home Assistant live state",
      power: statusForArea(states, "power"),
      water: statusForArea(states, "water"),
      hvac: statusForArea(states, "hvac"),
      operations: statusForArea(states, "operations"),
    };
  }
  return {
    source: "Home Assistant live state",
    area: input.area,
    observed: statusForArea(states, input.area),
  };
});

const historyEntities = {
  operations: "sensor.watchman_site_event",
  battery_soc: "sensor.parallel_group_a_battery_state_of_charge",
  solar_power: "sensor.parallel_group_a_pv_total_power",
  site_load: "sensor.parallel_group_a_consumption_power",
  well_pressure: "sensor.well_pressure",
  well_frequency: "sensor.well_rsi_output_frequency",
  hvac_mode: "input_select.hvac_mode",
} as const;
type HistoryMetric = keyof typeof historyEntities | "well_runs";

const history = Effect.fn("WatchmanToolkit.history")(function* (input: {
  readonly metric: HistoryMetric;
  readonly days?: number | undefined;
}) {
  const tool = "watchman_history";
  yield* requireCapability(tool);
  const cli = yield* WatchmanHaCli.WatchmanHaCli;
  if (input.metric === "well_runs") {
    if (input.days !== undefined && input.days !== 1) {
      return yield* fail(
        tool,
        "unavailable",
        "well_runs is the controller-produced summary for today; omit days or use days: 1.",
      );
    }
    const raw = yield* controller(tool, cli.readWellRunHistory());
    const runHistory = yield* decodeWellRunHistory(raw).pipe(
      Effect.mapError(() =>
        fail(tool, "invalid_response", "runhistory.json does not match the expected schema."),
      ),
    );
    const generatedAtMs = Date.parse(runHistory.generated);
    if (!Number.isFinite(generatedAtMs)) {
      return yield* fail(
        tool,
        "invalid_response",
        "runhistory.json has an invalid generated timestamp.",
      );
    }
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (generatedAtMs > nowMs) {
      return yield* fail(
        tool,
        "invalid_response",
        "runhistory.json has a future generated timestamp.",
      );
    }
    const dataAgeSeconds = Math.round((nowMs - generatedAtMs) / 1_000);
    if (dataAgeSeconds > WELL_RUN_HISTORY_MAX_AGE_SECONDS) {
      return yield* fail(
        tool,
        "invalid_response",
        `runhistory.json is stale (${dataAgeSeconds} seconds old).`,
      );
    }
    const siteZone = "America/Denver";
    const generatedLocalDate = DateTime.formatIsoDate(
      DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(generatedAtMs), siteZone),
    );
    const currentLocalDate = DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(now, siteZone));
    if (generatedLocalDate !== currentLocalDate) {
      return yield* fail(
        tool,
        "invalid_response",
        `runhistory.json is for ${generatedLocalDate}, not the current site date ${currentLocalDate}.`,
      );
    }
    const today = runHistory.drives.well.today;
    return {
      source: "Watchman controller-derived run history",
      data_age_seconds: dataAgeSeconds,
      timezone: siteZone,
      local_date: generatedLocalDate,
      summary: {
        ran: runHistory.drives.well.running_now || today.runs > 0 || today.runtime_min > 0,
        runtime_minutes: today.runtime_min,
        run_count: today.runs,
        brief_cycles: today.brief_cycles,
        currently_running: runHistory.drives.well.running_now,
      },
    };
  }
  const days = input.days ?? 7;
  const start = DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: -days }));
  const entityId = historyEntities[input.metric];
  const includeAttributes = input.metric === "operations";
  const query = new URLSearchParams({
    filter_entity_id: entityId,
    ...(includeAttributes ? {} : { minimal_response: "", no_attributes: "" }),
    significant_changes_only: "",
  });
  const data = yield* controller(
    tool,
    cli.rest("GET", `/api/history/period/${encodeURIComponent(start)}?${query.toString()}`),
  );
  return {
    source: "Home Assistant Recorder",
    metric: input.metric,
    entity_id: entityId,
    requested_days: days,
    data,
  };
});

const resolveScreens = (
  screen: "a" | "b" | "c" | "d" | "all",
): ReadonlyArray<(typeof screenLetters)[number]> => (screen === "all" ? screenLetters : [screen]);

const mutationResult = (input: {
  readonly requested: unknown;
  readonly accepted?: unknown;
  readonly applied: AppliedState;
  readonly observed: unknown;
  readonly evidence: string;
  readonly safety?: unknown;
}) => ({
  requested: input.requested,
  accepted: input.accepted ?? (input.applied !== "rejected" && input.applied !== "unavailable"),
  applied: input.applied,
  observed: input.observed,
  evidence: input.evidence,
  ...(input.safety === undefined ? {} : { safety: input.safety }),
});

const dispatchTv = Effect.fn("WatchmanToolkit.dispatchTv")(function* (
  calls: ReadonlyArray<ServiceCall>,
) {
  let completed = 0;
  for (const call of calls) {
    const result = yield* Effect.result(
      callService("watchman_tv_control", call.domain, call.service, call.data),
    );
    if (Result.isFailure(result)) {
      if (completed === 0) return yield* result.failure;
      return {
        status: "partial" as const,
        completed,
        planned: calls.length,
        error: result.failure.message,
      };
    }
    completed += 1;
  }
  return true;
});

const tvControl = Effect.fn("WatchmanToolkit.tvControl")(function* (input: {
  readonly operation:
    | "dashboard"
    | "open_url"
    | "launch_app"
    | "navigate"
    | "input_text"
    | "volume"
    | "power";
  readonly screen: "a" | "b" | "c" | "d" | "all";
  readonly url?: string | undefined;
  readonly app?: keyof typeof tvApps | undefined;
  readonly moves?:
    | ReadonlyArray<
        "up" | "down" | "left" | "right" | "select" | "back" | "home" | "search" | "play_pause"
      >
    | undefined;
  readonly text?: string | undefined;
  readonly level?: number | undefined;
  readonly muted?: boolean | undefined;
  readonly power?: "on" | "off" | undefined;
}) {
  const tool = "watchman_tv_control";
  yield* requireCapability(tool);
  const allowed = {
    dashboard: ["operation", "screen"],
    open_url: ["operation", "screen", "url"],
    launch_app: ["operation", "screen", "app"],
    navigate: ["operation", "screen", "moves"],
    input_text: ["operation", "screen", "text"],
    volume: ["operation", "screen", "level", "muted"],
    power: ["operation", "screen", "power"],
  }[input.operation];
  const irrelevant = irrelevantParameter(tool, input, allowed);
  if (irrelevant) return yield* irrelevant;
  let targets = resolveScreens(input.screen);
  let requestedUrl: string | undefined;
  let requestedApp: string | undefined;
  let dispatch: ReadonlyArray<ServiceCall>;
  let refresh: ReadonlyArray<string> = [];

  if (input.operation === "dashboard") {
    dispatch = [
      service("script", "turn_on", {
        entity_id: targets.map((screen) => `script.tv_show_dashboard_${screen}`),
      }),
    ];
    refresh = targets.map((screen) => `sensor.rec_${screen}_current_page`);
  } else if (input.operation === "open_url") {
    if (!input.url) return yield* fail(tool, "controller", "open_url requires url.");
    const url = yield* Effect.try({
      try: () => new URL(input.url!),
      catch: () => fail(tool, "controller", "URL is invalid."),
    });
    if (url.protocol !== "https:" || url.username || url.password) {
      return yield* fail(
        tool,
        "controller",
        "TV URLs must use HTTPS and must not contain credentials.",
      );
    }
    targets = targets.filter((screen) => screen !== "a");
    if (targets.length === 0) {
      return yield* fail(tool, "controller", "TV A is dedicated to the solar dashboard.");
    }
    requestedUrl = url.toString();
    dispatch = [
      service("media_player", "play_media", {
        entity_id: targets.map((screen) => `media_player.tv_${screen}_streamer`),
        media_content_type: "url",
        media_content_id: requestedUrl,
      }),
    ];
    refresh = targets.map((screen) => `sensor.rec_${screen}_current_page`);
  } else if (input.operation === "launch_app") {
    if (!input.app) return yield* fail(tool, "controller", "launch_app requires app.");
    targets = targets.filter((screen) => screen !== "a");
    if (targets.length === 0) {
      return yield* fail(tool, "controller", "TV A is dedicated to the solar dashboard.");
    }
    requestedApp = tvApps[input.app];
    dispatch = [
      service("remote", "turn_on", {
        entity_id: targets.map((screen) => `remote.tv_${screen}_streamer`),
        activity: requestedApp,
      }),
    ];
  } else if (input.operation === "navigate") {
    if (input.screen === "all") {
      return yield* fail(tool, "controller", "Navigate exactly one TV at a time.");
    }
    if (input.screen === "a") {
      return yield* fail(tool, "controller", "TV A is dedicated to the solar dashboard.");
    }
    if (!input.moves?.length) return yield* fail(tool, "controller", "navigate requires moves.");
    const commands = {
      up: "DPAD_UP",
      down: "DPAD_DOWN",
      left: "DPAD_LEFT",
      right: "DPAD_RIGHT",
      select: "DPAD_CENTER",
      back: "BACK",
      home: "HOME",
      search: "SEARCH",
      play_pause: "MEDIA_PLAY_PAUSE",
    };
    dispatch = [
      service("remote", "send_command", {
        entity_id: `remote.tv_${input.screen}_streamer`,
        command: input.moves.map((move) => commands[move]),
        delay_secs: 0.6,
      }),
    ];
  } else if (input.operation === "input_text") {
    if (input.screen === "all") {
      return yield* fail(tool, "controller", "Type into exactly one TV at a time.");
    }
    if (input.screen === "a") {
      return yield* fail(tool, "controller", "TV A is dedicated to the solar dashboard.");
    }
    if (!input.text) return yield* fail(tool, "controller", "input_text requires text.");
    dispatch = [
      service("remote", "send_command", {
        entity_id: `remote.tv_${input.screen}_streamer`,
        command: `text:${input.text}`,
      }),
    ];
  } else if (input.operation === "volume") {
    if (input.level === undefined && input.muted === undefined) {
      return yield* fail(tool, "controller", "volume requires level or muted.");
    }
    const entities = targets.map((screen) => `media_player.tv_${screen}_streamer`);
    const calls: Array<ServiceCall> = [];
    if (input.level !== undefined) {
      calls.push(
        service("media_player", "volume_set", {
          entity_id: entities,
          volume_level: input.level / 100,
        }),
      );
    }
    if (input.muted !== undefined) {
      calls.push(
        service("media_player", "volume_mute", {
          entity_id: entities,
          is_volume_muted: input.muted,
        }),
      );
    }
    dispatch = calls;
  } else {
    if (!input.power) return yield* fail(tool, "controller", "power requires on or off.");
    if (input.power === "off") targets = targets.filter((screen) => screen !== "a");
    if (targets.length === 0) {
      return yield* fail(tool, "controller", "TV A cannot be powered off from Control mode.");
    }
    dispatch = [
      input.power === "on"
        ? service("remote", "turn_on", {
            entity_id: targets.map((screen) => `remote.tv_${screen}_streamer`),
          })
        : service("media_player", "turn_off", {
            entity_id: targets.map((screen) => `media_player.tv_${screen}_panel`),
          }),
    ];
  }

  const skipped = resolveScreens(input.screen).filter((screen) => !targets.includes(screen));
  const requested = {
    ...input,
    effective_targets: targets,
    ...(skipped.length === 0 ? {} : { skipped }),
  };
  const accepted = yield* dispatchTv(dispatch);
  let refreshError: string | undefined;
  if (refresh.length > 0) {
    const refreshed = yield* Effect.result(
      callService(tool, "homeassistant", "update_entity", { entity_id: refresh }),
    );
    if (Result.isFailure(refreshed)) refreshError = refreshed.failure.message;
  }
  const statesResult = yield* Effect.result(readStates(tool));
  const observedAt = DateTime.formatIso(yield* DateTime.now);
  if (Result.isFailure(statesResult)) {
    return mutationResult({
      requested,
      accepted,
      applied: "unavailable",
      observed: {
        source: "Home Assistant live state",
        observed_at: observedAt,
        state: null,
        error: statesResult.failure.message,
        ...(refreshError === undefined ? {} : { refresh_error: refreshError }),
      },
      evidence: "Home Assistant accepted at least part of the request, but readback failed.",
      safety: { tv_a_policy: "dedicated_solar_dashboard" },
    });
  }
  const states = statesResult.success;
  const observed = Object.fromEntries(
    targets.map((screen) => [
      screen,
      {
        streamer: {
          state: stateValue(states, `media_player.tv_${screen}_streamer`),
          app_id: attribute(states, `media_player.tv_${screen}_streamer`, "app_id"),
        },
        panel: stateValue(states, `media_player.tv_${screen}_panel`),
        current_page: stateValue(states, `sensor.rec_${screen}_current_page`),
        foreground_app: stateValue(states, `sensor.rec_${screen}_foreground_app`),
        streamer_screen: stateValue(states, `switch.rec_${screen}_screen`),
      },
    ]),
  );
  const dashboardObserved =
    input.operation === "dashboard" &&
    targets.every(
      (screen) => stateValue(states, `sensor.rec_${screen}_current_page`) === dashboardUrls[screen],
    );
  const urlObserved =
    input.operation === "open_url" &&
    requestedUrl !== undefined &&
    targets.every(
      (screen) => stateValue(states, `sensor.rec_${screen}_current_page`) === requestedUrl,
    );
  const appObserved =
    input.operation === "launch_app" &&
    requestedApp !== undefined &&
    targets.every(
      (screen) =>
        stateValue(states, `sensor.rec_${screen}_foreground_app`) === requestedApp ||
        attribute(states, `media_player.tv_${screen}_streamer`, "app_id") === requestedApp,
    );
  const volumeVerified =
    input.operation === "volume" &&
    targets.every((screen) => {
      const streamer = states.get(`media_player.tv_${screen}_streamer`);
      const observedLevel = streamer?.attributes.volume_level;
      const observedMuted = streamer?.attributes.is_volume_muted;
      return (
        (input.level === undefined ||
          (typeof observedLevel === "number" &&
            Math.abs(observedLevel - input.level / 100) <= 0.005)) &&
        (input.muted === undefined || observedMuted === input.muted)
      );
    });
  const requiredObserverUnavailable =
    ((input.operation === "dashboard" || input.operation === "open_url") &&
      targets.some((screen) => stateUnavailable(states, `sensor.rec_${screen}_current_page`))) ||
    (input.operation === "launch_app" &&
      targets.some(
        (screen) =>
          stateUnavailable(states, `sensor.rec_${screen}_foreground_app`) &&
          typeof attribute(states, `media_player.tv_${screen}_streamer`, "app_id") !== "string",
      ));
  const applied =
    accepted !== true
      ? "pending"
      : requiredObserverUnavailable
        ? "unavailable"
        : volumeVerified
          ? "verified"
          : "pending";
  const streamerObserved = dashboardObserved || urlObserved || appObserved;
  return mutationResult({
    requested,
    accepted,
    applied,
    observed: {
      source: "Home Assistant live state",
      observed_at: observedAt,
      state: observed,
      ...(refreshError === undefined ? {} : { refresh_error: refreshError }),
    },
    evidence:
      applied === "unavailable"
        ? "The required TV observer entity is missing, unknown, or unavailable."
        : accepted !== true
          ? "Home Assistant accepted only part of the request; the overall result is not verified."
          : applied === "verified"
            ? "Fresh Home Assistant feedback matches the requested volume or mute state."
            : streamerObserved
              ? "The Streamer reports the requested page or foreground app, but panel visibility and active HDMI input are not directly observed."
              : input.operation === "navigate" || input.operation === "input_text"
                ? "Home Assistant accepted one non-retried remote input sequence; focus and typed text are not directly observable."
                : input.operation === "volume"
                  ? "The installed TV integration does not currently expose volume feedback, so acceptance is not physical verification."
                  : "Home Assistant accepted the closed request, but the requested physical state was not directly observed.",
    safety: {
      tv_a_policy: "dedicated_solar_dashboard",
      effective_targets: targets,
      ...(skipped.length === 0 ? {} : { skipped }),
      streamer_observed: streamerObserved,
      visible_panel_observed: false,
    },
  });
});

const selectedPairMask = (heads: ReadonlyArray<number>): string =>
  Object.entries(pairHeads)
    .filter(([, pair]) => pair.some((head) => heads.includes(head)))
    .map(([pair]) => pair)
    .join("");

const updatePairMask = (current: string, selected: string, action: "on" | "off" | "only") => {
  const have = new Set(current === "None" ? [] : [...current]);
  const chosen = new Set(selected);
  if (action === "only") return selected || "None";
  for (const pair of chosen) {
    if (action === "on") {
      have.add(pair);
    } else {
      have.delete(pair);
    }
  }
  return [..."ABCD"].filter((pair) => have.has(pair)).join("") || "None";
};

const hvacControl = Effect.fn("WatchmanToolkit.hvacControl")(function* (input: {
  readonly operation: "target" | "pairs" | "mode" | "party" | "hall";
  readonly target_f?: number | undefined;
  readonly heads?: ReadonlyArray<number> | undefined;
  readonly action?: "on" | "off" | "only" | "start" | "end" | undefined;
  readonly fan_mode?: "medium" | "high" | undefined;
  readonly mode?: "Auto" | "Manual" | "Off" | undefined;
  readonly minutes?: number | undefined;
  readonly hall_mode?: "cool" | "heat" | "off" | undefined;
  readonly hall_setpoint_f?: number | undefined;
}) {
  const tool = "watchman_hvac_control";
  yield* requireCapability(tool);
  const allowed =
    input.operation === "target"
      ? ["operation", "target_f"]
      : input.operation === "pairs"
        ? ["operation", "heads", "action", "target_f", "fan_mode"]
        : input.operation === "mode"
          ? ["operation", "mode"]
          : input.operation === "party"
            ? input.action === "start"
              ? ["operation", "action", "minutes", "target_f"]
              : ["operation", "action"]
            : ["operation", "hall_mode", "hall_setpoint_f"];
  const irrelevant = irrelevantParameter(tool, input, allowed);
  if (irrelevant) return yield* irrelevant;
  const before = yield* readStates(tool);
  let requestedPairs: string | undefined;

  if (input.operation === "target") {
    if (input.target_f === undefined)
      return yield* fail(tool, "controller", "target requires target_f.");
    yield* callService(tool, "input_number", "set_value", {
      entity_id: "input_number.hvac_party_setpoint_f",
      value: input.target_f,
    });
  } else if (input.operation === "pairs") {
    if (!input.heads?.length || !["on", "off", "only"].includes(input.action ?? "")) {
      return yield* fail(tool, "controller", "pairs requires heads and on, off, or only.");
    }
    const selected = selectedPairMask(input.heads);
    const mode = stateValue(before, "input_select.hvac_mode");
    const stored = stateValue(before, "input_select.hvac_requested_pairs");
    const current =
      ["Party", "Manual"].includes(mode) && /^(?:None|[A-D]+)$/.test(stored)
        ? stored
        : [..."ABCD"]
            .filter(
              (pair) =>
                stateValue(before, `binary_sensor.hvac_pair_${pair.toLowerCase()}_active`) === "on",
            )
            .join("") || "None";
    requestedPairs = updatePairMask(current, selected, input.action as "on" | "off" | "only");
    yield* callService(tool, "input_select", "select_option", {
      entity_id: "input_select.hvac_requested_pairs",
      option: requestedPairs,
    });
    if (input.target_f !== undefined) {
      yield* callService(tool, "input_number", "set_value", {
        entity_id: "input_number.hvac_party_setpoint_f",
        value: input.target_f,
      });
    }
    if (input.fan_mode !== undefined) {
      yield* callService(tool, "input_select", "select_option", {
        entity_id: "input_select.hvac_operator_fan",
        option: input.fan_mode,
      });
    }
    if (!["Party", "Manual"].includes(mode)) {
      yield* callService(tool, "input_select", "select_option", {
        entity_id: "input_select.hvac_mode",
        option: "Manual",
      });
    }
    yield* callService(tool, "script", "turn_on", {
      entity_id: "script.hvac_operator_reconcile",
    });
  } else if (input.operation === "mode") {
    if (!input.mode) return yield* fail(tool, "controller", "mode requires Auto, Manual, or Off.");
    yield* callService(tool, "input_select", "select_option", {
      entity_id: "input_select.hvac_mode",
      option: input.mode,
    });
    yield* callService(tool, "script", "turn_on", {
      entity_id: "script.hvac_operator_reconcile",
    });
  } else if (input.operation === "party") {
    if (input.action === "start") {
      if (input.minutes === undefined) {
        return yield* fail(
          tool,
          "controller",
          "Party start requires an explicit duration so an existing lease is never shortened implicitly.",
        );
      }
      if (input.target_f !== undefined) {
        yield* callService(tool, "input_number", "set_value", {
          entity_id: "input_number.hvac_party_setpoint_f",
          value: input.target_f,
        });
      }
      yield* callService(tool, "script", "turn_on", {
        entity_id: "script.hvac_party_start",
        variables: { hours: input.minutes / 60 },
      });
    } else if (input.action === "end") {
      yield* callService(tool, "script", "turn_on", {
        entity_id: "script.hvac_party_end",
      });
    } else {
      return yield* fail(tool, "controller", "party requires start or end.");
    }
  } else {
    if (input.hall_setpoint_f === undefined && input.hall_mode === undefined) {
      return yield* fail(tool, "controller", "hall requires hall_setpoint_f or hall_mode.");
    }
    if (input.hall_setpoint_f !== undefined) {
      yield* callService(tool, "climate", "set_temperature", {
        entity_id: "climate.hvac_inverter_hall",
        temperature: hallCelsius.get(input.hall_setpoint_f),
      });
    }
    if (input.hall_mode !== undefined) {
      yield* callService(tool, "climate", "set_hvac_mode", {
        entity_id: "climate.hvac_inverter_hall",
        hvac_mode: input.hall_mode,
      });
    }
  }

  const states = yield* readStates(tool);
  const directPairs = attribute(states, "sensor.watchman_hvac_controller", "pair_states");
  const appliedPairs =
    directPairs && typeof directPairs === "object"
      ? [..."ABCD"]
          .filter((pair) => (directPairs as Record<string, unknown>)[pair] === "full_on")
          .join("") || "None"
      : undefined;
  const applied =
    requestedPairs !== undefined &&
    appliedPairs !== undefined &&
    requestedPairs === appliedPairs &&
    input.operation === "pairs" &&
    input.target_f === undefined &&
    input.fan_mode === undefined
      ? "verified"
      : "pending";
  return mutationResult({
    requested: { ...input, requested_pairs: requestedPairs },
    applied,
    observed: statusForArea(states, "hvac"),
    evidence:
      applied === "verified"
        ? "Direct controller pair state matches the requested complete-pair mask."
        : input.operation === "hall"
          ? "Sensibo is cloud-reported/open-loop; Home Assistant accepted the request."
          : "Home Assistant accepted the controller/helper request, but direct applied state is pending, unavailable, or safety-clamped.",
    safety: {
      guard_cap: stateValue(states, "sensor.hvac_guard_cap"),
      controller_reason: stateValue(states, "sensor.hvac_controller_reason"),
    },
  });
});

const waterControl = Effect.fn("WatchmanToolkit.waterControl")(function* (input: {
  readonly operation: "set_speed_cap" | "hold" | "automatic";
  readonly max_hz?: number | undefined;
}) {
  const tool = "watchman_water_control";
  yield* requireCapability(tool);
  const irrelevant = irrelevantParameter(
    tool,
    input,
    input.operation === "set_speed_cap" ? ["operation", "max_hz"] : ["operation"],
  );
  if (irrelevant) return yield* irrelevant;
  if (input.operation === "set_speed_cap") {
    if (input.max_hz === undefined) {
      return yield* fail(tool, "controller", "set_speed_cap requires max_hz.");
    }
    yield* callService(tool, "input_number", "set_value", {
      entity_id: "input_number.well_user_max_hz",
      value: input.max_hz,
    });
  } else {
    yield* callService(tool, "script", "turn_on", {
      entity_id:
        input.operation === "hold"
          ? "script.well_solar_manual_hold"
          : "script.well_solar_return_automatic",
    });
  }
  const states = yield* readStates(tool);
  const drive = states.get("sensor.watchman_drive_snapshot");
  const requestedMode =
    input.operation === "hold" ? "hold" : input.operation === "automatic" ? "release" : undefined;
  const appliedMode = drive?.attributes.ctrl_applied_mode;
  const commandAge = drive?.attributes.ctrl_command_age_s;
  const lastUpdatedMs = drive?.last_updated ? Date.parse(drive.last_updated) : Number.NaN;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const snapshotFresh =
    Number.isFinite(lastUpdatedMs) && nowMs - lastUpdatedMs >= 0 && nowMs - lastUpdatedMs <= 30_000;
  const expectedHeld = requestedMode === "hold";
  const controlVerified =
    requestedMode !== undefined &&
    drive?.state === "True" &&
    drive.attributes.mode === "poller-v3" &&
    drive.attributes.ctrl_requested_mode === requestedMode &&
    appliedMode === requestedMode &&
    drive.attributes.ctrl_ack === true &&
    (drive.attributes.ctrl_error === null ||
      drive.attributes.ctrl_error === undefined ||
      drive.attributes.ctrl_error === "") &&
    drive.attributes.ctrl_held === expectedHeld &&
    typeof commandAge === "number" &&
    commandAge >= 0 &&
    commandAge <= 30 &&
    snapshotFresh;
  const applied = requestedMode !== undefined && controlVerified ? "verified" : "pending";
  return mutationResult({
    requested: input,
    applied,
    observed: statusForArea(states, "water"),
    evidence:
      input.operation === "set_speed_cap"
        ? "Home Assistant accepted the helper value; the sole-owner poller performs the physical ID102 write/readback, which is not yet exposed as an HA attribute."
        : applied === "verified"
          ? "A fresh sole-owner poller snapshot acknowledges the request with matching requested/applied mode, held state, and no control error."
          : "The controller accepted the request; a fresh complete poller acknowledgment is pending, stale, errored, or safety-held.",
    safety: {
      automatic_means: "return controller authority; not start-now",
      ctrl_ack: drive?.attributes.ctrl_ack,
      ctrl_error: drive?.attributes.ctrl_error,
      safety_latch: attribute(states, "sensor.well_solar_controller", "safety_latch"),
    },
  });
});

const powerControl = Effect.fn("WatchmanToolkit.powerControl")(function* () {
  const tool = "watchman_power_control";
  yield* requireCapability(tool);
  const states = yield* readStates(tool);
  return {
    available_mutations: [],
    unavailable: {
      generator:
        "Manual today; enable only after a deterministic two-wire controller and run readback exist.",
      shutdown: "Excluded from Control mode.",
      battery_and_generator_settings: "Excluded safety settings.",
    },
    observed: statusForArea(states, "power"),
  };
});

const automation = Effect.fn("WatchmanToolkit.automation")(function* () {
  const tool = "watchman_automation";
  yield* requireCapability(tool);
  const states = yield* readStates(tool);
  return {
    installed: statusForArea(states, "operations"),
    mutable_jobs: [],
    unavailable:
      "General schedules, timed water runs, and loops need deterministic subsystem controllers first. T3 will not emulate them with model waits or loops.",
  };
});

const handlers = {
  watchman_status: status,
  watchman_history: history,
  watchman_tv_control: (input) => mutationSemaphore.withPermits(1)(tvControl(input)),
  watchman_hvac_control: (input) => mutationSemaphore.withPermits(1)(hvacControl(input)),
  watchman_water_control: (input) => mutationSemaphore.withPermits(1)(waterControl(input)),
  watchman_power_control: powerControl,
  watchman_automation: automation,
} satisfies Parameters<typeof WatchmanToolkit.toLayer>[0];

export const WatchmanToolkitHandlersLive = WatchmanToolkit.toLayer(handlers);
