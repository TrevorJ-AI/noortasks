import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import capConfig from "../capacitor.config";

const ANDROID_DIR = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(ANDROID_DIR, "../..");
const MAIN_DIR = resolve(ANDROID_DIR, "android/app/src/main");

describe("NoorTasks Android package", () => {
  it("configures Capacitor for app.noortasks with native HTTP and cookies", () => {
    expect(capConfig.appId).toBe("app.noortasks");
    expect(capConfig.appName).toBe("NoorTasks");
    expect(capConfig.webDir).toBe("../web/dist");
    expect(capConfig.plugins?.CapacitorHttp?.enabled).toBe(true);
    expect(capConfig.plugins?.CapacitorCookies?.enabled).toBe(true);
    expect(capConfig.plugins?.LocalNotifications?.smallIcon).toBe("ic_stat_noortasks");
  });

  it("declares share target, quick-add tile, shortcuts, widget, and notifications in AndroidManifest.xml", () => {
    const manifest = readFileSync(resolve(MAIN_DIR, "AndroidManifest.xml"), "utf8");
    expect(manifest).toContain("android.intent.action.SEND");
    expect(manifest).toContain("android.app.shortcuts");
    expect(manifest).toContain("android:name=\".NoorQuickAddTileService\"");
    expect(manifest).toContain("BIND_QUICK_SETTINGS_TILE");
    expect(manifest).toContain("TodayWidgetProvider");
    expect(manifest).toContain("TodayWidgetService");
    expect(manifest).toContain("android.permission.CAMERA");
    expect(manifest).toContain("android.permission.POST_NOTIFICATIONS");

    const buildGradle = readFileSync(resolve(ANDROID_DIR, "android/app/capacitor.build.gradle"), "utf8");
    expect(buildGradle).toContain(":capacitor-barcode-scanner");

    const strings = readFileSync(resolve(MAIN_DIR, "res/values/strings.xml"), "utf8");
    expect(strings).toContain("<string name=\"app_name\">NoorTasks</string>");
    expect(strings).toContain("<string name=\"package_name\">app.noortasks</string>");
  });

  it("includes generated NoorTasks adaptive icons and native Java classes with no legacy branding strings", () => {
    const iconBg = readFileSync(resolve(MAIN_DIR, "res/values/ic_launcher_background.xml"), "utf8");
    expect(iconBg).toContain("#E9B22E");
    expect(existsSync(resolve(MAIN_DIR, "res/mipmap-anydpi-v26/ic_launcher.xml"))).toBe(true);
    expect(existsSync(resolve(MAIN_DIR, "res/mipmap-xxxhdpi/ic_launcher_foreground.png"))).toBe(true);
    expect(existsSync(resolve(MAIN_DIR, "res/mipmap-xxxhdpi/ic_launcher_monochrome.png"))).toBe(true);
    expect(existsSync(resolve(MAIN_DIR, "res/drawable/ic_stat_noortasks.xml"))).toBe(true);
    expect(existsSync(resolve(MAIN_DIR, "res/drawable-v24/ic_launcher_foreground.xml"))).toBe(false);

    for (const file of [
      "java/app/noortasks/MainActivity.java",
      "java/app/noortasks/NoorNativePlugin.java",
      "java/app/noortasks/NoorQuickAddTileService.java",
      "java/app/noortasks/TodayWidgetProvider.java",
      "java/app/noortasks/TodayWidgetService.java",
    ]) {
      expect(existsSync(resolve(MAIN_DIR, file))).toBe(true);
    }

    const combined = [
      readFileSync(resolve(MAIN_DIR, "AndroidManifest.xml"), "utf8"),
      readFileSync(resolve(MAIN_DIR, "res/values/strings.xml"), "utf8"),
      readFileSync(resolve(MAIN_DIR, "java/app/noortasks/NoorNativePlugin.java"), "utf8"),
    ].join("\n").toLowerCase();
    expect(combined).not.toContain("tick" + "tick");
    expect(combined).not.toContain("dida" + "365");
  });

  it("covers all 77 M6 checklist IDs in M6-COVERAGE.md", () => {
    const expectedIds = [
      "TASK-079", "TASK-114", "LIST-021", "QADD-022", "QADD-143", "RMD-036", "KANB-014", "CAL-016",
      "CAL-023", "CAL-024", "CAL-025", "MTRX-021", "HAB-032", "FOC-016", "FOC-032", "FOC-034",
      "FOC-035", "FOC-039", "FOC-040", "NOTE-028", "TPL-005", "NTF-017", "NTF-018", "THEME-015",
      "THEME-022", "THEME-026", "SET-032", "SET-181", "SET-194", "SET-195", "SET-196", "SET-197",
      "SET-198", "SET-200", "SET-201", "SET-202", "SET-206", "SET-207", "SET-210", "SET-211",
      "SET-216", "SET-221", "SET-225", "SET-229", "AND-001", "AND-002", "AND-003", "AND-004",
      "AND-005", "AND-006", "AND-007", "AND-008", "AND-009", "AND-010", "AND-011", "AND-012",
      "AND-013", "AND-015", "AND-016", "AND-017", "AND-021", "AND-022", "AND-023", "AND-024",
      "AND-026", "AND-027", "AND-028", "AND-029", "AND-030", "AND-031", "AND-032", "AND-033",
      "AND-034", "AND-035", "AND-036", "AND-037", "AND-038",
    ];
    expect(expectedIds).toHaveLength(77);

    const cov = readFileSync(resolve(ANDROID_DIR, "M6-COVERAGE.md"), "utf8");
    const tableIds = cov
      .split(/\r?\n/)
      .map((line) => /^\|\s*([A-Z]+-\d+)\s*\|\s*[^|]+\|\s*(done|partial|not done)\s*\|/.exec(line)?.[1])
      .filter((id): id is string => !!id);

    expect(tableIds).toHaveLength(77);
    expect(new Set(tableIds)).toEqual(new Set(expectedIds));
    const counts = { done: 0, partial: 0, "not done": 0 };
    for (const line of cov.split(/\r?\n/)) {
      const m = /^\|\s*[A-Z]+-\d+\s*\|\s*[^|]+\|\s*(done|partial|not done)\s*\|/.exec(line);
      if (m) counts[m[1] as keyof typeof counts]++;
    }
    expect(cov).toContain(`Summary: 77 rows. Done ${counts.done}, partial ${counts.partial}, not done ${counts["not done"]}.`);
  });
});
