import type { Attachment, AttachmentSummary } from "../lib/core";

/**
 * Pure helpers for audio attachment AI menu options, summary extraction,
 * and task description / subtask creation.
 */

export type AudioAiTab = "transcript" | "summary";
export type AudioAiActionKey = "transcribe" | "summarize" | "retranscribe" | "resummarize";

export interface AudioAiMenuSpec {
  key: AudioAiActionKey;
  label: string;
  disabled?: boolean;
  divider?: boolean;
}

export function hasTranscript(a: Partial<Pick<Attachment, "transcript" | "transcribedAt">>): boolean {
  return typeof a.transcript === "string" && (a.transcript.trim().length > 0 || Boolean(a.transcribedAt));
}

export function hasSummary(a: Partial<Pick<Attachment, "summary">>): boolean {
  const s = a.summary;
  if (!s || typeof s !== "object") return false;
  return Boolean(
    (s.keyPoints && s.keyPoints.length > 0) ||
      (s.decisions && s.decisions.length > 0) ||
      (s.actionItems && s.actionItems.length > 0) ||
      (typeof s.text === "string" && s.text.trim().length > 0),
  );
}

export function getAudioAiMenuSpecs(
  att: Partial<Pick<Attachment, "transcript" | "transcribedAt" | "summary">> & { localBlob?: boolean },
  opts: { busy?: boolean } = {},
): AudioAiMenuSpec[] {
  const disabled = Boolean(opts.busy || att.localBlob);
  const cachedTranscript = hasTranscript(att);
  const cachedSummary = hasSummary(att);
  const specs: AudioAiMenuSpec[] = [
    { key: "transcribe", label: "Transcribe", disabled },
    { key: "summarize", label: "Summarize", disabled },
  ];
  if (cachedTranscript) {
    specs.push({ key: "retranscribe", label: "Re-transcribe", disabled, divider: true });
  }
  if (cachedSummary) {
    specs.push({ key: "resummarize", label: "Re-summarize", disabled, divider: !cachedTranscript });
  }
  return specs;
}

export function extractActionItems(summary?: AttachmentSummary): string[] {
  if (!summary || !Array.isArray(summary.actionItems)) return [];
  const items: string[] = [];
  for (const raw of summary.actionItems) {
    if (typeof raw !== "string") continue;
    const cleaned = raw
      .trim()
      .replace(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "")
      .trim();
    if (cleaned) items.push(cleaned);
  }
  return items;
}

export function formatAttachmentSummary(summary?: AttachmentSummary): string {
  if (!summary) return "";
  if (typeof summary.text === "string" && summary.text.trim()) {
    return summary.text.trim();
  }
  const sections: string[] = [];
  if (summary.keyPoints?.length) {
    sections.push(`### Key Points\n${summary.keyPoints.map((x) => `- ${x}`).join("\n")}`);
  }
  if (summary.decisions?.length) {
    sections.push(`### Decisions\n${summary.decisions.map((x) => `- ${x}`).join("\n")}`);
  }
  if (summary.actionItems?.length) {
    sections.push(`### Action Items\n${summary.actionItems.map((x) => `- ${x}`).join("\n")}`);
  }
  return sections.join("\n\n").trim();
}

export function appendToTaskDescription(existing: string | undefined, addition: string): string {
  const next = addition.trim();
  if (!next) return existing ?? "";
  const prev = (existing ?? "").trimEnd();
  return prev ? `${prev}\n\n${next}` : next;
}
