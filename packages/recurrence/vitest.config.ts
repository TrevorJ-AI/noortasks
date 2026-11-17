import { defineConfig } from "vitest/config";

// Tests must never depend on the machine zone: force an odd non-UTC zone.
process.env.TZ = "Pacific/Auckland";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], pool: "forks", poolOptions: { forks: { singleFork: true } } },
});
