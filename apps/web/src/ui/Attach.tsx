import { ChevronLeft, ChevronRight, Download, FileText, Loader2, Mic, MoreHorizontal, Paperclip, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { summarizeAttachment, transcribeAttachment } from "../data/aiApi";
import { isCapacitor } from "../lib/capacitor";
import { isAudioAttachment, type Attachment, type Task } from "../lib/core";
import { appendToTaskDescription, hasSummary, hasTranscript, type AudioAiActionKey, type AudioAiTab } from "../model/attachmentAi";
import { VoiceRecorder, formatDuration, type RecorderLike } from "../model/recorder";
import { AttachmentAiPanel, AudioAiGlyph, buildAudioAiMenuItems } from "./AttachmentAi";
import { useApp, type ModalState } from "./ctx";
import { Menu, Modal, Popover, anchorOf, type Anchor } from "./primitives";

/** Unlimited attachments UI (ATT-017..ATT-022, TASK-054): grid, preview, download, drop, paste, voice memo. */

export const isPdf = (a: { fileName?: string; fileType?: string }): boolean => /\.pdf$/i.test(a.fileName ?? "") || a.fileType === "PDF";
export const isImage = (a: { fileName?: string; fileType?: string }): boolean => a.fileType === "IMAGE" || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.fileName ?? "");
export const isAudio = (a: { fileName?: string; fileType?: string }): boolean => isAudioAttachment(a);

