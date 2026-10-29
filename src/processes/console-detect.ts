/**
 * Player detection from raw server console lines.
 *
 * Console output can carry colour codes (`\u001b[38;5;85m`, or the de-escaped leftover `[38;5;85m`
 * when an upstream capture path already ate the escape byte). If the detector reads those raw, the
 * digit/`m` tail of the sequence glues itself onto the player name and the panel stores
 * `85mSUNNYGAMINGPE` instead of `SUNNYGAMINGPE`. So: strip colours first, then only accept a
 * whole-name token — the character before it may not be a username character.
 */

const ANSI_SEQUENCE = /(?:\u001b\[[0-9;?]*[ -/]*[@-~])|(?:\[[0-9;]{1,15}m)/g;

/** Removes ANSI escape sequences (and their de-escaped leftovers) from a console line. */
export function stripConsoleColours(line: string): string {
  return line.replace(ANSI_SEQUENCE, " ");
}

const NAME = "([A-Za-z0-9_]{2,16})";
const JOIN_PATTERN = new RegExp(`(?:^|[^A-Za-z0-9_])[[(<]?${NAME}[)\\]>]?\\s+joined the game\\b`);
const LEAVE_PATTERN = new RegExp(`(?:^|[^A-Za-z0-9_])[[(<]?${NAME}[)\\]>]?\\s+left the game\\b`);
const LOST_PATTERN = new RegExp(`(?:^|[^A-Za-z0-9_])[[(<]?${NAME}[)\\]>]?\\s+lost connection\\b`);

/** Name from a "joined the game" line, or null. */
export function playerJoinName(line: string): string | null {
  return JOIN_PATTERN.exec(stripConsoleColours(line))?.[1] ?? null;
}

/** Name from a "left the game" / "lost connection" line, or null. */
export function playerLeaveName(line: string): string | null {
  const clean = stripConsoleColours(line);
  return (LEAVE_PATTERN.exec(clean) ?? LOST_PATTERN.exec(clean))?.[1] ?? null;
}
