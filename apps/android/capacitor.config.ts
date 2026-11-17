import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.noortasks",
  appName: "NoorTasks",
  // Native bridge calls include cookies and the handoff verifier, even in debug builds.
  loggingBehavior: "none",
  webDir: "../web/dist",
  android: {
    allowMixedContent: true,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    CapacitorCookies: {
      enabled: true,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_noortasks",
      iconColor: "#2f6f5e",
    },
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#2f6f5e",
    },
  },
};

export default config;
