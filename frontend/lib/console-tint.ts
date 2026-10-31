/**
 * Colour for plain server output.
 *
 * A Minecraft server writes ANSI escapes only when its stdout is a terminal. RSLMC runs it behind a
 * pipe (and a relay), so what actually arrives is plain text like
 *
 *     [10:43:13] [Server thread/INFO]: Starting minecraft server version 1.21.4
 *     [10:44:02] [Server thread/WARN]: Can't keep up! Is the server overloaded?
 *
 * Rendered as-is the console is one flat grey wall — every line looks the same, and the one line that
 * matters (the warning, the join, the crash) is impossible to find. So the panel colours it itself:
 * the timestamp stays quiet, the level is coloured by meaning (INFO blue, WARN amber, ERROR red), and
 * the events an operator scans for — ready, join, leave, disconnect, coordinates — get their own hue.
 *
 * This is presentation only: the stored text is never modified, and copy/download still hand out the
 * original line.
 */

export type TintKind =
  | "timestamp" | "thread" | "level-info" | "level-warn" | "level-error" | "level-faint"
  | "text" | "ready" | "join" | "leave" | "lost" | "player" | "coord" | "plugin" | "dim"
  | "command" | "number" | "label";

export interface TintRun {
  text: string;
  kind: TintKind;
}

/** Colours for a dark terminal well. Muted on purpose — the panel has a "no neon" rule. */
export const TINT_COLOURS: Record<TintKind, string> = {
  timestamp: "#79808e",
  thread: "#8f96a4",
  "level-info": "#7fb3f0",
  "level-warn": "#f0c05a",
  "level-error": "#f4777a",
  "level-faint": "#828897",
  text: "#e2e6ee",
  ready: "#63d994",
  join: "#63d994",
  leave: "#f0c05a",
  lost: "#f4777a",
  player: "#cdaef0",
  coord: "#8fccdd",
  plugin: "#aab4ea",
  dim: "#79808e",
  command: "#8ec7e8",     /* /help style command listings */
  number: "#d8c98a",      /* counts, percentages, seeds */
  label: "#b9c0cf",       /* a "Server Plugins (2):" style heading */
};

/** Kinds that carry meaning, so they are drawn at weight 600 instead of the terminal's 400. */
export const TINT_BOLD_KINDS: ReadonlySet<TintKind> = new Set<TintKind>([
  "level-info", "level-warn", "level-error", "ready", "join", "leave", "lost", "player", "command",
]);

const LEVEL_KIND: Record<string, TintKind> = {
  INFO: "level-info",
  WARN: "level-warn",
  WARNING: "level-warn",
  ERROR: "level-error",
  SEVERE: "level-error",
  FATAL: "level-error",
  DEBUG: "level-faint",
  TRACE: "level-faint",
};

/*
 * Two shapes are in the wild, and both must be coloured:
 *   `[10:43:13] [Server thread/INFO]: …`  — Paper / modern vanilla (thread name present)
 *   `[14:49:57 INFO]: …`                  — classic Bukkit/Spigot formatter, and anything logged
 *                                           through a java.util.logging handler that omits the thread.
 * The second one is what a Spigot/Paper server with quiet plugins actually prints, so a console that
 * only matches the first renders every line as flat grey.
 */
const PREFIX = /^(\[\d{1,2}:\d{2}:\d{2}\])\s+\[([^\]]*?)\/([A-Za-z]+)\]:?\s?/;
/** `[14:49:57 INFO]: …` — time and level inside one bracket (classic Bukkit / plain JUL handler). */
const PREFIX_COMPACT = /^(\[\d{1,2}:\d{2}:\d{2})\s+([A-Za-z]+)\](:?\s?)/;

