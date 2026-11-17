import { AudioLines, Copy, FilePlus2, ListTodo, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import type { Attachment } from "../lib/core";
import {
  extractActionItems,
  formatAttachmentSummary,
  getAudioAiMenuSpecs,
  hasSummary,
  hasTranscript,
  type AudioAiActionKey,
  type AudioAiTab,
} from "../model/attachmentAi";
import type { MenuItem } from "./primitives";

/** Waveform + sparkle AI badge using Lucide icons with amber accent styling. */
export function AudioAiGlyph({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <span className="att-ai-glyph" aria-hidden="true">
      <AudioLines size={size} className="att-ai-wave" />
      <Sparkles size={Math.max(9, size - 4)} className="att-ai-spark" />
    </span>
  );
}

/** Builds MenuItem entries for the audio attachment "..." menu. */
export function buildAudioAiMenuItems(
  att: Partial<Pick<Attachment, "transcript" | "transcribedAt" | "summary">> & { localBlob?: boolean },
  opts: { busy?: boolean; onAction: (action: AudioAiActionKey) => void },
): MenuItem[] {
  const iconFor = (key: AudioAiActionKey): JSX.Element => {
    if (key === "transcribe") return <AudioLines size={14} />;
    if (key === "summarize") return <Sparkles size={14} />;
    return <RefreshCw size={14} />;
  };
  return getAudioAiMenuSpecs(att, { busy: opts.busy }).map((spec) => ({
    label: spec.label,
    icon: iconFor(spec.key),
    disabled: spec.disabled,
    divider: spec.divider,
    testId: `att-menu-${spec.key}`,
    onClick: () => opts.onAction(spec.key),
  }));
}

export interface AttachmentAiPanelProps {
  attachment: Attachment;
  tab: AudioAiTab;
  busyMode?: "transcribing" | "summarizing" | null;
  error?: string | null;
  readOnly?: boolean;
  onTab: (tab: AudioAiTab) => void;
  onClose: () => void;
  onCopy: (text: string) => void;
  onAddToDescription: (text: string) => void;
  onCreateSubtasks: (items: string[]) => void;
  onTranscribe: (force?: boolean) => void;
  onSummarize: (force?: boolean) => void;
}

/** Panel displaying cached or live audio transcript and structured summary actions. */
export function AttachmentAiPanel({
  attachment,
  tab,
  busyMode = null,
  error = null,
  readOnly = false,
  onTab,
  onClose,
  onCopy,
  onAddToDescription,
  onCreateSubtasks,
  onTranscribe,
  onSummarize,
}: AttachmentAiPanelProps): JSX.Element {
  const transcriptReady = hasTranscript(attachment);
  const summaryReady = hasSummary(attachment);
  const summary = attachment.summary;
  const actionItems = extractActionItems(summary);
  const summaryText = formatAttachmentSummary(summary);
  const transcriptText = (attachment.transcript ?? "").trim();
  const activeText = tab === "transcript" ? transcriptText : summaryText;
  const errMsg = error || (attachment.aiStatus === "error" ? attachment.aiError : undefined);
  const busy = Boolean(busyMode);

  const selectTab = (next: AudioAiTab): void => {
    onTab(next);
    if (busy || attachment.localBlob) return;
    if (next === "transcript" && !transcriptReady) onTranscribe(false);
    if (next === "summary" && !summaryReady) onSummarize(false);
  };

  return (
    <section className="att-ai-panel" data-testid="att-ai-panel" aria-label={`AI notes for ${attachment.fileName}`}>
      <div className="att-ai-head">
        <div className="att-ai-title-wrap">
          <AudioAiGlyph size={14} />
          <span className="att-ai-title" title={attachment.fileName}>
            {attachment.fileName}
          </span>
        </div>
        <div className="att-ai-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "transcript"}
            className={`att-ai-tab${tab === "transcript" ? " active" : ""}`}
            data-testid="att-ai-tab-transcript"
            onClick={() => selectTab("transcript")}
          >
            Transcript
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "summary"}
            className={`att-ai-tab${tab === "summary" ? " active" : ""}`}
            data-testid="att-ai-tab-summary"
            onClick={() => selectTab("summary")}
          >
            Summary
          </button>
        </div>
        <button
          type="button"
          className="icon-btn xs"
          aria-label="Close AI panel"
          data-testid="att-ai-close"
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </div>

      {busyMode && (
        <div className="att-ai-loading" data-testid="att-ai-panel-progress" role="status">
          <Loader2 size={14} className="att-ai-spin" />
          <span>{busyMode === "transcribing" ? "Transcribing audio..." : "Summarizing transcript..."}</span>
        </div>
      )}

      {errMsg && (
        <div className="att-ai-error" role="alert" data-testid="att-ai-error">
          {errMsg}
        </div>
      )}

      <div className="att-ai-body">
        {tab === "transcript" ? (
          transcriptReady ? (
            transcriptText ? (
              <p className="att-ai-transcript" data-testid="att-ai-transcript-text">
                {transcriptText}
              </p>
            ) : (
              <p className="muted small" data-testid="att-ai-empty">
                No speech detected in this audio.
              </p>
            )
          ) : !busy ? (
            <div className="att-ai-empty-cta">
              <span className="muted small">Not transcribed yet.</span>
              <button
                type="button"
                className="btn sm"
                disabled={Boolean(attachment.localBlob)}
                data-testid="att-ai-run-transcribe"
                onClick={() => onTranscribe(false)}
              >
                <AudioLines size={13} /> Transcribe
              </button>
            </div>
          ) : null
        ) : summaryReady && summary ? (
          <div className="att-ai-summary" data-testid="att-ai-summary-content">
            {summary.keyPoints && summary.keyPoints.length > 0 && (
              <div className="att-ai-section">
                <div className="att-ai-sec-label">Key Points</div>
                <ul>
                  {summary.keyPoints.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {summary.decisions && summary.decisions.length > 0 && (
              <div className="att-ai-section">
                <div className="att-ai-sec-label">Decisions</div>
                <ul>
                  {summary.decisions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {actionItems.length > 0 && (
              <div className="att-ai-section">
                <div className="att-ai-sec-label">Action Items</div>
                <ul>
                  {actionItems.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {!summary.keyPoints?.length && !summary.decisions?.length && actionItems.length === 0 && (
              <p className="att-ai-transcript">{summaryText || "No key points extracted."}</p>
            )}
          </div>
        ) : !busy ? (
          <div className="att-ai-empty-cta">
            <span className="muted small">No summary yet.</span>
            <button
              type="button"
              className="btn sm"
              disabled={Boolean(attachment.localBlob)}
              data-testid="att-ai-run-summarize"
              onClick={() => onSummarize(false)}
            >
              <Sparkles size={13} /> Summarize
            </button>
          </div>
        ) : null}
      </div>

      <div className="att-ai-foot">
        <button
          type="button"
          className="btn sm"
          disabled={!activeText}
          data-testid="att-ai-copy"
          onClick={() => activeText && onCopy(activeText)}
        >
          <Copy size={13} /> Copy
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={readOnly || !activeText}
          data-testid="att-ai-add-desc"
          onClick={() => activeText && onAddToDescription(activeText)}
        >
          <FilePlus2 size={13} /> Add to description
        </button>
        {tab === "summary" && (
          <button
            type="button"
            className="btn sm"
            disabled={readOnly || actionItems.length === 0}
            data-testid="att-ai-create-subtasks"
            onClick={() => actionItems.length > 0 && onCreateSubtasks(actionItems)}
          >
            <ListTodo size={13} /> Create subtasks from action items
          </button>
        )}
        {((tab === "transcript" && transcriptReady) || (tab === "summary" && summaryReady)) && !attachment.localBlob && (
          <button
            type="button"
            className="btn sm ghost att-ai-regen"
            disabled={busy}
            data-testid="att-ai-regenerate"
            title={tab === "transcript" ? "Re-transcribe audio" : "Re-summarize transcript"}
            onClick={() => (tab === "transcript" ? onTranscribe(true) : onSummarize(true))}
          >
            <RefreshCw size={12} /> {tab === "transcript" ? "Re-transcribe" : "Re-summarize"}
          </button>
        )}
      </div>
    </section>
  );
}
