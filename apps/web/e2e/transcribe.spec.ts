import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { api, inboxId, oid } from "./seed";

function synthWavBytes(): number[] {
  const sampleRate = 8000;
  const numSamples = 800; // 100ms silence
  const buf = Buffer.alloc(44 + numSamples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + numSamples * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(numSamples * 2, 40);
  return Array.from(buf);
}

const FORBIDDEN_PORTS = new Set([18741, 8206, 8207, 4373]);

async function allocatePort(): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const p = await new Promise<number>((ok, fail) => {
      const s = createTcpServer();
      s.on("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => ok(port));
      });
    });
    if (!FORBIDDEN_PORTS.has(p)) return p;
  }
  throw new Error("Could not allocate a free port");
}

async function jsonReq<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

test("unconfigured server hides audio AI controls and shows Not configured in Settings > Features", async ({ page }) => {
  const pid = await inboxId();
  const tid = oid();
  await api("POST", "/api/v2/batch/task", {
    add: [{ id: tid, projectId: pid, title: "Unconfigured AI audio test", kind: "TEXT", status: 0, sortOrder: 0, tags: [], items: [], reminders: [], exDate: [] }],
  });

  try {
    await page.goto("/#q/all/tasks?modalType=settings&tabs=feature");
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByTestId("feature-ai-row")).toContainText("AI transcription");
    await expect(page.getByTestId("feature-ai-status")).toHaveText("Not configured");
    await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });

    await page.goto(`/#p/${pid}/tasks/${tid}`);
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    const bytes = synthWavBytes();
    await page.evaluate((wav) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(wav)], "memo.wav", { type: "audio/wav" }));
      const pane = document.querySelector("[data-testid=detail-pane]")!;
      for (const type of ["dragenter", "dragover", "drop"]) {
        pane.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    }, bytes);

    await expect(page.getByTestId("attachment")).toBeVisible();
    await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("att-ai-btn")).toHaveCount(0);
    await expect(page.getByTestId("att-more-btn")).toHaveCount(0);
  } finally {
    await api("POST", "/api/v2/batch/task", { delete: [{ taskId: tid, projectId: pid }] }).catch(() => {});
  }
});

