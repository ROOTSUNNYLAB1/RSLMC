import { describe, expect, test } from "bun:test";
import {
  TINT_BOLD_KINDS,
  TINT_COLOURS,
  hasSectionCodes,
  parseSectionCodes,
  tintLine,
} from "../frontend/lib/console-tint";

/*
 * Console colour.
 *
 * A real Minecraft server writes no ANSI escape at all when its stdout is a pipe — verified against
 * vanilla 1.21.4 on Temurin 21, with and without TERM / log4j.skipJansi. So the console has to colour
 * plain text itself; these tests pin the decisions that make the console readable: the level word is
 * coloured by meaning, the timestamp stays quiet, and the events an operator scans for get their own
 * hue rather than the whole line being one grey.
 */

const runs = (line: string) => tintLine(line) ?? [];

const kindOf = (line: string, match: string): string | undefined =>
  runs(line).find((run) => run.text === match)?.kind;

const INFO_LINE = "[12:04:31] [Server thread/INFO]: Preparing spawn area: 42%";
const WARN_LINE = "[12:04:52] [Server thread/WARN]: Can't keep up! Is the server overloaded?";
const ERROR_LINE = "[12:05:10] [Server thread/ERROR]: Exception ticking world";

describe("plain Minecraft log lines", () => {
  test("timestamp, thread and level are separated and coloured by meaning", () => {
    expect(kindOf(INFO_LINE, "[12:04:31]")).toBe("timestamp");
    expect(kindOf(INFO_LINE, "INFO")).toBe("level-info");
    expect(kindOf(INFO_LINE, "[Server thread/")).toBe("thread");
    expect(kindOf(WARN_LINE, "WARN")).toBe("level-warn");
    expect(kindOf(ERROR_LINE, "ERROR")).toBe("level-error");
  });

  test("the level colours are three clearly different hues, and none of them is grey", () => {
    const info = TINT_COLOURS["level-info"];
    const warn = TINT_COLOURS["level-warn"];
    const error = TINT_COLOURS["level-error"];
    expect(new Set([info, warn, error]).size).toBe(3);
    // info is cool, warn is warm, error is red — the console has to be scannable, not monochrome
    expect(info).not.toBe(TINT_COLOURS.timestamp);
    expect(error).not.toBe(TINT_COLOURS.text);
    expect(warn).not.toBe(TINT_COLOURS.text);
  });

  test("the message body is never dropped while splitting", () => {
    for (const line of [INFO_LINE, WARN_LINE, ERROR_LINE]) {
      expect(runs(line).map((run) => run.text).join("")).toBe(line);
    }
  });

  test("the join / leave / lost-connection events stand out", () => {
    const joined = "[12:06:00] [Server thread/INFO]: Steve joined the game";
    expect(kindOf(joined, "Steve")).toBe("player");
    expect(kindOf(joined, " joined the game")).toBe("join");

    const left = "[12:09:00] [Server thread/INFO]: Alex left the game";
    expect(kindOf(left, "Alex")).toBe("player");
    expect(kindOf(left, " left the game")).toBe("leave");

    const lost = "[12:09:10] [Server thread/INFO]: Herobrine lost connection: Disconnected";
    expect(kindOf(lost, "Herobrine")).toBe("player");
    expect(kindOf(lost, " lost connection")).toBe("lost");
  });

  test("\"Done (x.xxxs)!\" is the green ready line", () => {
    const ready = "[12:04:58] [Server thread/INFO]: Done (6.812s)! For help, type \"help\"";
    const body = runs(ready).find((run) => run.text.startsWith("Done ("));
    expect(body?.kind).toBe("ready");
    expect(TINT_COLOURS.ready).toBe(TINT_COLOURS.join);   // one green, used twice
  });

  test("a WARN or ERROR body carries the colour, not just the level word", () => {
    const warnBody = runs(WARN_LINE).find((run) => run.text.startsWith("Can't keep up"));
    expect(warnBody?.kind).toBe("level-warn");
    const errorBody = runs(ERROR_LINE).find((run) => run.text.startsWith("Exception ticking"));
    expect(errorBody?.kind).toBe("level-error");
    // an ordinary INFO line stays neutral so the coloured ones still stand out
    const infoBody = runs(INFO_LINE).find((run) => run.text.startsWith("Preparing spawn"));
    expect(infoBody?.kind).toBe("text");
  });

  test("level words are drawn bold, and so is every meaningful event", () => {
    expect(TINT_BOLD_KINDS.has("level-info")).toBe(true);
    expect(TINT_BOLD_KINDS.has("level-error")).toBe(true);
    expect(TINT_BOLD_KINDS.has("ready")).toBe(true);
    expect(TINT_BOLD_KINDS.has("timestamp")).toBe(false);
    expect(TINT_BOLD_KINDS.has("text")).toBe(false);
  });

  test("chat and plugin prefixes get their own hue", () => {
    const chat = "[12:07:00] [Server thread/INFO]: <Steve> hello there";
    expect(kindOf(chat, "Steve")).toBe("player");
    const plugin = "[12:07:01] [Server thread/INFO]: [ViaVersion] Loaded 412 protocol mappings";
    expect(kindOf(plugin, "[ViaVersion]")).toBe("plugin");
    const vanilla = "[12:07:02] [Server thread/INFO]: [STDOUT] plain";
    expect(kindOf(vanilla, "[STDOUT]")).toBe("plugin");
  });

  test("a line with nothing to distinguish is left alone", () => {
    expect(tintLine("")).toBeNull();
    expect(tintLine("some unstructured output with no shape at all")).toBeNull();
  });

  test("panel-emitted lines still get structure", () => {
    // systemLine() writes "[RSLMC] …" without a timestamp; it must not be torn apart
    const system = tintLine("[RSLMC] Server started with a 2048 MB heap");
    expect(system).toBeNull();
  });
});