const sizeLabel = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Object URL for an attachment: the local blob while it waits to upload, else the server file as a blob. */
export function useAttachmentUrl(a: Attachment | undefined, asBlob: boolean): string | null {
  const { db, engine } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const fetchBlob = asBlob || (isCapacitor() && !!a && (isImage(a) || isAudio(a)));
  useEffect(() => {
    if (!a) return;
    let alive = true;
    let made: string | null = null;
    const remoteUrl = engine.api.url(`/api/v1/attachment/${a.id}`);
    void (async () => {
      if (a.localBlob) {
        const b = await db.blobs.get(a.localBlob as string);
        if (b) made = URL.createObjectURL(b.blob);
      } else if (fetchBlob) {
        // the file route sends Content-Disposition: attachment, so a frame would download it: fetch a blob
        const res = await fetch(remoteUrl, { credentials: "include" }).catch(() => null);
        if (res?.ok) {
          const raw = await res.blob();
          made = URL.createObjectURL(isPdf(a) ? new Blob([raw], { type: "application/pdf" }) : raw);
        }
      }
      if (alive) setUrl(made ?? (a.localBlob ? null : remoteUrl));
      else if (made) URL.revokeObjectURL(made);
    })();
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [a?.id, a?.localBlob, fetchBlob]); // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}

function Thumb({ a, onOpen }: { a: Attachment; onOpen: () => void }): JSX.Element {
  const url = useAttachmentUrl(a, false);
  if (isImage(a) && url) return <img src={url} alt={a.fileName} onClick={onOpen} />;
  if (isAudio(a) && url) return <audio controls src={url} preload="none" />;
  return (
    <button className="att-icon" onClick={onOpen} aria-label={`Open ${a.fileName}`}>
      {isPdf(a) ? <FileText size={20} /> : <Paperclip size={18} />}
    </button>
  );
}

export function AttachmentGrid({ task, readOnly = false }: { task: Task; readOnly?: boolean }): JSX.Element {
  const app = useApp();
  const list = task.attachments ?? [];
  const [menu, setMenu] = useState<{ attachmentId: string; anchor: Anchor } | null>(null);
  const [panel, setPanel] = useState<{ attachmentId: string; tab: AudioAiTab } | null>(null);
  const [busyByAtt, setBusyByAtt] = useState<Record<string, "transcribing" | "summarizing">>({});
  const [errByAtt, setErrByAtt] = useState<Record<string, string>>({});

  useEffect(() => {
    setMenu(null);
    setPanel(null);
    setErrByAtt({});
  }, [task.id]);

  if (!list.length) return <></>;
  const open = (a: Attachment): void => app.setModal({ kind: "preview", taskId: task.id, attachmentId: a.id });
  const aiEnabled = app.ai.configured;

  const runAi = async (a: Attachment, kind: "transcribe" | "summarize", force: boolean): Promise<void> => {
    if (busyByAtt[a.id] || a.localBlob) return;
    const mode = kind === "transcribe" ? "transcribing" : "summarizing";
    setBusyByAtt((prev) => ({ ...prev, [a.id]: mode }));
    setErrByAtt((prev) => {
      const next = { ...prev };
      delete next[a.id];
      return next;
    });

    const res =
      kind === "transcribe"
        ? await transcribeAttachment(app.engine.api, a.id, { force })
        : await summarizeAttachment(app.engine.api, a.id, { force });

    setBusyByAtt((prev) => {
      const next = { ...prev };
      delete next[a.id];
      return next;
    });

    if (!res.ok || !res.data) {
      const msg = res.message || "AI request failed";
      setErrByAtt((prev) => ({ ...prev, [a.id]: msg }));
      app.toast(msg);
      return;
    }

    const latest = (await app.db.tasks.get(task.id)) ?? task;
    const nextAttachments = (latest.attachments ?? []).map((item) => (item.id === res.data.id ? { ...item, ...res.data } : item));
    await app.repo.patchFromServer(task.id, { attachments: nextAttachments });
    void app.engine.sync();
  };

  const handleAction = (a: Attachment, action: AudioAiActionKey): void => {
    if (action === "transcribe") {
      setPanel({ attachmentId: a.id, tab: "transcript" });
      if (!hasTranscript(a)) void runAi(a, "transcribe", false);
    } else if (action === "summarize") {
      setPanel({ attachmentId: a.id, tab: "summary" });
      if (!hasSummary(a)) void runAi(a, "summarize", false);
    } else if (action === "retranscribe") {
      setPanel({ attachmentId: a.id, tab: "transcript" });
      void runAi(a, "transcribe", true);
    } else if (action === "resummarize") {
      setPanel({ attachmentId: a.id, tab: "summary" });
      void runAi(a, "summarize", true);
    }
  };

  const openPanelFromIcon = (a: Attachment): void => {
    if (hasSummary(a) && !hasTranscript(a)) {
      setPanel({ attachmentId: a.id, tab: "summary" });
      return;
    }
    setPanel({ attachmentId: a.id, tab: "transcript" });
    if (!hasTranscript(a) && !a.localBlob) void runAi(a, "transcribe", false);
  };

  const handleCopy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text);
      app.toast("Copied to clipboard");
    } catch {
      app.toast("Could not copy to clipboard");
    }
  };

  const handleAddToDescription = async (addition: string): Promise<void> => {
    if (readOnly) return;
    const latest = (await app.db.tasks.get(task.id)) ?? task;
    const field = latest.kind === "CHECKLIST" ? "desc" : "content";
    const next = appendToTaskDescription(latest[field] as string | undefined, addition);
    await app.repo.updateTask(task.id, { [field]: next });
    app.toast("Added to description");
  };

  const handleCreateSubtasks = async (items: string[]): Promise<void> => {
    if (readOnly || !items.length) return;
    for (const title of items) {
      await app.repo.createTask({ title, projectId: task.projectId, parentId: task.id }, { position: "bottom" });
    }
    app.toast(items.length === 1 ? "Created 1 subtask" : `Created ${items.length} subtasks`);
  };

  const activeAtt = aiEnabled && panel ? list.find((a) => a.id === panel.attachmentId && isAudio(a)) : undefined;
  const menuAtt = aiEnabled && menu ? list.find((a) => a.id === menu.attachmentId && isAudio(a)) : undefined;

  return (
    <>
      <div className="att-grid" data-testid="attachments">
        {list.map((a) => {
          const audio = isAudio(a);
          const busyMode = busyByAtt[a.id];
          const showAi = aiEnabled && audio;
          return (
            <div key={a.id} className={`att-card${isImage(a) ? " image" : ""}${audio ? " audio" : ""}`} data-testid="attachment" data-file={a.fileName}>
              <div className="att-thumb">
                <Thumb a={a} onOpen={() => open(a)} />
              </div>
              <div className="att-meta">
                <button className="att-name" onClick={() => open(a)} title={a.fileName}>{a.fileName}</button>
                <div className="att-subrow">
                  <span className="muted small">{a.localBlob ? "waiting to upload" : sizeLabel(a.size ?? 0)}</span>
                  {showAi && (
                    <div className="att-ai-controls">
                      <button
                        type="button"
                        className={`icon-btn xs att-ai-btn${hasTranscript(a) || hasSummary(a) ? " has-data" : ""}`}
                        aria-label={`AI transcribe or summarize ${a.fileName}`}
                        title={hasTranscript(a) || hasSummary(a) ? "Open AI transcript & summary" : "Transcribe audio"}
                        data-testid="att-ai-btn"
                        disabled={Boolean(a.localBlob)}
                        onClick={() => openPanelFromIcon(a)}
                      >
                        <AudioAiGlyph size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn xs att-more-btn"
                        aria-label={`More AI actions for ${a.fileName}`}
                        aria-haspopup="menu"
                        aria-expanded={menu?.attachmentId === a.id}
                        data-testid="att-more-btn"
                        onClick={(e) => setMenu({ attachmentId: a.id, anchor: anchorOf(e.currentTarget) })}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                    </div>
                  )}
                </div>
                {showAi && busyMode && (
                  <div className="att-ai-status" data-testid="att-ai-progress" role="status">
                    <Loader2 size={11} className="att-ai-spin" />
                    <span>{busyMode === "transcribing" ? "Transcribing..." : "Summarizing..."}</span>
                  </div>
                )}
              </div>
              <div className="att-actions">
                {!a.localBlob && (
                  <a className="icon-btn xs" href={app.engine.api.url(`/api/v1/attachment/${a.id}`)} download={a.fileName} aria-label={`Download ${a.fileName}`}>
                    <Download size={13} />
                  </a>
                )}
                <button className="icon-btn xs" aria-label="Remove attachment" disabled={readOnly} onClick={() => void app.repo.removeAttachment(task.id, a.id)}>
                  <X size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {activeAtt && panel && (
        <AttachmentAiPanel
          attachment={activeAtt}
          tab={panel.tab}
          busyMode={busyByAtt[activeAtt.id] ?? null}
          error={errByAtt[activeAtt.id] ?? null}
          readOnly={readOnly}
          onTab={(tab) => setPanel({ attachmentId: activeAtt.id, tab })}
          onClose={() => setPanel(null)}
          onCopy={(t) => void handleCopy(t)}
          onAddToDescription={(t) => void handleAddToDescription(t)}
          onCreateSubtasks={(items) => void handleCreateSubtasks(items)}
          onTranscribe={(force = false) => void runAi(activeAtt, "transcribe", force)}
          onSummarize={(force = false) => void runAi(activeAtt, "summarize", force)}
        />
      )}

      {menu && menuAtt && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} testId="att-ai-menu">
          <Menu
            items={buildAudioAiMenuItems(menuAtt, {
              busy: Boolean(busyByAtt[menuAtt.id]),
              onAction: (action) => handleAction(menuAtt, action),
            })}
            onClose={() => setMenu(null)}
          />
        </Popover>
      )}
    </>
  );
}

/** Full-size preview of images and PDFs with previous and next; other files offer a download (ATT-022). */
export function AttachmentPreview({ m }: { m: Extract<ModalState, { kind: "preview" }> }): JSX.Element {
  const app = useApp();
  const task = app.tasks.find((t) => t.id === m.taskId);
  const pool: Attachment[] = m.source === "comment" && m.url ? [{ id: m.attachmentId, fileName: m.fileName ?? "file", fileType: m.fileType ?? "OTHER", size: 0, refId: m.attachmentId, path: "", status: 0, createdTime: "" } as Attachment] : (task?.attachments ?? []);
  const [id, setId] = useState(m.attachmentId);
  const idx = Math.max(0, pool.findIndex((a) => a.id === id));
  const a = pool[idx];
  const url = useAttachmentUrl(a, !!a && isPdf(a));
  const setModal = app.setModal;
  const close = useCallback((): void => setModal(null), [setModal]);
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight" && idx < pool.length - 1) setId(pool[idx + 1]!.id);
      if (e.key === "ArrowLeft" && idx > 0) setId(pool[idx - 1]!.id);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [idx, pool]);
  return (
    <Modal onClose={close} wide className="preview-modal" testId="attachment-preview">
      <div className="preview-head">
        <span className="strong ellipsis grow" data-testid="preview-name">{a?.fileName ?? "Attachment"}</span>
        {pool.length > 1 && <span className="muted small">{idx + 1} / {pool.length}</span>}
        {a && !a.localBlob && (
          <a className="btn sm" href={app.engine.api.url(`/api/v1/attachment/${a.id}`)} download={a.fileName} data-testid="preview-download">
            <Download size={13} /> Download
          </a>
        )}
        <button className="icon-btn sm" aria-label="Close preview" onClick={close}><X size={16} /></button>
      </div>
      <div className="preview-body">
        {idx > 0 && <button className="preview-nav left" aria-label="Previous" onClick={() => setId(pool[idx - 1]!.id)}><ChevronLeft size={22} /></button>}
        {!a || !url ? (
          <div className="muted">Loading...</div>
        ) : isImage(a) ? (
          <img src={url} alt={a.fileName} data-testid="preview-image" />
        ) : isPdf(a) ? (
          <object data={url} type="application/pdf" aria-label={a.fileName} data-testid="preview-pdf">
            <div className="preview-file">
              <FileText size={40} strokeWidth={1.3} />
              <span>{a.fileName}</span>
              <span className="muted small">This browser shows no PDF preview here: use Download</span>
            </div>
          </object>
        ) : isAudio(a) ? (
          <audio controls src={url} data-testid="preview-audio" />
        ) : (
          <div className="preview-file">
            <Paperclip size={40} strokeWidth={1.3} />
            <span>{a.fileName}</span>
            <span className="muted small">No preview for this file type</span>
          </div>
        )}
        {idx < pool.length - 1 && <button className="preview-nav right" aria-label="Next" onClick={() => setId(pool[idx + 1]!.id)}><ChevronRight size={22} /></button>}
      </div>
    </Modal>
  );
}