const JOIN = /\b([A-Za-z0-9_]{2,16})(\s+(?:joined the game)\b)/;
const LEAVE = /\b([A-Za-z0-9_]{2,16})(\s+(?:left the game)\b)/;
const LOST = /\b([A-Za-z0-9_]{2,16})(\s+(?:lost connection)\b)/;
const CHAT = /^<([A-Za-z0-9_]{2,16})>/;
const READY = /\bDone \(\d+(?:[.,]\d+)?s\)!.*$/;
const COORDS = /(?<![\w.])(-?\d{1,7})[ ,](-?\d{1,7})[ ,](-?\d{1,7})(?![\w.])/;
const PLUGIN = /\[([A-Za-z][A-Za-z0-9 _\-]{1,24})\]/g;
/** `/tm: A Mojang provided command.` — one entry of a `/help` listing. */
const COMMAND_LIST = /^(\/[A-Za-z0-9:_\-]{1,40})(?=:\s|:$)/;
/** `- ViaBackwards, ViaVersion` — the body of `/plugins`, one entry per name. */
const PLUGIN_LIST = /^(\s*-\s+)([A-Za-z][A-Za-z0-9+/]{2,}(?:\s*,\s*[A-Za-z][A-Za-z0-9+/]{2,})*)(\s*)$/;
const PLUGIN_LIST_NAME = /[A-Za-z][A-Za-z0-9+/]{2,}/g;
/**
 * A short Title-Case heading that ends in a colon: `Bukkit Plugins:`, `i Server Plugins (2):`.
 * A sentence that merely ends in a colon ("There are 0 of a max of 20 players online:") is rejected,
 * because colouring that as a heading would bury the counts it is trying to show.
 */
function isHeading(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 34 || !trimmed.endsWith(":")) return false;
  const words = trimmed.slice(0, -1).split(" ");
  if (words.length > 4) return false;
  return words.every((word, index) => {
    if (!word) return false;
    if (/^\(\d+\)$/.test(word)) return true;                       // a count in brackets
    const first = word[0]!;
    if (index === 0) return /[A-Za-z]/.test(first);                   // first word may start either way
    return first === first.toUpperCase() && first !== first.toLowerCase();
  });
}
/** Numbers that carry meaning: percentages, counts, `x of y`, seeds. */
const NUMBER = /(?<![\w.:/-])(?:\d+(?:\.\d+)?%|\(\d+\)|\b\d+\b(?=[^\d]))/g;
/** Brackets that are part of the log prefix, not a plugin name. */
const NOT_PLUGIN = new Set([
  "INFO", "WARN", "WARNING", "ERROR", "SEVERE", "DEBUG", "TRACE", "FATAL",
  "Server thread", "RSLMC",   // the panel's own system lines
]);

/**
 * Splits one plain log line into coloured runs. Returns null when the line has nothing worth
 * colouring, so the caller can render it as a single cheap text node.
 */