describe("legacy § codes", () => {
  test("colour, reset and style codes are parsed", () => {
    const text = "§aWelcome §lback§r to §cPvP";
    expect(hasSectionCodes(text)).toBe(true);
    const parsed = parseSectionCodes(text);
    expect(parsed.map((run) => run.text).join("")).toBe("Welcome back to PvP");
    expect(parsed.find((run) => run.text === "Welcome ")?.colour).toBe("#7fd8a2");
    expect(parsed.find((run) => run.text === "back")?.bold).toBe(true);
    expect(parsed.find((run) => run.text === " to ")?.colour).toBeUndefined();
    expect(parsed.find((run) => run.text === "PvP")?.colour).toBe("#e08a86");
  });

  test("the ampersand spelling plugins actually write is accepted", () => {
    expect(hasSectionCodes("&6Gold &7grey")).toBe(true);
    const parsed = parseSectionCodes("&6Gold &7grey");
    expect(parsed[0]).toMatchObject({ text: "Gold ", colour: "#d9b45c" });
    expect(parsed[1]).toMatchObject({ text: "grey", colour: "#c8ccd4" });
  });

  test("obfuscated (k) is not silently deleted and a bare § stays visible", () => {
    expect(parseSectionCodes("§ksecret").map((run) => run.text).join("")).toBe("secret");
    expect(parseSectionCodes("100§ off").map((run) => run.text).join("")).toBe("100§ off");
    expect(hasSectionCodes("no codes here")).toBe(false);
  });

  test("§ codes win over structural tinting", async () => {
    const { parseAnsi } = await import("../frontend/lib/ansi");
    const segments = parseAnsi("[12:00:00] [Server thread/INFO]: §aDone!§r");
    expect(segments.some((segment) => segment.style.color === "#7fd8a2")).toBe(true);
  });

  test("a plain log line comes back from the ANSI parser already coloured", async () => {
    const { parseAnsi, stripAnsi } = await import("../frontend/lib/ansi");
    const segments = parseAnsi(WARN_LINE);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((segment) => segment.text).join("")).toBe(WARN_LINE);
    expect(new Set(segments.map((segment) => segment.style.color)).size).toBeGreaterThan(2);
    // …and the stored text is untouched, so copy / download still match the server's log
    expect(stripAnsi(WARN_LINE)).toBe(WARN_LINE);
  });

  test("real ANSI output is still parsed the old way", async () => {
    const { parseAnsi, stripAnsi } = await import("../frontend/lib/ansi");
    const raw = "\u001b[31mERROR\u001b[0m something";
    const segments = parseAnsi(raw);
    expect(segments[0]?.style.color).toBe("#cd3131");   // the SGR palette, not the UI red
    expect(stripAnsi(raw)).toBe("ERROR something");
  });
});
