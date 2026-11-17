/**
 * Theme table. NoorTasks' own palettes; stored `theme` IDs (color, city, season, photo) are preserved for
 * settings compatibility, rendered with our own tinted swatches rather than external artwork or photos.
 * palettes, not photos).
 */
export interface ThemeDef {
  id: string;
  label: string;
  base: "light" | "dark";
  accent: string;
  /** sidebar and rail tint */
  side?: string;
  bg?: string;
  series: "color" | "dark" | "city" | "season" | "photo";
  /** season and photo themes: `/themes/<id>-thumb.webp` in the picker, `/themes/<id>-bg.webp` behind the app */
  image?: boolean;
}

/** The house theme: true black with the logo amber as the only accent. New accounts start here. */
export const DEFAULT_THEME = "night";

const DARK_PHOTOS = new Set(["bw", "greenery", "dawn"]);

export const THEMES: ThemeDef[] = [
  { id: "noor", label: "Noor Black", base: "dark", accent: "#E9B22E", bg: "#000000", side: "#000000", series: "color" },
  { id: "default", label: "Default", base: "light", accent: "#2f6f5e", series: "color" },
  { id: "sky", label: "Sky", base: "light", accent: "#3b8fd9", side: "#e8f2fb", series: "color" },
  { id: "turquoise", label: "Turquoise", base: "light", accent: "#1aa5a5", side: "#e3f5f4", series: "color" },
  { id: "teal", label: "Teal", base: "light", accent: "#23806f", side: "#e2f0ec", series: "color" },
  { id: "matcha", label: "Matcha", base: "light", accent: "#6a9a3a", side: "#eef4e3", series: "color" },
  { id: "sunshine", label: "Sunshine", base: "light", accent: "#d39a12", side: "#fbf3dc", series: "color" },
  { id: "peach", label: "Peach", base: "light", accent: "#e0765c", side: "#fcebe5", series: "color" },
  { id: "lilac", label: "Lilac", base: "light", accent: "#8c6bd6", side: "#f0eafb", series: "color" },
  { id: "ebony", label: "Ebony", base: "light", accent: "#5a4a3c", side: "#efe9e2", series: "color" },
  { id: "navy", label: "Navy", base: "light", accent: "#2d3f7c", side: "#e5e8f3", series: "color" },
  { id: "gray", label: "Gray", base: "light", accent: "#5f6368", side: "#eceded", series: "color" },
  // the Accent Colors "Dark" swatch is the night theme
  { id: "night", label: "Dark", base: "dark", accent: "#E9B22E", bg: "#1c1c1c", side: "#1c1c1c", series: "color" },
  { id: "dark", label: "Dark", base: "dark", accent: "#E9B22E", series: "alias" as never },
  { id: "darkcyan", label: "Cyan", base: "dark", accent: "#2bb3c0", series: "dark" },
  { id: "darkgreen", label: "Green", base: "dark", accent: "#3fb07a", series: "dark" },
  { id: "darkyellow", label: "Yellow", base: "dark", accent: "#d9a520", series: "dark" },
  { id: "darkpink", label: "Pink", base: "dark", accent: "#e0679a", series: "dark" },
  { id: "darkpurple", label: "Purple", base: "dark", accent: "#9b7cf0", series: "dark" },
  { id: "darkcustom", label: "Custom", base: "dark", accent: "#E9B22E", series: "dark" },
  ...(
    [
      ["cairo", "Cairo", "#c8893c"],
      ["london", "London", "#5d6f86"],
      ["losangeles", "Los Angeles", "#e48a4a"],
      ["moscow", "Moscow", "#b0413e"],
      ["newyork", "New York", "#3f5a78"],
      ["sanfrancisco", "San Francisco", "#d0623a"],
      ["seoul", "Seoul", "#7a63b8"],
      ["shanghai", "Shanghai", "#c4473d"],
      ["sydney", "Sydney", "#2a8bb5"],
      ["tokyo", "Tokyo", "#d0507a"],
    ] as const
  ).map(([id, label, accent]) => ({ id, label, base: "light" as const, accent, side: `color-mix(in srgb, ${accent} 12%, #ffffff)`, series: "city" as const })),
  ...(
    [
      ["spring", "Spring", "#5aa66b"],
      ["summer", "Summer", "#e2a21b"],
      ["autumn", "Autumn", "#c0652a"],
      ["winter", "Winter", "#5b8bb8"],
    ] as const
  ).map(([id, label, accent]) => ({ id, label, base: "light" as const, accent, side: `color-mix(in srgb, ${accent} 12%, #ffffff)`, series: "season" as const, image: true })),
  ...(
    [
      ["architecture", "Architecture", "#6c7480"],
      ["bw", "B & W", "#c9c9c9"],
      ["desert", "Desert", "#c08a4a"],
      ["greenery", "Greenery", "#6fbf55"],
      ["swallow", "Swallow", "#3b8a8a"],
      ["dawn", "Dawn", "#f0956a"],
      ["blossom", "Blossom", "#d070a0"],
      ["frozen", "Frozen", "#5aa0c8"],
      ["meadow", "Meadow", "#7aa040"],
      ["silence", "Silence", "#7d7a8c"],
    ] as const
  ).map(([id, label, accent]) =>
    // the dark photographs get the dark base so text stays light on them
    DARK_PHOTOS.has(id)
      ? { id, label, base: "dark" as const, accent, series: "photo" as const, image: true }
      : { id, label, base: "light" as const, accent, side: `color-mix(in srgb, ${accent} 10%, #ffffff)`, series: "photo" as const, image: true },
  ),
];

