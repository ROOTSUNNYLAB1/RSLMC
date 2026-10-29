import { Fragment, memo, useMemo } from "react";

/**
 * ANSI/SGR parser for the console.
 *
 * Minecraft (Paper/Purpur/Spigot) prints coloured log lines with SGR escape sequences —
 * `\u001b[38;2;52;159;218m` for truecolor, `\u001b[0;32m` for the classic palette. Piping stdout
 * through a pipe does not always stop that, and some capture paths drop the ESC byte while keeping
 * `[38;2;…m`, so both spellings are parsed here. Anything that is not SGR (cursor moves, OSC
 * titles) is removed instead of being printed as mojibake.
 */

export interface AnsiStyle {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const ESC = "\u001b";

/** xterm's first 16 colours. */
const BASE = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function colour256(index: number): string | undefined {
  if (!Number.isFinite(index) || index < 0) return undefined;
  if (index < 16) return BASE[index];
  if (index < 232) {
    const value = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(value / 36) % 6]!;
    const g = steps[Math.floor(value / 6) % 6]!;
    const b = steps[value % 6]!;
    return rgbToHex(r, g, b);
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10;
    return rgbToHex(level, level, level);
  }
  return undefined;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[r, g, b].map((value) => clamp(value).toString(16).padStart(2, "0")).join("")}`;
}

/** Applies one SGR parameter list to the running style and returns the new style. */
function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  let next: AnsiStyle = { ...style };
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]!;
    if (code === 0) { next = {}; continue; }
    if (code === 1) { next.bold = true; next.dim = false; continue; }
    if (code === 2) { next.dim = true; next.bold = false; continue; }
    if (code === 3) { next.italic = true; continue; }
    if (code === 4) { next.underline = true; continue; }
    if (code === 7) { next.inverse = true; continue; }
    if (code === 9) { next.strike = true; continue; }
    if (code === 21 || code === 22) { next.bold = false; next.dim = false; continue; }
    if (code === 23) { next.italic = false; continue; }
    if (code === 24) { next.underline = false; continue; }
    if (code === 27) { next.inverse = false; continue; }
    if (code === 29) { next.strike = false; continue; }
    if (code >= 30 && code <= 37) { next.color = BASE[code - 30]; continue; }
    if (code === 39) { delete next.color; continue; }
    if (code >= 40 && code <= 47) { next.background = BASE[code - 40]; continue; }
    if (code === 49) { delete next.background; continue; }
    if (code >= 90 && code <= 97) { next.color = BASE[code - 90 + 8]; continue; }
    if (code >= 100 && code <= 107) { next.background = BASE[code - 100 + 8]; continue; }
    if (code === 38 || code === 48) {
      const target = code === 38 ? "color" : "background";
      const mode = params[index + 1];
      if (mode === 5) {
        const colour = colour256(params[index + 2] ?? -1);
        if (colour) next[target] = colour;
        index += 2;
        continue;
      }
      if (mode === 2) {
        const colour = rgbToHex(params[index + 2] ?? 0, params[index + 3] ?? 0, params[index + 4] ?? 0);
        next[target] = colour;
        index += 4;
        continue;
      }
      continue;
    }
  }
  return next;
}

/**
 * Matches: real CSI/OSC escapes, plus the ESC-less `[0;32m` / `[38;2;1;2;3m` form that survives
 * when a capture pipeline strips the ESC byte.
 */
const ANSI_PATTERN = new RegExp(
  [
    `${ESC}\\[[0-9;?]*[ -/]*[@-~]`,              // CSI (SGR, cursor, erase…)
    `${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)?`, // OSC (window title…)
    `${ESC}[@-Z\\\\-_]`,                          // two-byte escapes
    "\\[(?=[0-9;]*m)[0-9;]+m",                    // ESC-stripped SGR
    "\\[m",                                       // ESC-stripped reset
  ].join("|"),
  "g",
);

const SGR_ONLY = new RegExp(`^(?:${ESC}\\[|\\[)([0-9;]*)m$`);

function isSgr(sequence: string): boolean {
  return SGR_ONLY.test(sequence);
}

function sgrParams(sequence: string): number[] {
  const match = SGR_ONLY.exec(sequence);
  if (!match) return [];
  const raw = match[1] ?? "";
  if (raw.trim() === "") return [0];
  return raw.split(";").map((part) => (part === "" ? 0 : Number(part)));
}

/** Splits one line into styled runs. Lines without escapes come back as a single run. */
export function parseAnsi(input: string): AnsiSegment[] {
  if (!input.includes(ESC) && !/\[[0-9;]*m/.test(input)) return [{ text: input, style: {} }];
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let cursor = 0;
  ANSI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  const push = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && sameStyle(last.style, style)) last.text += text;
    else segments.push({ text, style });
  };
  while ((match = ANSI_PATTERN.exec(input)) !== null) {
    if (match.index > cursor) push(input.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (isSgr(match[0])) style = applySgr(style, sgrParams(match[0]));
  }
  if (cursor < input.length) push(input.slice(cursor));
  return segments.length > 0 ? segments : [{ text: "", style: {} }];
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return a.color === b.color && a.background === b.background && a.bold === b.bold
    && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline
    && a.strike === b.strike && a.inverse === b.inverse;
}

/** Plain text for the clipboard / log download — escape codes removed. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

const cache = new Map<string, AnsiSegment[]>();
const CACHE_LIMIT = 1200;

function parseCached(text: string): AnsiSegment[] {
  const hit = cache.get(text);
  if (hit) return hit;
  const parsed = parseAnsi(text);
  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(text, parsed);
  return parsed;
}

function cssFor(style: AnsiStyle): React.CSSProperties | undefined {
  if (Object.keys(style).length === 0) return undefined;
  const css: React.CSSProperties = {};
  let color = style.color;
  let background = style.background;
  if (style.inverse) {
    color = style.background ?? "var(--console-bg, #0b0b0e)";
    background = style.color ?? "#e6e6e6";
  }
  if (color) css.color = color;
  if (background) css.backgroundColor = background;
  if (style.bold) css.fontWeight = 600;
  if (style.dim) css.opacity = 0.65;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline || style.strike) {
    css.textDecoration = [style.underline ? "underline" : null, style.strike ? "line-through" : null]
      .filter(Boolean).join(" ");
  }
  return css;
}

function highlight(text: string, needle: string) {
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

/**
 * Renders one console line with its ANSI colours. Memoised on the raw text so a live stream does
 * not re-parse the whole visible buffer on every batch.
 */
export const AnsiText = memo(function AnsiText({ text, search = "" }: { text: string; search?: string }) {
  const segments = useMemo(() => parseCached(text), [text]);
  if (segments.length === 1 && Object.keys(segments[0]!.style).length === 0) {
    return <>{highlight(segments[0]!.text, search)}</>;
  }
  return (
    <>
      {segments.map((segment, index) => {
        const css = cssFor(segment.style);
        if (!css) return <Fragment key={index}>{highlight(segment.text, search)}</Fragment>;
        return (
          <span key={index} style={css} className="ansi">
            {highlight(segment.text, search)}
          </span>
        );
      })}
    </>
  );
});