export function tintLine(input: string): TintRun[] | null {
  if (!input) return null;
  const runs: TintRun[] = [];
  let rest = input;
  let levelKind: TintKind | undefined;

  const prefix = PREFIX.exec(rest);
  const compact = prefix ? null : PREFIX_COMPACT.exec(rest);
  if (prefix) {
    runs.push({ text: prefix[1]!, kind: "timestamp" });
    runs.push({ text: " ", kind: "text" });
    const bracket = prefix[2]!;
    const level = (prefix[3] ?? "").toUpperCase();
    levelKind = LEVEL_KIND[level];
    // `[Server thread/INFO]` → thread part neutral, level word coloured. The regex captures the
    // thread on its own (the slash is the delimiter), so an empty capture means "no thread shown".
    if (levelKind) {
      runs.push({ text: bracket ? `[${bracket}/` : "[", kind: "thread" });
      runs.push({ text: level, kind: levelKind });
      runs.push({ text: "]", kind: "thread" });
    } else {
      runs.push({ text: `[${bracket}]`, kind: "thread" });
    }
    runs.push({ text: ": ", kind: "thread" });
    rest = rest.slice(prefix[0].length);
  } else if (compact) {
    /*
     * `[14:49:57 INFO]: <message>` — the time and the level share one bracket. This is the format a
     * Spigot/Paper server with plugins actually writes to a pipe, and it used to fall straight
     * through every rule, which is why a whole console of `/help` output rendered as flat grey.
     */
    const levelWord = compact[2]!;
    levelKind = LEVEL_KIND[levelWord.toUpperCase()];
    runs.push({ text: compact[1]!, kind: "timestamp" });          // "[14:49:57"
    runs.push({ text: " ", kind: "text" });
    runs.push({ text: levelWord, kind: levelKind ?? "thread" });
    runs.push({ text: "]", kind: "thread" });
    if (compact[3]) runs.push({ text: compact[3], kind: "thread" });
    rest = rest.slice(compact[0].length);
  } else {
    // Lines from the panel itself ("Starting Paper 1.21.4 on …") start with a capitalised phrase.
    const readyFallback = READY.exec(rest);
    if (readyFallback && readyFallback.index === 0) {
      runs.push({ text: rest, kind: "ready" });
      return runs;
    }
  }

  /*
   * A warning or an error is the line the operator is looking for, so the whole body carries the
   * colour — in a 6 000-line buffer that is the difference between a grey wall and something you can
   * scan. This runs before the per-token rules below, so a warning never dissolves into plugin names
   * and numbers.
   */
  if ((levelKind === "level-warn" || levelKind === "level-error") && rest) {
    runs.push({ text: rest, kind: levelKind });
    return runs;
  }

  // A ready line is the single most useful thing on screen — colour all of it.
  if (READY.test(rest)) {
    runs.push({ text: rest, kind: "ready" });
    return runs;
  }

  const chat = CHAT.exec(rest);
  if (chat) {
    runs.push({ text: "<", kind: "dim" });
    runs.push({ text: chat[1]!, kind: "player" });
    runs.push({ text: ">", kind: "dim" });
    runs.push({ text: rest.slice(chat[0].length), kind: "text" });
    return runs;
  }

  for (const [pattern, kind] of [[JOIN, "join"], [LEAVE, "leave"], [LOST, "lost"]] as const) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const start = match.index;
    runs.push({ text: rest.slice(0, start), kind: "text" });
    runs.push({ text: match[1]!, kind: "player" });
    runs.push({ text: match[2]!, kind });
    runs.push({ text: rest.slice(start + match[0].length), kind: "text" });
    return runs;
  }

  // Plugin / logger brackets (`[ViaVersion]`, `[LuckPerms]`) get their own quiet hue so the source of
  // a line is visible without reading it.
  let cursor = 0;
  PLUGIN.lastIndex = 0;
  let pluginMatch: RegExpExecArray | null;
  while ((pluginMatch = PLUGIN.exec(rest)) !== null) {
    const name = pluginMatch[1]!;
    if (NOT_PLUGIN.has(name)) continue;
    if (pluginMatch.index > cursor) runs.push({ text: rest.slice(cursor, pluginMatch.index), kind: "text" });
    runs.push({ text: pluginMatch[0], kind: "plugin" });
    cursor = pluginMatch.index + pluginMatch[0].length;
  }
  if (cursor > 0) {
    if (cursor < rest.length) runs.push({ text: rest.slice(cursor), kind: "text" });
    return runs;
  }

  // `/tm: A Mojang provided command.` — long `/help` dumps are the worst offenders for grey, so the
  // command name gets the accent and the description stays quiet.
  const command = COMMAND_LIST.exec(rest);
  if (command) {
    runs.push({ text: command[1]!, kind: "command" });
    runs.push({ text: rest.slice(command[1]!.length), kind: "text" });
    return runs;
  }

  // `- ViaBackwards, ViaVersion` — the body of /plugins, one plugin per name.
  const list = PLUGIN_LIST.exec(rest);
  if (list) {
    runs.push({ text: list[1]!, kind: "dim" });
    let at = 0;
    for (const name of list[2]!.matchAll(PLUGIN_LIST_NAME)) {
      const start = name.index ?? 0;
      if (start > at) runs.push({ text: list[2]!.slice(at, start), kind: "dim" });
      runs.push({ text: name[0], kind: "plugin" });
      at = start + name[0].length;
    }
    if (at < list[2]!.length) runs.push({ text: list[2]!.slice(at), kind: "dim" });
    if (list[3]) runs.push({ text: list[3], kind: "dim" });
    return runs;
  }

  if (isHeading(rest)) {
    const trimmed = rest.trim();
    const lead = rest.slice(0, rest.indexOf(trimmed));
    if (lead) runs.push({ text: lead, kind: "text" });
    runs.push({ text: trimmed, kind: "label" });
    return runs;
  }

  const coords = COORDS.exec(rest);
  if (coords) {
    runs.push({ text: rest.slice(0, coords.index), kind: "text" });
    runs.push({ text: coords[0], kind: "coord" });
    runs.push({ text: rest.slice(coords.index + coords[0].length), kind: "text" });
    return runs;
  }

  /*
   * A warning or an error is the line the operator is looking for, so the whole body carries the
   * colour rather than just the level word — in a 6000-line buffer that is the difference between a
   * grey wall and something you can scan.
   */
  // Ordinary INFO chatter: at least lift the figures out of the sentence (counts, percentages,
  // "0 of a max of 20 players", seed numbers) so a line is not one undifferentiated grey.
  let cursor2 = 0;
  NUMBER.lastIndex = 0;
  let numberMatch: RegExpExecArray | null;
  while ((numberMatch = NUMBER.exec(rest)) !== null) {
    if (numberMatch.index > cursor2) runs.push({ text: rest.slice(cursor2, numberMatch.index), kind: "text" });
    runs.push({ text: numberMatch[0], kind: "number" });
    cursor2 = numberMatch.index + numberMatch[0].length;
  }
  if (cursor2 > 0) {
    if (cursor2 < rest.length) runs.push({ text: rest.slice(cursor2), kind: "text" });
    return runs;
  }

  runs.push({ text: rest, kind: "text" });
  // If every run is the same colour there is nothing gained from splitting the line.
  return runs.length > 1 ? runs : null;
}