/**
 * Stored theme id to the id that renders. An unset theme renders the default (the classic dark theme, "night").
 * Noor Black is one of the choices in Settings > Appearance. Picking a theme stores `themeChosen`.
 */
export function resolveThemeId(theme: string | undefined, chosen: boolean | undefined): string {
  if (!theme) return DEFAULT_THEME;
  return theme;
}

export function effectiveTheme(theme: string | undefined, autoDark: boolean, darkTheme: string | undefined, prefersDark: boolean, chosen?: boolean): ThemeDef {
  const id = autoDark && prefersDark ? darkTheme || DEFAULT_THEME : resolveThemeId(theme, chosen);
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

export function applyTheme(t: ThemeDef, opts: { customDark?: string; fontSize?: string; zoom?: number; style?: string }): void {
  const root = document.documentElement;
  root.dataset.theme = t.id;
  root.dataset.base = t.base;
  root.dataset.style = opts.style ?? "flat";
  root.dataset.font = opts.fontSize ?? "normal";
  const accent = t.id === "darkcustom" && opts.customDark ? opts.customDark : t.accent;
  root.style.setProperty("--accent", accent);
  if (t.side) root.style.setProperty("--side-bg", t.side);
  else root.style.removeProperty("--side-bg");
  if (t.bg) root.style.setProperty("--bg", t.bg);
  else root.style.removeProperty("--bg");
  root.style.setProperty("--zoom", String(opts.zoom ?? 1));
  if (t.image) {
    root.dataset.image = t.id;
    root.style.setProperty("--theme-image", `url("/themes/${t.id}-bg.webp")`);
  } else {
    delete root.dataset.image;
    root.style.removeProperty("--theme-image");
  }
  try {
    localStorage.setItem("appTheme", t.id);
    localStorage.setItem("appBase", t.base);
  } catch {
    /* ignore */
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bg ?? (t.base === "dark" ? "#1f1f1f" : "#ffffff"));
}

/**
 * Ink for glyphs drawn on a user colour (habit, calendar event): white, or near-black when white would not read
 * (under 3:1, e.g. yellows and light oranges). No colour means the accent, which has its own `--on-accent`.
 */
export function inkOn(color: string | null | undefined): string {
  if (!color || color.startsWith("var(")) return "var(--on-accent)";
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());
  if (!m) return "#fff";
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const lin = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return 1.05 / (lum + 0.05) < 3 ? "#0a0a0c" : "#fff";
}
