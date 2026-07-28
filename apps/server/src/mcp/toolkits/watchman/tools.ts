import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WatchmanHaCli from "./WatchmanHaCli.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, WatchmanHaCli.WatchmanHaCli];
const screen = Schema.Literals(["a", "b", "c", "d", "all"]);
const fahrenheit = Schema.Int.check(Schema.isBetween({ minimum: 66, maximum: 80 }));

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
      "Read curated live Watchman status for the site, power, water, HVAC, TVs, weather, or controller decisions. Values include evidence/source labels; never infer a number that is absent.",
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
      "Read up to 30 days of allowlisted Home Assistant history or the Watchman operations journal. This never accepts an arbitrary entity ID.",
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
      "Control the TV wall through closed Home Assistant targets. TV A allows dashboard, volume, mute, and power-on only; 'all' content or power-off means all eligible flexible screens B-D and the receipt names skipped targets. Prime Video, Netflix, and YouTube can be launched directly. Search input is a separate non-retried remote sequence whose focus cannot be verified.",
    parameters: Schema.Union([
      Schema.Struct({
        operation: Schema.Literals(["dashboard"]),
        screen,
      }),
      Schema.Struct({
        operation: Schema.Literals(["open_url"]),
        screen,
        url: Schema.String.check(Schema.isMaxLength(2048)),
      }),
      Schema.Struct({
        operation: Schema.Literals(["launch_app"]),
        screen: Schema.Literals(["b", "c", "d", "all"]),
        app: Schema.Literals(["prime_video", "netflix", "youtube"]),
      }),
      Schema.Struct({
        operation: Schema.Literals(["navigate"]),
        screen: Schema.Literals(["b", "c", "d"]),
        moves: Schema.Array(
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
      }),
      Schema.Struct({
        operation: Schema.Literals(["input_text"]),
        screen: Schema.Literals(["b", "c", "d"]),
        text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
      }),
      Schema.Struct({
        operation: Schema.Literals(["volume"]),
        screen,
        level: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
        muted: Schema.optional(Schema.Boolean),
      }),
      Schema.Struct({
        operation: Schema.Literals(["power"]),
        screen,
        power: Schema.Literals(["on", "off"]),
      }),
    ]).annotate({ parseOptions: { onExcessProperty: "error" } }),
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Control Watchman TVs"),
);

export const WatchmanHvacControlTool = mutationTool(
  Tool.make("watchman_hvac_control", {
    description:
      "Request HVAC changes through the installed v2 helper/reconciler boundary. The deterministic controller owns pair expansion, pacing, leases, equipment protection, and applied-state verification.",
    parameters: Schema.Union([
      Schema.Struct({
        operation: Schema.Literals(["target"]),
        target_f: fahrenheit,
      }),
      Schema.Struct({
        operation: Schema.Literals(["pairs"]),
        heads: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))).check(
          Schema.isMinLength(1),
        ),
        action: Schema.Literals(["on", "off", "only"]),
        target_f: Schema.optional(fahrenheit),
        fan_mode: Schema.optional(Schema.Literals(["medium", "high"])),
      }),
      Schema.Struct({
        operation: Schema.Literals(["mode"]),
        mode: Schema.Literals(["Auto", "Manual", "Off"]),
      }),
      Schema.Struct({
        operation: Schema.Literals(["party"]),
        action: Schema.Literals(["start"]),
        minutes: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 360 })),
        target_f: Schema.optional(fahrenheit),
      }),
      Schema.Struct({
        operation: Schema.Literals(["party"]),
        action: Schema.Literals(["end"]),
      }),
      Schema.Struct({
        operation: Schema.Literals(["hall"]),
        hall_mode: Schema.optional(Schema.Literals(["cool", "heat", "off"])),
        hall_setpoint_f: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 75, maximum: 85 })),
        ),
      }),
    ]).annotate({ parseOptions: { onExcessProperty: "error" } }),
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Control Watchman HVAC"),
);

export const WatchmanWaterControlTool = mutationTool(
  Tool.make("watchman_water_control", {
    description:
      "Set the well user speed ceiling from 102-115 Hz, request a controller-owned HOLD, or return authority to automatic/native-solar operation. Automatic is not start-now. This never writes Modbus or live control files.",
    parameters: Schema.Union([
      Schema.Struct({
        operation: Schema.Literals(["set_speed_cap"]),
        max_hz: Schema.Int.check(Schema.isBetween({ minimum: 102, maximum: 115 })),
      }),
      Schema.Struct({
        operation: Schema.Literals(["hold", "automatic"]),
      }),
    ]).annotate({ parseOptions: { onExcessProperty: "error" } }),
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Control Watchman water"),
);

export const WatchmanPowerControlTool = readTool(
  Tool.make("watchman_power_control", {
    description:
      "Read the current power-control availability. Mutations are unavailable today: generator start is manual, and shutdown plus battery/generator safety settings are excluded from Control mode.",
    parameters: Schema.Struct({}),
    success: result,
    failure: WatchmanControlError,
    dependencies,
  }).annotate(Tool.Title, "Inspect Watchman power controls"),
);

export const WatchmanAutomationTool = readTool(
  Tool.make("watchman_automation", {
    description:
      "Inspect installed deterministic modes and leases. General schedules, timed water runs, and loops are unavailable until a subsystem controller owns them; never wait or loop in the model.",
    parameters: Schema.Struct({}),
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
  WatchmanPowerControlTool,
  WatchmanAutomationTool,
);
