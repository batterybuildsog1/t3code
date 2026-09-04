import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as TvdSpool from "./TvdSpool.ts";
import * as WatchmanHaCli from "./WatchmanHaCli.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  WatchmanHaCli.WatchmanHaCli,
  TvdSpool.TvdSpool,
  Crypto.Crypto,
];
const screen = Schema.Literals(["a", "b", "c", "d", "all"]);
const headFahrenheit = Schema.Int.check(Schema.isBetween({ minimum: 65, maximum: 85 }));
const noParameters = Schema.Record(Schema.String, Schema.Never);
const strictParameters = { parseOptions: { onExcessProperty: "error" } } as const;

const tvParameters = Schema.Struct({
  operation: Schema.Literals([
    "play",
    "show",
    "scene",
    "transport",
    "power",
    "hold",
    "release",
    "play_title",
    "recover",
  ]),
  screen,
  app: Schema.optional(
    Schema.Literals(["netflix", "youtube", "disney_plus", "prime_video", "hulu"]),
  ),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  content_id: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  view: Schema.optional(Schema.Literals(["solar.primary", "wall.dashboard"])),
  scene_name: Schema.optional(Schema.Literal("party")),
  members: Schema.optional(
    Schema.Array(Schema.Literals(["b", "c", "d"])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3),
    ),
  ),
  action: Schema.optional(Schema.Literals(["pause", "resume", "play_pause", "next", "prev"])),
  power: Schema.optional(Schema.Literals(["on", "off"])),
  expires_at: Schema.optional(Schema.Finite),
}).annotate(strictParameters);

const hvacParameters = Schema.Struct({
  operation: Schema.Literals(["target", "pairs", "heads", "mode", "party", "hall"]),
  target_f: Schema.optional(headFahrenheit),
  heads: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))).check(
      Schema.isMinLength(1),
    ),
  ),
  pairs: Schema.optional(
    Schema.Array(Schema.Literals(["A", "B", "C", "D"])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
    ),
  ),
  action: Schema.optional(Schema.Literals(["start", "end"])),
  power: Schema.optional(Schema.Literals(["on", "off"])),
  selection: Schema.optional(Schema.Literals(["preserve", "only"])),
  head_mode: Schema.optional(Schema.Literals(["auto", "cool", "dry", "fan_only", "heat"])),
  fan_mode: Schema.optional(Schema.Literals(["auto", "low", "medium", "high"])),
  swing_mode: Schema.optional(Schema.Literals(["off", "vertical"])),
  mode: Schema.optional(Schema.Literals(["Auto", "Manual", "Off"])),
  minutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 360 }))),
  hall_mode: Schema.optional(
    Schema.Literals(["cool", "heat", "fan_only", "dry", "heat_cool", "off"]),
  ),
  hall_setpoint_f: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 46, maximum: 86 })),
  ),
  hall_fan_mode: Schema.optional(
    Schema.Literals(["quiet", "low", "medium", "high", "auto", "strong"]),
  ),
  hall_swing_mode: Schema.optional(Schema.Literals(["stopped", "rangefull"])),
}).annotate(strictParameters);

const waterParameters = Schema.Struct({
  operation: Schema.Literals(["set_speed_cap", "hold", "automatic"]),
  max_hz: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 102, maximum: 115 }))),
}).annotate(strictParameters);

const operationStatusParameters = Schema.Struct({
  operation_id: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(160)),
  wait_seconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 60 }))),
}).annotate(strictParameters);

export class WatchmanControlError extends Schema.TaggedErrorClass<WatchmanControlError>()(
  "WatchmanControlError",
  {
    tool: Schema.String,
    reason: Schema.Literals(["capability", "controller", "unavailable", "invalid_response"]),
    message: Schema.String,
  },
) {}

const result = Schema.Record(Schema.String, Schema.Unknown);

const mutationTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, false).annotate(Tool.Destructive, true) as T;

const readTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

