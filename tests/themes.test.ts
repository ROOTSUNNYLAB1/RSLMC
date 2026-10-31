import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * Themes: the palette catalogue, the per-account preference, and the two properties that matter —
 * a theme is validated server-side, and it is private to the account that chose it.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "rslmc-theme-"));
process.env.RSLMC_DATA_DIR = DATA_DIR;

let themes: typeof import("../src/shared/themes");
let bootstrap: typeof import("../src/services/bootstrap");
let db: typeof import("../src/database");
let auth: typeof import("../src/auth");

beforeAll(async () => {
  bootstrap = await import("../src/services/bootstrap");
  themes = await import("../src/shared/themes");
  db = await import("../src/database");
  auth = await import("../src/auth");
  await bootstrap.bootstrap();
});

describe("catalogue", () => {
  test("every theme is complete and uniquely named", () => {
    expect(themes.THEMES.length).toBeGreaterThanOrEqual(10);
    const ids = new Set<string>();
    for (const theme of themes.THEMES) {
      expect(ids.has(theme.id)).toBe(false);
      ids.add(theme.id);
      expect(theme.id).toMatch(/^[a-z]+$/);
      expect(theme.label.length).toBeGreaterThan(2);
      expect(theme.mood.length).toBeGreaterThan(10);
      for (const colour of Object.values(theme.swatch)) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("the default theme exists and unknown ids fall back to it", () => {
    expect(themes.THEME_IDS).toContain(themes.DEFAULT_THEME);
    expect(themes.themeById(null).id).toBe(themes.DEFAULT_THEME);
    expect(themes.themeById("does-not-exist").id).toBe(themes.DEFAULT_THEME);
    expect(themes.isThemeId("midnight")).toBe(true);
    expect(themes.isThemeId("Midnight")).toBe(false);
    expect(themes.isThemeId("<script>")).toBe(false);
    expect(themes.isThemeId(null)).toBe(false);
  });

  /**
   * "No neon" is a design rule, so it is asserted rather than trusted: every accent and surface
   * stays inside a restrained saturation/lightness band, and every background stays dark enough
   * that white-ish body text keeps a comfortable contrast.
   */
  const toHsl = (hex: string): { h: number; s: number; l: number } => {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let hue = 0;
    if (d !== 0) {
      if (max === r) hue = ((g - b) / d) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return { h: hue, s, l };
  };

  const luminance = (hex: string): number => {
    const h = hex.replace("#", "");
    const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const r = channel(parseInt(h.slice(0, 2), 16) / 255);
    const g = channel(parseInt(h.slice(2, 4), 16) / 255);
    const b = channel(parseInt(h.slice(4, 6), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  test("no theme is neon: accents stay muted and backgrounds stay dark", () => {
    for (const theme of themes.THEMES) {
      const accent = toHsl(theme.swatch.accent);
      expect(accent.s).toBeLessThan(0.72);      // a neon accent would sit near 0.9+
      expect(accent.l).toBeGreaterThan(0.3);    // readable, not a black smudge
      expect(accent.l).toBeLessThan(0.88);      // never a glowing white slab
      const bg = toHsl(theme.swatch.bg);
      expect(bg.l).toBeLessThan(0.06);          // every theme is genuinely dark
      const surface = toHsl(theme.swatch.surface);
      expect(surface.l).toBeLessThan(0.1);
    }
  });

  test("an accent always reads on its own background", () => {
    for (const theme of themes.THEMES) {
      // Active navigation uses the accent as a background with dark ink on top, so the pair has to
      // clear WCAG AA for large text at minimum (3:1) — most of them are well past 4.5:1.
      expect(contrast(theme.swatch.accent, theme.swatch.onAccent)).toBeGreaterThan(4);
      // …and the accent itself must be visible against the page and card surfaces.
      expect(contrast(theme.swatch.accent, theme.swatch.bg)).toBeGreaterThan(3);
      expect(contrast(theme.swatch.accent, theme.swatch.surface)).toBeGreaterThan(3);
    }
  });
});

/**
 * Every theme is only real if the stylesheet implements it — a catalogue entry without a
 * `[data-theme="…"]` block renders as the default and looks like a broken picker.
 */
describe("stylesheet", () => {
  test("each theme in the catalogue has its own token block", async () => {
    const css = await Bun.file("frontend/styles.css").text();
    for (const id of themes.THEME_IDS) {
      if (id === themes.DEFAULT_THEME) continue;      // charcoal lives in :root
      expect(css.includes(`[data-theme="${id}"] {`)).toBe(true);
    }
  });

  test("neobrutalism is a real theme, not just a colour swap", async () => {
    const neo = themes.themeById("neobrutalism");
    expect(neo.id).toBe("neobrutalism");
    expect(neo.label).toBe("Neobrutalism");
    expect(themes.THEME_IDS).toContain("neobrutalism");
    const css = await Bun.file("frontend/styles.css").text();
    // thick outlines, square corners and a hard offset shadow — the three things that make it read
    // as neobrutalist rather than as another dark palette
    const start = css.indexOf('[data-theme="neobrutalism"] {');
    expect(start).toBeGreaterThan(0);
    const head = css.slice(start, css.indexOf("}", start));
    expect(head).toContain("--radius: 0px");
    expect(css).toContain('[data-theme="neobrutalism"] .btn-primary');
    expect(css).toContain("var(--nb-shadow)");   // the solid offset shadow that defines the theme
    // The nav pill spans the sidebar's padded column (width:100%); a side margin here used to push
    // the active item past the sidebar edge and over the page content.
    const navRule = /\[data-theme="neobrutalism"\] \.nav-item \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const navMargin = /margin:\s*([^;}]+)/.exec(navRule)?.[1]?.trim() ?? "";
    // horizontal margin must be 0 (a side inset here is what pushed the pill past the sidebar)
    const [, horizontal] = navMargin.split(/\s+(?=\S+$)/);
    expect(navMargin === "" || horizontal === "0").toBe(true);
    // …and it must not restyle status colours, or a RUNNING server would stop being green
    expect(head).not.toContain("--green:");
    expect(head).not.toContain("--red:");
  });
});

describe("per-account preference", () => {
  test("new accounts start on the default theme", () => {
    const row = db.queryOne<{ theme: string }>("SELECT theme FROM users WHERE username = 'admin'")!;
    expect(row.theme).toBe(themes.DEFAULT_THEME);
    const admin = auth.findUserByUsername("admin")!;
    expect(auth.publicUser(admin).theme).toBe(themes.DEFAULT_THEME);
  });

  test("a chosen theme is stored and comes back on the next read", () => {
    db.run("UPDATE users SET theme = 'midnight' WHERE username = 'admin'");
    const admin = auth.findUserByUsername("admin")!;
    expect(auth.publicUser(admin).theme).toBe("midnight");
    db.run("UPDATE users SET theme = 'charcoal' WHERE username = 'admin'");
  });

  test("one account's theme never leaks into another's session payload", () => {
    const first = db.insert("INSERT INTO users (username, password_hash, is_root, disabled, theme) VALUES ('theme-a', 'x', 0, 0, 'rose')");
    const second = db.insert("INSERT INTO users (username, password_hash, is_root, disabled, theme) VALUES ('theme-b', 'x', 0, 0, 'ocean')");
    expect(auth.publicUser(auth.findUserById(first)!).theme).toBe("rose");
    expect(auth.publicUser(auth.findUserById(second)!).theme).toBe("ocean");
  });

  test("an unknown value stored in the column still renders as a valid theme", () => {
    const id = db.insert("INSERT INTO users (username, password_hash, is_root, disabled, theme) VALUES ('theme-bad', 'x', 0, 0, 'neon-overdrive')");
    const user = auth.publicUser(auth.findUserById(id)!);
    // The API hands back whatever is stored; the client falls back, and themeById() never throws.
    expect(themes.themeById(user.theme).id).toBe(themes.DEFAULT_THEME);
  });
});