/** Image files on the clipboard (ATT-017). */
export function clipboardFiles(e: React.ClipboardEvent): File[] {
  const out: File[] = [];
  for (const it of Array.from(e.clipboardData?.items ?? [])) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) out.push(f.name && f.name !== "image.png" ? f : new File([f], `Pasted image ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.${(f.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`, { type: f.type }));
    }
  }
  return out;
}

/** Drag files from the desktop onto the task detail (ATT-018): one attachment per file. */
export function useFileDrop(onFiles: (files: File[]) => void): { over: boolean; bind: Record<string, (e: React.DragEvent) => void> } {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    over,
    bind: {
      onDragEnter: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e) => {
        if (hasFiles(e)) e.preventDefault();
      },
      onDragLeave: (e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) onFiles(files);
      },
    },
  };
}

/** Voice memo (ATT-019, ATT-020): records into an audio attachment, stops by itself at 30 minutes. */
export function VoiceMemoButton({ task }: { task: Task }): JSX.Element {
  const app = useApp();
  const rec = useRef<VoiceRecorder | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => () => rec.current?.cancel(), []);
  const start = async (): Promise<void> => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return app.toast("This browser cannot record audio");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new VoiceRecorder((s) => new MediaRecorder(s) as unknown as RecorderLike, stream, {
        onTick: setMs,
        onDone: (blob, dur) => {
          setMs(null);
          const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
          void app.repo.addAttachment(task.id, new File([blob], `Voice memo ${formatDuration(dur)}.${ext}`, { type: blob.type || "audio/webm" }), `Voice memo ${formatDuration(dur)}.${ext}`);
          stream.getTracks().forEach((t) => t.stop());
        },
      });
      rec.current = r;
      r.start();
      setMs(0);
    } catch {
      app.toast("Microphone access was refused");
    }
  };
  return ms === null ? (
    <button className="icon-btn sm" title="Record a voice memo" aria-label="Record a voice memo" data-testid="voice-memo" onClick={() => void start()}>
      <Mic size={16} />
    </button>
  ) : (
    <button className="btn sm danger rec-on" aria-label="Stop recording" data-testid="voice-stop" onClick={() => rec.current?.stop()}>
      <Square size={11} fill="currentColor" /> {formatDuration(ms)}
    </button>
  );
}