/* ------------------------- Legacy Minecraft § codes ------------------------- */

/** The 16 colours of the classic palette, as they read on a dark terminal. */
export const SECTION_COLOURS: Record<string, string> = {
  "0": "#4a4f57", "1": "#5b7fd0", "2": "#5ec98a", "3": "#4fb3c4", "4": "#c96a6a",
  "5": "#b183d6", "6": "#d9b45c", "7": "#c8ccd4", "8": "#7b8290", "9": "#7f9ce0",
  a: "#7fd8a2", b: "#79d3dd", c: "#e08a86", d: "#cf9ce8", e: "#eccd7a", f: "#f4f6fa",
};

export interface SectionRun {
  text: string;
  colour?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

/** True when the text carries `§`/`&` formatting codes (plugins and MOTDs use them). */
export function hasSectionCodes(input: string): boolean {
  return /[§&][0-9a-fk-or]/i.test(input);
}

/**
 * Splits text on legacy colour codes. `&` is accepted as well as `§` because a good deal of plugin
 * output is written with the ampersand spelling and reaches the console unconverted.
 */
export function parseSectionCodes(input: string): SectionRun[] {
  const runs: SectionRun[] = [];
  let style: Omit<SectionRun, "text"> = {};
  let buffer = "";
  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...style });
    buffer = "";
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if ((char === "§" || char === "&") && index + 1 < input.length) {
      const code = input[index + 1]!.toLowerCase();
      if (/[0-9a-fk-or]/.test(code)) {
        index += 1;
        flush();
        if (/[0-9a-f]/.test(code)) style = { colour: SECTION_COLOURS[code] };
        else if (code === "l") style = { ...style, bold: true };
        else if (code === "o") style = { ...style, italic: true };
        else if (code === "n") style = { ...style, underline: true };
        else if (code === "m") style = { ...style, strike: true };
        else if (code === "r") style = {};
        // "k" (obfuscated) is not reproducible in text: keep the characters as written.
        continue;
      }
    }
    buffer += char;
  }
  flush();
  return runs;
}