export const WatchmanStatusTool = readTool(
  Tool.make("watchman_status", {
    description:
      "Read curated live Watchman status for the site, power, water, HVAC, TVs, weather, or controller decisions. Choose exactly the narrowest applicable area; never combine an area read with site. Power includes current control availability. Values include evidence/source labels; never infer a number that is absent.",
    parameters: Schema.Struct({
      area: Schema.Literals(["site", "power", "water", "hvac", "tv", "weather", "operations"]),
    }),
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Read Watchman status"),
);

export const WatchmanHistoryTool = readTool(
  Tool.make("watchman_history", {
    description:
      "Read bounded history only when the user explicitly asks about an earlier period, trend, or runtime. For current conditions use watchman_status and do not add history. Numeric metrics return range and endpoint summaries for the requested window; operations and HVAC return only recent events or transitions. Supports up to 30 days of allowlisted Home Assistant history. well_runs returns the controller-derived summary for today and accepts days omitted or 1. This never accepts an arbitrary entity ID.",
    parameters: Schema.Struct({
      metric: Schema.Literals([
        "operations",
        "battery_soc",
        "solar_power",
        "site_load",
        "well_pressure",
        "well_frequency",
        "well_runs",
        "hvac_mode",
      ]),
      days: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
    }),
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Read Watchman history"),
);

export const WatchmanOperationStatusTool = readTool(
  Tool.make("watchman_operation_status", {
    description:
      "Read or briefly wait for one correlated Watchman mutation receipt, including isolated HVAC hall and exact-head operations. Pass the provider-neutral operation_id returned by a control tool. Omit wait_seconds for an immediate read, or use 10-60 seconds for one bounded wait. A platform acknowledgement is not verification; preserve the controller's applied state and evidence exactly.",
    parameters: operationStatusParameters,
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Check Watchman operation"),
);

export const WatchmanTvControlTool = mutationTool(
  Tool.make("watchman_tv_control", {
    description:
      "File typed TV requests to tvd and return its five-part receipt. Supports content-ID or title-based play with cross-platform resolution, canonical views/scenes, transport, power, holds/releases, and single-screen wall recovery. TV A is dual-purpose. Netflix/Hulu title play and recovery await an owner ruling; report tvd's applied state unchanged.",
    parameters: tvParameters,
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Control Watchman TVs"),
);

export const WatchmanHvacControlTool = mutationTool(
  Tool.make("watchman_hvac_control", {
    description:
      "Control HVAC only through its installed deterministic boundary. operation=heads controls exactly named Samsung Heads 1-8 and never broadens a head to its electrical partner; it fails closed until the durable exact-head v3 service is active. operation=hall controls the separate inverter hall through its own durable v3 receipt and never uses the Samsung request lane; it accepts the hall's live mode, 46-86F setpoint, fan, and swing values, while off rejects active settings. Omitted hall settings resolve from captured live state, never guessed defaults. Pre-cutover hall retains the legacy open-loop Sensibo mode/setpoint path and must remain pending; its historical setpoint range remains 75-85F, and fan/swing require v3. Developer maintenance may use operation=pairs with explicit pair labels A-D only; A=1+2, B=3+4, C=5+6, D=7+8. Samsung targets support the declared 65-85F range; pair maintenance supports medium/high fan and a 5-360 minute lease. Whole-building Party/Off/Auto remain available. Every installed v3 mutation returns a durable operation_id and direct-state verified, pending, or safety outcome. Never turn a platform acknowledgement into success.",
    parameters: hvacParameters,
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Control Watchman HVAC"),
);

export const WatchmanWaterControlTool = mutationTool(
  Tool.make("watchman_water_control", {
    description:
      "Set the well user speed ceiling from 102-115 Hz, request a controller-owned HOLD, or return authority to automatic/native-solar operation. Automatic is not start-now. This never writes Modbus or live control files.",
    parameters: waterParameters,
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Control Watchman water"),
);

export const WatchmanAutomationTool = readTool(
  Tool.make("watchman_automation", {
    description:
      "Inspect installed deterministic modes and leases. General schedules, timed water runs, and loops are unavailable until a subsystem controller owns them; never wait or loop in the model.",
    parameters: noParameters,
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Inspect Watchman automations"),
);

export const WatchmanToolkit = Toolkit.make(
  WatchmanStatusTool,
  WatchmanHistoryTool,
  WatchmanOperationStatusTool,
  WatchmanTvControlTool,
  WatchmanHvacControlTool,
  WatchmanWaterControlTool,
  WatchmanAutomationTool,
);
