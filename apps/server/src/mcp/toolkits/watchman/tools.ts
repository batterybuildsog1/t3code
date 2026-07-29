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
    "volume",
    "power",
    "hold",
    "release",
    "navigate",
    "input_text",
  ]),
  screen,
  app: Schema.optional(
    Schema.Literals(["netflix", "youtube", "disney_plus", "prime_video", "hulu"]),
  ),
  content_id: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  title_query: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  view: Schema.optional(
    Schema.Literals([
      "solar.primary",
      "water.flow",
      "water.day",
      "water.well",
      "water.duty",
      "site.events",
      "hvac.recroom",
      "water.runs",
    ]),
  ),
  url: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2048),
      Schema.isPattern(/^https:\/\//),
    ),
  ),
  scene_name: Schema.optional(Schema.Literal("party")),
  members: Schema.optional(
    Schema.Array(Schema.Literals(["b", "c", "d"])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3),
    ),
  ),
  action: Schema.optional(
    Schema.Literals(["pause", "resume", "play_pause", "next", "prev", "seek"]),
  ),
  seek_s: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: -3600, maximum: 3600 }))),
  moves: Schema.optional(
    Schema.Array(
      Schema.Literals([
        "up",
        "down",
        "left",
        "right",
        "select",
        "back",
        "home",
        "search",
        "play_pause",
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  ),
  text: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(120),
      Schema.isPattern(/^[\x20-\x7e]+$/),
    ),
  ),
  level: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  muted: Schema.optional(Schema.Boolean),
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
  operation: Schema.Literals(["set_speed_cap", "hold", "automatic"]),
  max_hz: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 102, maximum: 115 }))),
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
      "File a typed request to the resident tvd controller and return its five-part requested/accepted/applied/observed/evidence receipt. Supported apps are Netflix, YouTube, Disney+, Prime Video, and Hulu. TV A is fail-closed to solar.primary restore, volume/mute, and power-on only; eligible 'all' requests target the flexible TVs B-D. Verification is honest: verified means tvd witnessed the verb-specific postcondition, while pending, unavailable, rejected, superseded, failed, or indeterminate must be reported unchanged.",
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
  WatchmanTvControlTool,
  WatchmanHvacControlTool,
  WatchmanWaterControlTool,
  WatchmanAutomationTool,
);
