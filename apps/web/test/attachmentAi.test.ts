import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { fetchAiStatus, summarizeAttachment, transcribeAttachment } from "../src/data/aiApi";
import type { Attachment } from "../src/lib/core";
import {
  appendToTaskDescription,
  extractActionItems,
  formatAttachmentSummary,
  getAudioAiMenuSpecs,
  type AudioAiActionKey,
} from "../src/model/attachmentAi";
import { AttachmentAiPanel, AudioAiGlyph, buildAudioAiMenuItems } from "../src/ui/AttachmentAi";

function audioAtt(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_1",
    refId: "att_1",
    path: "att_1",
    fileName: "standup.m4a",
    fileType: "AUDIO",
    size: 4096,
    status: 0,
    createdTime: "2026-11-17T10:00:00.000+0000",
    ...overrides,
  };
}

describe("aiApi client", () => {
  test("parses status and transcribe/summarize 200 responses and sends force flag", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (String(input).endsWith("/api/v2/ai/status")) {
        return new Response(
          JSON.stringify({
            configured: true,
            provider: "groq",
            transcribeModel: "whisper-large-v3-turbo",
            summarizeModel: "openai/gpt-oss-120b",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(audioAtt({ transcript: "Hello team", aiStatus: "done" })), { status: 200 });
    };

    const st = await fetchAiStatus({ base: "http://localhost:9999" }, mockFetch);
    expect(st.ok).toBe(true);
    expect(st.data.configured).toBe(true);

    const tr = await transcribeAttachment({ base: "http://localhost:9999" }, "att_1", { force: true }, mockFetch);
    expect(tr.ok).toBe(true);
    expect(tr.data.transcript).toBe("Hello team");

    await summarizeAttachment({ base: "http://localhost:9999" }, "att 2", {}, mockFetch);
    expect(calls[1]).toEqual({
      url: "http://localhost:9999/api/v2/attachment/att_1/transcribe",
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    expect(calls[2]).toEqual({
      url: "http://localhost:9999/api/v2/attachment/att%202/summarize",
      method: "POST",
      body: JSON.stringify({}),
    });
  });

  test("preserves 503 ai_not_configured, 502 provider error, 429 rate limit, and offline failures", async () => {
    const errFetch =
      (status: number, errorCode: string, errorMessage: string): typeof fetch =>
      async () =>
        new Response(JSON.stringify({ errorCode, errorMessage }), { status });

    const r503 = await transcribeAttachment({ base: "" }, "a1", {}, errFetch(503, "ai_not_configured", "No API key"));
    expect(r503).toMatchObject({ ok: false, status: 503, error: "ai_not_configured", message: "No API key" });

    const r502 = await summarizeAttachment({ base: "" }, "a1", {}, errFetch(502, "ai_provider_error", "Groq rejected file"));
    expect(r502).toMatchObject({ ok: false, status: 502, error: "ai_provider_error", message: "Groq rejected file" });

    const r429 = await transcribeAttachment({ base: "" }, "a1", {}, errFetch(429, "rate_limit_exceeded", "Slow down"));
    expect(r429).toMatchObject({ ok: false, status: 429, error: "rate_limit_exceeded", message: "Slow down" });

    const netDown = await transcribeAttachment({ base: "" }, "a1", {}, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(netDown).toMatchObject({ ok: false, status: 0, error: "offline" });
  });
});

describe("attachmentAi model", () => {
  test("menu specs always offer Transcribe and Summarize and expose regenerate options only when cached", () => {
    const fresh = getAudioAiMenuSpecs(audioAtt());
    expect(fresh.map((s) => s.label)).toEqual(["Transcribe", "Summarize"]);
    expect(fresh.every((s) => !s.disabled)).toBe(true);

    const cachedBoth = getAudioAiMenuSpecs(
      audioAtt({
        transcript: "Ready",
        summary: { keyPoints: ["One"] },
      }),
    );
    expect(cachedBoth.map((s) => s.label)).toEqual(["Transcribe", "Summarize", "Re-transcribe", "Re-summarize"]);
    expect(cachedBoth[2]!.divider).toBe(true);
    expect(cachedBoth[3]!.divider).toBe(false);

    const busy = getAudioAiMenuSpecs(audioAtt(), { busy: true });
    expect(busy.every((s) => s.disabled)).toBe(true);

    const pendingUpload = getAudioAiMenuSpecs(audioAtt({ localBlob: true }));
    expect(pendingUpload.every((s) => s.disabled)).toBe(true);
  });

  test("extractActionItems strips markdown list markers and formatAttachmentSummary builds markdown", () => {
    expect(
      extractActionItems({
        actionItems: ["- [ ] Email client", "1. Ship v2 release", "   ", "* Prepare demo"],
      }),
    ).toEqual(["Email client", "Ship v2 release", "Prepare demo"]);

    expect(
      formatAttachmentSummary({
        keyPoints: ["Latency dropped 40%"],
        decisions: ["Use opus encoding"],
        actionItems: ["Update docs"],
      }),
    ).toBe("### Key Points\n- Latency dropped 40%\n\n### Decisions\n- Use opus encoding\n\n### Action Items\n- Update docs");
  });

  test("appendToTaskDescription cleanly appends without stray blank lines", () => {
    expect(appendToTaskDescription("", "Transcript body")).toBe("Transcript body");
    expect(appendToTaskDescription("Existing note\n\n", "Summary text")).toBe("Existing note\n\nSummary text");
  });
});

describe("AttachmentAi UI menu and panel", () => {
  test("buildAudioAiMenuItems wires callbacks and testIds for Transcribe and Summarize", () => {
    const seen: AudioAiActionKey[] = [];
    const items = buildAudioAiMenuItems(audioAtt(), {
      onAction: (k) => seen.push(k),
    });
    expect(items.map((i) => ({ label: i.label, testId: i.testId }))).toEqual([
      { label: "Transcribe", testId: "att-menu-transcribe" },
      { label: "Summarize", testId: "att-menu-summarize" },
    ]);
    items.forEach((i) => i.onClick?.());
    expect(seen).toEqual(["transcribe", "summarize"]);
  });

  test("AudioAiGlyph renders waveform + sparkle icons", () => {
    const html = renderToStaticMarkup(createElement(AudioAiGlyph));
    expect(html).toContain("att-ai-glyph");
    expect(html).toContain("att-ai-wave");
    expect(html).toContain("att-ai-spark");
  });

  test("transcript tab renders Copy and Add to description without Create subtasks button", () => {
    const noop = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AttachmentAiPanel, {
        attachment: audioAtt({
          transcript: "Launch checklist confirmed for Friday.",
          summary: { keyPoints: ["Friday launch"], actionItems: ["Notify QA"] },
        }),
        tab: "transcript",
        onTab: noop,
        onClose: noop,
        onCopy: noop,
        onAddToDescription: noop,
        onCreateSubtasks: noop,
        onTranscribe: noop,
        onSummarize: noop,
      }),
    );

    expect(html).toContain("Launch checklist confirmed for Friday.");
    expect(html).toContain('data-testid="att-ai-copy"');
    expect(html).toContain('data-testid="att-ai-add-desc"');
    expect(html).toContain('data-testid="att-ai-regenerate"');
    expect(html).not.toContain('data-testid="att-ai-create-subtasks"');
  });

  test("summary tab renders structured sections and Create subtasks from action items", () => {
    const noop = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AttachmentAiPanel, {
        attachment: audioAtt({
          transcript: "Raw words",
          summary: {
            keyPoints: ["Budget approved"],
            decisions: ["Deploy Monday morning"],
            actionItems: ["Create release branch", "Send changelog"],
          },
        }),
        tab: "summary",
        onTab: noop,
        onClose: noop,
        onCopy: noop,
        onAddToDescription: noop,
        onCreateSubtasks: noop,
        onTranscribe: noop,
        onSummarize: noop,
      }),
    );

    expect(html).toContain("Budget approved");
    expect(html).toContain("Deploy Monday morning");
    expect(html).toContain("Create release branch");
    expect(html).toContain("Send changelog");
    expect(html).toContain('data-testid="att-ai-copy"');
    expect(html).toContain('data-testid="att-ai-add-desc"');
    expect(html).toContain('data-testid="att-ai-create-subtasks"');
    expect(html).toContain("Create subtasks from action items");
  });

  test("renders busy progress, error banner, and disables mutating actions when readOnly", () => {
    const noop = vi.fn();
    const busyHtml = renderToStaticMarkup(
      createElement(AttachmentAiPanel, {
        attachment: audioAtt(),
        tab: "transcript",
        busyMode: "transcribing",
        onTab: noop,
        onClose: noop,
        onCopy: noop,
        onAddToDescription: noop,
        onCreateSubtasks: noop,
        onTranscribe: noop,
        onSummarize: noop,
      }),
    );
    expect(busyHtml).toContain('data-testid="att-ai-panel-progress"');
    expect(busyHtml).toContain("Transcribing audio...");

    const roHtml = renderToStaticMarkup(
      createElement(AttachmentAiPanel, {
        attachment: audioAtt({
          aiStatus: "error",
          aiError: "Rate limit reached",
          summary: { keyPoints: ["Point"], actionItems: ["Item 1"] },
        }),
        tab: "summary",
        readOnly: true,
        onTab: noop,
        onClose: noop,
        onCopy: noop,
        onAddToDescription: noop,
        onCreateSubtasks: noop,
        onTranscribe: noop,
        onSummarize: noop,
      }),
    );
    expect(roHtml).toContain('data-testid="att-ai-error"');
    expect(roHtml).toContain("Rate limit reached");
    expect(roHtml).toContain('disabled="" data-testid="att-ai-add-desc"');
    expect(roHtml).toContain('disabled="" data-testid="att-ai-create-subtasks"');
  });
});
