import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { loadServerConfig } from "../src/server.js";
import { hex, mk, task, tmp } from "./helpers.js";
import { mkMulti } from "./multi-helpers.js";

const BOUNDARY = "----ntaitestboundary";
const toClean: string[] = [];
afterAll(() => toClean.forEach((d) => rmSync(d, { recursive: true, force: true })));

function multipartBody(filename: string, mime: string, data: Buffer): Readable {
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return Readable.from(Buffer.concat([head, data, tail]));
}

function upload(port: number, path: string, filename: string, mime: string, data: Buffer): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` } },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString();
          resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    multipartBody(filename, mime, data).pipe(req);
  });
}

async function uploadInject(
  call: (m: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>,
  path: string,
  filename: string,
  mime: string,
  data: Buffer,
) {
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const payload = Buffer.concat([head, data, tail]);
  return call("POST", path, payload, { "content-type": `multipart/form-data; boundary=${BOUNDARY}` });
}

interface MockGroqCall {
  url: string;
  auth: string | null;
  model?: string;
  fileName?: string;
  fileSize?: number;
  body?: any;
}

function makeMockFetch(opts: {
  sttText?: string | ((callIdx: number, fileName: string, size: number) => string);
  sttLanguage?: string;
  sttStatus?: number;
  sttError?: string;
  chatContent?: string;
  chatStatus?: number;
  chatError?: string;
} = {}) {
  const calls: MockGroqCall[] = [];
  let sttCount = 0;
  let chatCount = 0;

  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");

    if (url.endsWith("/audio/transcriptions")) {
      sttCount++;
      const fd = init?.body as FormData;
      const file = fd.get("file") as File | null;
      const model = String(fd.get("model") ?? "");
      const buf = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
      calls.push({ url, auth, model, ...(file?.name !== undefined ? { fileName: file.name } : {}), fileSize: buf.length });

      if (opts.sttStatus && opts.sttStatus >= 400) {
        return new Response(JSON.stringify({ error: { message: opts.sttError ?? "Groq STT refused" } }), {
          status: opts.sttStatus,
          headers: { "content-type": "application/json" },
        });
      }
      const text =
        typeof opts.sttText === "function"
          ? opts.sttText(sttCount, file?.name ?? "", buf.length)
          : opts.sttText ?? "We should ship the new release on Friday. Decision: freeze scope tomorrow.";
      return new Response(JSON.stringify({ text, language: opts.sttLanguage ?? "en" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.endsWith("/chat/completions")) {
      chatCount++;
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, auth, model: parsed.model, body: parsed });
      if (opts.chatStatus && opts.chatStatus >= 400) {
        return new Response(JSON.stringify({ error: { message: opts.chatError ?? "Groq Chat refused" } }), {
          status: opts.chatStatus,
          headers: { "content-type": "application/json" },
        });
      }
      const content =
        opts.chatContent ??
        JSON.stringify({
          keyPoints: ["Release scheduled for Friday"],
          decisions: ["Freeze scope tomorrow"],
          actionItems: ["Verify release checklist", "Notify QA team"],
        });
      return new Response(
        JSON.stringify({
          id: "chatcmpl-mock",
          choices: [{ index: 0, message: { role: "assistant", content } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  };

  return { fetchMock, calls, counts: () => ({ sttCount, chatCount }) };
}

async function setupListening(ai?: any, aiDeps?: any, now?: () => number) {
  const dataDir = tmp();
  toClean.push(dataDir);
  const built = buildApp({ dbPath: ":memory:", dataDir, noAuth: true, ...(ai ? { ai } : {}), ...(aiDeps ? { aiDeps } : {}), ...(now ? { now } : {}) });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (built.app.server.address() as AddressInfo).port;
  const t = task({ projectId: built.svc.inboxId, title: "Voice note task" });
  await built.app.inject({ method: "POST", url: "/api/v2/batch/task", payload: { add: [t] } });
  return { ...built, port, t, dataDir };
}

describe("AI transcription & summarization", () => {
  test("transcribe and summarize round trip, caching, sync delta, and force recompute", async () => {
    const mock = makeMockFetch();
    const s = await setupListening({ provider: "groq", apiKey: "gsk_test_123" }, { fetch: mock.fetchMock, hasFfmpeg: async () => false });

    const st = await s.app.inject({ method: "GET", url: "/api/v2/ai/status" });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ configured: true, provider: "groq", transcribeModel: "whisper-large-v3-turbo" });

    const attId = hex();
    const up = await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${attId}`, "memo.m4a", "audio/mp4", Buffer.from("FAKE_M4A_DATA"));
    expect(up.status).toBe(200);

    const cpBefore = (await s.app.inject({ method: "GET", url: "/api/v3/batch/check/0" })).json().checkPoint;

    // 1. Transcribe
    const tr = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/transcribe` });
    expect(tr.statusCode).toBe(200);
    expect(tr.json()).toMatchObject({
      id: attId,
      transcript: "We should ship the new release on Friday. Decision: freeze scope tomorrow.",
      aiStatus: "done",
    });
    expect(mock.counts()).toEqual({ sttCount: 1, chatCount: 0 });
    expect(mock.calls[0]!.auth).toBe("Bearer gsk_test_123");
    expect(mock.calls[0]!.model).toBe("whisper-large-v3-turbo");

    // 2. Second transcribe returns cached result without calling Groq
    const tr2 = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/transcribe` });
    expect(tr2.statusCode).toBe(200);
    expect(mock.counts()).toEqual({ sttCount: 1, chatCount: 0 });

    // 3. Summarize reuses existing transcript without re-running STT
    const sum = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/summarize` });
    expect(sum.statusCode).toBe(200);
    expect(sum.json().summary).toMatchObject({
      keyPoints: ["Release scheduled for Friday"],
      decisions: ["Freeze scope tomorrow"],
      actionItems: ["Verify release checklist", "Notify QA team"],
    });
    expect(sum.json().summary.text).toContain("### Key Points");
    expect(sum.json().summary.text).toContain("### Action Items");
    expect(mock.counts()).toEqual({ sttCount: 1, chatCount: 1 });

    // 4. Second summarize returns cached result without calling Groq
    const sum2 = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/summarize` });
    expect(sum2.statusCode).toBe(200);
    expect(mock.counts()).toEqual({ sttCount: 1, chatCount: 1 });

    // 5. Force recompute calls Groq again
    const trForce = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/transcribe`, payload: { force: true } });
    expect(trForce.statusCode).toBe(200);
    expect(mock.counts()).toEqual({ sttCount: 2, chatCount: 1 });

    // 6. Sync delta delivers updated attachment fields to other devices
    const delta = (await s.app.inject({ method: "GET", url: `/api/v3/batch/check/${cpBefore}` })).json();
    const updatedTask = delta.syncTaskBean.update.find((x: any) => x.id === s.t.id);
    expect(updatedTask.attachments[0]).toMatchObject({
      id: attId,
      transcript: "We should ship the new release on Friday. Decision: freeze scope tomorrow.",
      aiStatus: "done",
    });
    expect(updatedTask.attachments[0].summary.actionItems).toEqual(["Verify release checklist", "Notify QA team"]);

    await s.app.close();
  });

  test("summarize without prior transcript transcribes first then summarizes", async () => {
    const mock = makeMockFetch();
    const s = await setupListening({ provider: "groq", apiKey: "gsk_test" }, { fetch: mock.fetchMock, hasFfmpeg: async () => false });
    const attId = hex();
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${attId}`, "call.mp3", "audio/mpeg", Buffer.from("MP3_BYTES"));

    const sum = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/summarize` });
    expect(sum.statusCode).toBe(200);
    expect(sum.json().transcript).toBeTruthy();
    expect(sum.json().summary.actionItems).toEqual(["Verify release checklist", "Notify QA team"]);
    expect(mock.counts()).toEqual({ sttCount: 1, chatCount: 1 });

    await s.app.close();
  });

  test("supports all 8 audio extensions and rejects non-audio attachments", async () => {
    const mock = makeMockFetch();
    const s = await setupListening({ provider: "groq", apiKey: "gsk_test" }, { fetch: mock.fetchMock, hasFfmpeg: async () => false });

    for (const ext of ["m4a", "mp3", "wav", "ogg", "webm", "aac", "flac", "opus"]) {
      const id = hex();
      await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${id}`, `clip.${ext}`, "application/octet-stream", Buffer.from(`AUDIO_${ext}`));
      const r = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${id}/transcribe` });
      expect(r.statusCode, ext).toBe(200);
    }

    const txtId = hex();
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${txtId}`, "notes.txt", "text/plain", Buffer.from("hello"));
    const bad = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${txtId}/transcribe` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errorCode).toBe("unsupported_media_type");

    await s.app.close();
  });

  test("large file path: re-encodes to mono 16 kHz opus when ffmpeg is present", async () => {
    const mock = makeMockFetch({ sttText: "Compressed audio transcript." });
    const ffmpegCalls: string[][] = [];
    const s = await setupListening(
      { provider: "groq", apiKey: "gsk_test", maxFileBytes: 100 },
      {
        fetch: mock.fetchMock,
        hasFfmpeg: async () => true,
        runFfmpeg: async (args: string[]) => {
          ffmpegCalls.push(args);
          const outPath = args[args.length - 1]!;
          writeFileSync(outPath, Buffer.from("OPUS_16K_MONO"));
        },
      },
    );

    const attId = hex();
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${attId}`, "long.wav", "audio/wav", Buffer.alloc(350, 1));
    const r = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/transcribe` });

    expect(r.statusCode).toBe(200);
    expect(r.json().transcript).toBe("Compressed audio transcript.");
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0]).toEqual(expect.arrayContaining(["-ac", "1", "-ar", "16000", "-c:a", "libopus"]));
    expect(mock.counts()).toEqual({ sttCount: 1, chatCount: 0 });
    expect(mock.calls[0]!.fileName).toBe("audio.ogg");
    expect(mock.calls[0]!.fileSize).toBe(13);

    await s.app.close();
  });

  test("large file path: splits into chunks and joins text when ffmpeg is absent", async () => {
    const mock = makeMockFetch({
      sttText: (idx) => `Chunk ${idx}.`,
    });
    const s = await setupListening(
      { provider: "groq", apiKey: "gsk_test", maxFileBytes: 100 },
      { fetch: mock.fetchMock, hasFfmpeg: async () => false },
    );

    const attId = hex();
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${attId}`, "big.mp3", "audio/mpeg", Buffer.alloc(250, 2));
    const r = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/transcribe` });

    expect(r.statusCode).toBe(200);
    expect(r.json().transcript).toBe("Chunk 1. Chunk 2. Chunk 3.");
    expect(mock.counts()).toEqual({ sttCount: 3, chatCount: 0 });
    expect(mock.calls.map((c) => c.fileSize)).toEqual([100, 100, 50]);

    await s.app.close();
  });

  test("Groq error returns 502 with clear message and sets aiStatus error on attachment", async () => {
    const mock = makeMockFetch({ sttStatus: 429, sttError: "Rate limit exceeded on Groq" });
    const s = await setupListening({ provider: "groq", apiKey: "gsk_test" }, { fetch: mock.fetchMock, hasFfmpeg: async () => false });

    const attId = hex();
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${attId}`, "err.wav", "audio/wav", Buffer.from("WAV"));

    const r = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${attId}/transcribe` });
    expect(r.statusCode).toBe(502);
    expect(r.json().errorCode).toBe("ai_upstream_rate_limit");
    expect(r.json().errorMessage).toContain("Rate limit exceeded on Groq");

    const updatedTask = (await s.app.inject({ method: "GET", url: `/api/v2/task/${s.t.id}` })).json();
    expect(updatedTask.attachments[0]).toMatchObject({ id: attId, aiStatus: "error" });

    await s.app.close();
  });

  test("no key configured returns configured=false and 503 ai_not_configured", async () => {
    const m = mk();
    const t = task({ projectId: m.svc.inboxId });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    const attId = hex();
    await uploadInject(
      (method, url, body, headers) => m.app.inject({ method: method as "POST", url, payload: body as Buffer, ...(headers ? { headers } : {}) }).then((r) => ({ status: r.statusCode, json: r.json() })),
      `/api/v1/attachment/upload/${t.projectId}/${t.id}/${attId}`,
      "clip.wav",
      "audio/wav",
      Buffer.from("WAV"),
    );

    const status = await m.call("GET", "/api/v2/ai/status");
    expect(status.status).toBe(200);
    expect(status.json.configured).toBe(false);

    const tr = await m.call("POST", `/api/v2/attachment/${attId}/transcribe`);
    expect(tr.status).toBe(503);
    expect(tr.json.errorCode).toBe("ai_not_configured");

    const sum = await m.call("POST", `/api/v2/attachment/${attId}/summarize`);
    expect(sum.status).toBe(503);
    expect(sum.json.errorCode).toBe("ai_not_configured");

    rmSync(m.svc.opts.dataDir!, { recursive: true, force: true });
    await m.app.close();
  });

  test("per-user rate limit blocks after configured hourly quota and recovers after 1 hour", async () => {
    let nowMs = 1_700_000_000_000;
    const mock = makeMockFetch();
    const s = await setupListening(
      { provider: "groq", apiKey: "gsk_test", rateLimitPerHour: 2 },
      { fetch: mock.fetchMock, hasFfmpeg: async () => false },
      () => nowMs,
    );

    const ids = [hex(), hex(), hex()];
    for (const id of ids) {
      await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${id}`, `${id}.wav`, "audio/wav", Buffer.from("WAV"));
    }

    expect((await s.app.inject({ method: "POST", url: `/api/v2/attachment/${ids[0]}/transcribe` })).statusCode).toBe(200);
    // Cached hit does not consume quota
    expect((await s.app.inject({ method: "POST", url: `/api/v2/attachment/${ids[0]}/transcribe` })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "POST", url: `/api/v2/attachment/${ids[1]}/transcribe` })).statusCode).toBe(200);

    const blocked = await s.app.inject({ method: "POST", url: `/api/v2/attachment/${ids[2]}/transcribe` });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().errorCode).toBe("rate_limit_exceeded");

    // Advance past 1 hour window
    nowMs += 3_600_001;
    expect((await s.app.inject({ method: "POST", url: `/api/v2/attachment/${ids[2]}/transcribe` })).statusCode).toBe(200);

    await s.app.close();
  });

  test("multi-user permissions: owner & shared-list member allowed; non-member and revoked member denied (403)", async () => {
    const mock = makeMockFetch({ sttText: "Shared list audio transcript." });
    const m = await mkMulti({
      config: { ai: { provider: "groq", apiKey: "gsk_multi", rateLimitPerHour: 20 } },
      opts: { common: { aiDeps: { fetch: mock.fetchMock, hasFfmpeg: async () => false } } },
    });
    toClean.push(m.dir);

    const A = m.admin;
    const B = m.addUser("bea@example.com", "Bea");
    const C = m.addUser("cas@example.com", "Cas");

    const sharedPid = hex();
    const privPid = hex();
    await A.call("POST", "/api/v2/batch/project", {
      add: [
        { id: sharedPid, name: "Team", sortOrder: 0, kind: "TASK" },
        { id: privPid, name: "Private", sortOrder: 1, kind: "TASK" },
      ],
    });
    const sharedTask = task({ projectId: sharedPid, title: "Shared recording" });
    const privTask = task({ projectId: privPid, title: "Private recording" });
    await A.call("POST", "/api/v2/batch/task", { add: [sharedTask, privTask] });
    await A.call("POST", `/api/v2/project/${sharedPid}/share`, { userId: B.id, permission: "read" });

    const sharedAttId = hex();
    const privAttId = hex();
    await uploadInject(A.call, `/api/v1/attachment/upload/${sharedPid}/${sharedTask.id}/${sharedAttId}`, "team.ogg", "audio/ogg", Buffer.from("OGG1"));
    await uploadInject(A.call, `/api/v1/attachment/upload/${privPid}/${privTask.id}/${privAttId}`, "secret.ogg", "audio/ogg", Buffer.from("OGG2"));

    // Non-member C is denied with 403 on both shared and private attachments
    const cShared = await C.call("POST", `/api/v2/attachment/${sharedAttId}/transcribe`);
    expect(cShared.status).toBe(403);
    expect(cShared.json.errorCode).toBe("no_permission");
    expect((await C.call("POST", `/api/v2/attachment/${privAttId}/summarize`)).status).toBe(403);

    // Member B cannot access A's private list attachment (403)
    expect((await B.call("POST", `/api/v2/attachment/${privAttId}/transcribe`)).status).toBe(403);

    // Member B CAN transcribe the shared list attachment
    const bShared = await B.call("POST", `/api/v2/attachment/${sharedAttId}/transcribe`);
    expect(bShared.status).toBe(200);
    expect(bShared.json.transcript).toBe("Shared list audio transcript.");

    // Revoking B's share revokes attachment AI access
    const shares = (await A.call("GET", `/api/v2/project/${sharedPid}/shares`)).json;
    const shareRec = shares.find((r: any) => r.userId === B.id).id;
    await A.call("DELETE", `/api/v2/project/${sharedPid}/share/${shareRec}`);
    expect((await B.call("POST", `/api/v2/attachment/${sharedAttId}/summarize`)).status).toBe(403);

    await m.app.close();
  });

  test("loadServerConfig reads and validates ai section", () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-cfg-"));
    toClean.push(dir);
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        admins: ["admin@example.com"],
        passwordLogin: true,
        passphraseHash: "scrypt$abc$def",
        ai: {
          provider: "groq",
          apiKey: "gsk_file",
          transcribeModel: "whisper-large-v3-turbo",
          summarizeModel: "openai/gpt-oss-120b",
        },
      }),
    );
    const loaded = loadServerConfig(cfgPath);
    expect(loaded.ai?.provider).toBe("groq");
    expect(loaded.ai?.apiKey).toBe("gsk_file");
    expect(existsSync(cfgPath)).toBe(true);

    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ passphraseHash: "scrypt$abc$def", ai: { provider: "unknown-llm" } }));
    expect(() => loadServerConfig(badPath)).toThrow(/unsupported ai\.provider/i);
  });
});
