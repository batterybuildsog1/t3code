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
const fahrenheit = Schema.Int.check(Schema.isBetween({ minimum: 66, maximum: 80 }));
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
  operation: Schema.Literals(["target", "pairs", "mode", "party", "hall"]),
  target_f: Schema.optional(fahrenheit),
  heads: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))).check(
      Schema.isMinLength(1),
    ),
  ),
  action: Schema.optional(Schema.Literals(["on", "off", "only", "start", "end"])),
  fan_mode: Schema.optional(Schema.Literals(["medium", "high"])),
  mode: Schema.optional(Schema.Literals(["Auto", "Manual", "Off"])),
  minutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 360 }))),
  hall_mode: Schema.optional(Schema.Literals(["cool", "heat", "off"])),
  hall_setpoint_f: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 75, maximum: 85 })),
  ),
}).annotate(strictParameters);

const waterParameters = Schema.Struct({
  operation: Schema.Literals(["set_operator_limit", "clear_operator_limit", "hold", "automatic"]),
  max_hz: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 102, maximum: 114 }))),
  minutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 }))),
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
      "Request HVAC changes through the installed v2 helper/reconciler boundary. The deterministic controller owns pair expansion, pacing, leases, equipment protection, and applied-state verification.",
    parameters: hvacParameters,
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Control Watchman HVAC"),
);

export const WatchmanWaterControlTool = mutationTool(
  Tool.make("watchman_water_control", {
    description:
      "Set or clear a temporary 102-114 Hz well operator limit, request a controller-owned HOLD, or return authority to automatic/native-solar operation. Limits expire after 60 minutes by default (1-240 allowed); no limit means the normal 115 Hz ceiling. Automatic is not start-now. Pressure safety always overrides.",
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
  WatchmanTvControlTool,
  WatchmanHvacControlTool,
  WatchmanWaterControlTool,
  WatchmanAutomationTool,
);
