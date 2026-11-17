import { defineRailway, image, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // Change region to your nearest Railway region (and raise sizeMB if you upgrade from the 0.5 GB Free cap).
  const dataVolume = volume("noortasks-data", {
    region: "us-west2",
    sizeMB: 512,
  });

  const noortasks = service("noortasks", {
    source: image("ghcr.io/trevorj-ai/noortasks:latest", {
      autoUpdates: { type: "patch" },
    }),
    healthcheckPath: "/healthz",
    healthcheckTimeout: 100,
    env: {
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8099",
      // Railway mounts persistent volumes as root; UID 0 lets the entrypoint write to /data.
      RAILWAY_RUN_UID: "0",
      NOORTASKS_DB: "/data/noortasks.sqlite",
      NOORTASKS_DATA_DIR: "/data/files",
      NOORTASKS_CONFIG: "/data/config.json",
      NOORTASKS_STATIC_DIR: "/app/apps/web/dist",
      NOORTASKS_SECURE_COOKIES: "true",
      NOORTASKS_TRUST_PROXY: "true",
      // Optional: enable built-in daily backups or Web Push VAPID generation
      // NOORTASKS_DAILY_BACKUP: "true",
      // NOORTASKS_VAPID_FILE: "/data/vapid.json",
      // NOORTASKS_AUTO_VAPID: "true",
      // NOORTASKS_VAPID_SUBJECT: "mailto:admin@example.com",
      TZ: "UTC",
    },
    volumeMounts: {
      "/data": dataVolume,
    },
  });

  return project("noortasks", {
    resources: [noortasks, dataVolume],
  });
});