test("configured server with mock Groq: transcribe, progress state, summary, copy, description, subtasks, and reload cache", async ({ browser }) => {
  const staticDir = resolve(process.cwd(), "dist");
  if (!existsSync(join(staticDir, "index.html"))) {
    throw new Error(`Missing built web bundle at ${staticDir}; run vite build before e2e`);
  }

  let sttCalls = 0;
  let sumCalls = 0;
  let lastAuth = "";
  let lastTranscriptModel = "";
  let lastSummarizeModel = "";

  const mockGroq = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    lastAuth = String(req.headers.authorization ?? "");

    if (req.url === "/openai/v1/audio/transcriptions" && req.method === "POST") {
      sttCalls++;
      const textBody = raw.toString("utf8");
      const m = /name="model"\r?\n\r?\n([^\r\n]+)/.exec(textBody);
      if (m) lastTranscriptModel = m[1]!;
      // Brief simulated latency so the progress state renders visibly in the UI.
      await new Promise((r) => setTimeout(r, 220));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "Standup update: latency dropped and release ships Friday.", language: "en" }));
      return;
    }

    if (req.url === "/openai/v1/chat/completions" && req.method === "POST") {
      sumCalls++;
      const parsed = JSON.parse(raw.toString("utf8")) as { model?: string };
      lastSummarizeModel = parsed.model ?? "";
      await new Promise((r) => setTimeout(r, 150));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  keyPoints: ["Latency dropped after optimization"],
                  decisions: ["Ship release on Friday"],
                  actionItems: ["Prepare release notes", "Notify QA team"],
                }),
              },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unhandled mock Groq route" } }));
  });

  await new Promise<void>((ok) => mockGroq.listen(0, "127.0.0.1", ok));
  const mockPort = (mockGroq.address() as AddressInfo).port;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  const appPort = await allocatePort();
  const appBase = `http://127.0.0.1:${appPort}`;
  const dir = mkdtempSync(join(tmpdir(), "nt-e2e-ai-"));
  const cfgPath = join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      ai: {
        provider: "groq",
        apiKey: "gsk_e2e_test",
        baseUrl: `${mockBase}/openai/v1`,
      },
    }),
  );

  const tsxBin = resolve(process.cwd(), "../server/node_modules/.bin/tsx");
  const serverEntry = resolve(process.cwd(), "../server/src/main.ts");
  const logs: string[] = [];
  const child = spawn(tsxBin, [serverEntry, "--no-auth"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(appPort),
      NOORTASKS_DB: join(dir, "db.sqlite"),
      NOORTASKS_DATA_DIR: join(dir, "files"),
      NOORTASKS_CONFIG: cfgPath,
      NOORTASKS_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));

  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await expect
      .poll(
        async () => {
          try {
            const r = await fetch(`${appBase}/api/v2/ai/status`);
            if (!r.ok) return false;
            const j = (await r.json()) as { configured?: boolean };
            return j.configured === true;
          } catch {
            return false;
          }
        },
        { timeout: 15_000, message: `Server failed to become ready on ${appBase}. Logs:\n${logs.join("")}` },
      )
      .toBe(true);

    const status = await jsonReq<{ inboxId: string }>(appBase, "GET", "/api/v2/user/status");
    const taskId = oid();
    await jsonReq(appBase, "POST", "/api/v2/batch/task", {
      add: [
        {
          id: taskId,
          projectId: status.inboxId,
          title: "Voice standup note",
          content: "",
          kind: "TEXT",
          status: 0,
          sortOrder: 0,
          tags: [],
          items: [],
          reminders: [],
          exDate: [],
        },
      ],
    });

    context = await browser.newContext({
      baseURL: appBase,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();

    // 1. Settings > Features confirms AI transcription is configured.
    await page.goto("/#q/all/tasks?modalType=settings&tabs=feature");
    await expect(page.getByTestId("feature-ai-row")).toContainText("AI transcription");
    await expect(page.getByTestId("feature-ai-status")).toHaveText("Configured");

    // 2. Navigate to the task and drop a synthetic WAV recording onto it.
    await page.goto(`/#p/${status.inboxId}/tasks/${taskId}`);
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle");

    const wav = synthWavBytes();
    await page.evaluate((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], "standup.wav", { type: "audio/wav" }));
      const pane = document.querySelector("[data-testid=detail-pane]")!;
      for (const type of ["dragenter", "dragover", "drop"]) {
        pane.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    }, wav);

    await expect(page.getByTestId("attachment")).toHaveAttribute("data-file", "standup.wav");
    await expect(page.getByTestId("att-ai-btn")).toBeVisible();
    await expect(page.getByTestId("att-ai-btn")).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByTestId("att-more-btn")).toBeVisible();

    // 3. Open "..." menu -> click Transcribe -> observe progress + transcript panel.
    await page.getByTestId("att-more-btn").click();
    await expect(page.getByTestId("att-ai-menu")).toBeVisible();
    await expect(page.getByTestId("att-menu-transcribe")).toHaveText("Transcribe");
    await expect(page.getByTestId("att-menu-summarize")).toHaveText("Summarize");

    await page.getByTestId("att-menu-transcribe").click();
    await expect(page.getByTestId("att-ai-panel")).toBeVisible();
    await expect(page.getByTestId("att-ai-progress")).toBeVisible();
    await expect(page.getByTestId("att-ai-transcript-text")).toHaveText(
      "Standup update: latency dropped and release ships Friday.",
      { timeout: 10_000 },
    );
    expect(sttCalls).toBe(1);
    expect(lastAuth).toBe("Bearer gsk_e2e_test");
    expect(lastTranscriptModel).toBe("whisper-large-v3-turbo");
    await expect(page.getByTestId("att-ai-create-subtasks")).toHaveCount(0);

    // 4. Copy + Add to description from transcript tab.
    await page.getByTestId("att-ai-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "Standup update: latency dropped and release ships Friday.",
    );
    await page.getByTestId("att-ai-add-desc").click();
    await expect(page.getByTestId("detail-body-rendered")).toContainText(
      "Standup update: latency dropped and release ships Friday.",
    );

    // 5. Open "..." menu -> click Summarize -> reuse cached transcript & create subtasks.
    await page.getByTestId("att-more-btn").click();
    await page.getByTestId("att-menu-summarize").click();
    await expect(page.getByTestId("att-ai-summary-content")).toContainText("Latency dropped after optimization", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("att-ai-summary-content")).toContainText("Ship release on Friday");
    await expect(page.getByTestId("att-ai-summary-content")).toContainText("Prepare release notes");
    await expect(page.getByTestId("att-ai-summary-content")).toContainText("Notify QA team");
    expect(sttCalls).toBe(1);
    expect(sumCalls).toBe(1);
    expect(lastSummarizeModel).toBe("openai/gpt-oss-120b");

    await page.getByTestId("att-ai-create-subtasks").click();
    const pane = page.getByTestId("detail-pane");
    await expect(pane).toContainText("Prepare release notes");
    await expect(pane).toContainText("Notify QA team");

    await page.getByTestId("att-ai-add-desc").click();
    await expect(page.getByTestId("detail-body-rendered")).toContainText("Key Points");
    await expect(page.getByTestId("detail-body-rendered")).toContainText("Latency dropped after optimization");

    // 6. Wait for sync idle, reload, and verify cached AI results render without re-calling Groq.
    await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("detail-pane")).toBeVisible();
    await expect(page.getByTestId("detail-pane")).toContainText("Prepare release notes");
    await page.getByTestId("att-ai-btn").click();
    await expect(page.getByTestId("att-ai-transcript-text")).toHaveText(
      "Standup update: latency dropped and release ships Friday.",
    );
    await page.getByTestId("att-ai-tab-summary").click();
    await expect(page.getByTestId("att-ai-summary-content")).toContainText("Latency dropped after optimization");
    expect(sttCalls).toBe(1);
    expect(sumCalls).toBe(1);

    // Check nothing in server logs leaked transcript text.
    const joinedLogs = logs.join("");
    expect(joinedLogs).not.toContain("Standup update:");
    expect(joinedLogs).not.toContain("Latency dropped after optimization");
  } finally {
    await context?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((ok) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          ok();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          ok();
        });
      });
    }
    await new Promise<void>((ok) => mockGroq.close(() => ok()));
    rmSync(dir, { recursive: true, force: true });
  }
});
