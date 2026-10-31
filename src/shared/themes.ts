/**
 * Colour themes.
 *
 * One list, used by both sides: the API validates against `THEME_IDS`, and My Profile renders the
 * picker from `THEMES`. A theme only ever changes the *chrome* — surfaces, borders, text and the
 * interface accent. Status colours keep their meaning in every theme (green = running, amber =
 * warning, red = error), so a theme can never make a broken server look healthy.
 *
 * Palette rules: every theme is dark, low-chroma and matte. No neon, no gradients, no glow — the
 * difference between themes is hue and temperature, not saturation.
 */

export interface ThemeSwatch {
  /** Page background. */
  bg: string;
  /** Card surface. */
  surface: string;
  /** Interface accent (active nav, focus ring, toggles, progress). */
  accent: string;
  /** Text colour used on top of the accent pill. */
  onAccent: string;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  /** One short line for the picker. */
  mood: string;
  swatch: ThemeSwatch;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "charcoal",
    label: "Charcoal",
    mood: "The original — neutral graphite with a green accent.",
    swatch: { bg: "#08080a", surface: "#0e0e10", accent: "#3ecf72", onAccent: "#08130d" },
  },
  {
    id: "slate",
    label: "Slate",
    mood: "Cool steel grey for long sessions.",
    swatch: { bg: "#08090b", surface: "#0e1013", accent: "#8c94a4", onAccent: "#0a0b0d" },
  },
  {
    id: "midnight",
    label: "Midnight",
    mood: "Deep blue night watch.",
    swatch: { bg: "#070a11", surface: "#0b0f18", accent: "#5b8fdc", onAccent: "#060a12" },
  },
  {
    id: "ocean",
    label: "Ocean",
    mood: "Teal water, calm and quiet.",
    swatch: { bg: "#05090a", surface: "#0a1011", accent: "#3f9d8f", onAccent: "#050c0b" },
  },
  {
    id: "forest",
    label: "Forest",
    mood: "Mossy green with warm graphite.",
    swatch: { bg: "#060908", surface: "#0a0f0c", accent: "#57a06a", onAccent: "#060d09" },
  },
  {
    id: "ember",
    label: "Ember",
    mood: "Burnt orange, like a furnace at night.",
    swatch: { bg: "#0a0706", surface: "#100c0a", accent: "#c9803f", onAccent: "#12100a" },
  },
  {
    id: "sand",
    label: "Sand",
    mood: "Warm clay and old paper.",
    swatch: { bg: "#0a0906", surface: "#100e0a", accent: "#b8923f", onAccent: "#12100a" },
  },
  {
    id: "crimson",
    label: "Crimson",
    mood: "Brick red, serious and warm.",
    swatch: { bg: "#0a0607", surface: "#100a0b", accent: "#c25b62", onAccent: "#120a0b" },
  },
  {
    id: "rose",
    label: "Rose",
    mood: "Dusty pink without the sugar.",
    swatch: { bg: "#0a0608", surface: "#100a0e", accent: "#c2688a", onAccent: "#120a0d" },
  },
  {
    id: "plum",
    label: "Plum",
    mood: "Berry magenta, night-time and soft.",
    swatch: { bg: "#09060a", surface: "#0f0a10", accent: "#a866b8", onAccent: "#100913" },
  },
  {
    id: "violet",
    label: "Violet",
    mood: "Deep purple with a cool cast.",
    swatch: { bg: "#08060c", surface: "#0d0a12", accent: "#9481d4", onAccent: "#0a0711" },
  },
  {
    id: "graphite",
    label: "Graphite",
    mood: "Almost monochrome — grey accent, no colour at all.",
    swatch: { bg: "#070708", surface: "#0d0d0f", accent: "#c2c6cf", onAccent: "#0a0a0b" },
  },
  {
    id: "neobrutalism",
    label: "Neobrutalism",
    mood: "Hard edges, thick outlines and a mustard accent — flat panels with solid offset shadows.",
    swatch: { bg: "#0a0a0e", surface: "#14141a", accent: "#d9a227", onAccent: "#12100a" },
  },
];

export const DEFAULT_THEME = "charcoal";

export const THEME_IDS: string[] = THEMES.map((theme) => theme.id);

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && THEME_IDS.includes(value);
}

export function themeById(id: string | null | undefined): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}
