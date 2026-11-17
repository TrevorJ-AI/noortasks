import { ImagePlus, Pencil, Send, Smile, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { newId, type Attachment, type Comment, type Task } from "../lib/core";
import { parseDate } from "../lib/dates";
import { clipboardFiles, isImage, useAttachmentUrl } from "./Attach";
import { canCommentProject, isSharedProject, type ShareRow } from "../data/accounts";
import { useApp } from "./ctx";
import { renderMarkdown } from "./Detail";
import { Popover, anchorOf, type Anchor } from "./primitives";

/** Task comments (TASK-116..TASK-120, ATT-025): list, write with emoji and images, edit, delete. */

const EMOJI = ["👍", "🙏", "✅", "🎉", "❤️", "😊", "😂", "🤔", "👀", "🔥", "⏰", "📌", "💡", "⚠️", "🚀", "☕", "📎", "✍️", "🙌", "👏", "😅", "😮", "💪", "🌙"];

function when(iso: string): string {
  const t = parseDate(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CommentImage({ a, taskId }: { a: Attachment; taskId: string }): JSX.Element | null {
  const app = useApp();
  const url = useAttachmentUrl(a, false);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={a.fileName}
      data-testid="comment-image"
      onClick={() => app.setModal({ kind: "preview", taskId, attachmentId: a.id, source: "comment", url: app.engine.api.url(`/api/v1/attachment/${a.id}`), fileName: a.fileName, fileType: a.fileType })}
    />
  );
}

function CommentImages({ list, taskId }: { list: Attachment[]; taskId: string }): JSX.Element | null {
  const app = useApp();
  if (!list.length) return null;
  return (
    <div className="cmt-images">
      {list.map((a) =>
        isImage(a) ? (
          <CommentImage key={a.id} a={a} taskId={taskId} />
        ) : (
          <a key={a.id} className="cmt-file" href={app.engine.api.url(`/api/v1/attachment/${a.id}`)} download={a.fileName}>{a.fileName}</a>
        ),
      )}
    </div>
  );
}

export function CommentsPanel({ task, onClose }: { task: Task; onClose: () => void }): JSX.Element {
  const app = useApp();
  const api = app.engine.api;
  const [list, setList] = useState<Comment[] | null>((task.commentCount ?? 0) > 0 ? null : []);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [emoji, setEmoji] = useState<Anchor | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const base = `/api/v2/project/${task.projectId}/task/${task.id}`;
  // COLL-037: in a shared list, "@" offers the list's members; picked names are sent as mentions
  const proj = app.projects.find((p) => p.id === task.projectId);
  const shared = isSharedProject(proj) && !!app.me && !app.me.single;
  const canComment = canCommentProject(proj) && (!shared || proj?.isOwner !== false || !!app.me?.collaboration.enabled);
  const [members, setMembers] = useState<ShareRow[]>([]);
  const [mentions, setMentions] = useState<number[]>([]);
  useEffect(() => {
    if (shared) api.get<ShareRow[]>(`/api/v2/project/${task.projectId}/users`).then(setMembers, () => setMembers([]));
  }, [shared, task.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = shared ? /(?:^|\s)@([^\s@]*)$/.exec(text) : null;
  const hints = at ? members.filter((m) => m.userId !== app.me?.userId && (m.name.toLowerCase().startsWith(at[1]!.toLowerCase()) || m.email.toLowerCase().startsWith(at[1]!.toLowerCase()))).slice(0, 6) : [];
  const pickMention = (m: ShareRow): void => {
    setText((t) => t.replace(/@([^\s@]*)$/, `@${m.name} `));
    setMentions((x) => (x.includes(m.userId) ? x : [...x, m.userId]));
    boxRef.current?.focus();
  };

  // TASK-116: a task without comments fires no comment request
  useEffect(() => {
    if ((task.commentCount ?? 0) === 0) return;
    api.get<Comment[]>(`${base}/comments`).then(
      (l) => setList(Array.isArray(l) ? l : []),
      () => setList([]),
    );
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => boxRef.current?.focus(), []);

  const send = async (): Promise<void> => {
    if ((!text.trim() && !files.length) || busy) return;
    setBusy(true);
    try {
      await app.engine.sync(); // the task must exist on the server
      const attachments: Attachment[] = [];
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f, f.name);
        attachments.push(await api.req<Attachment>("POST", `/api/v1/attachment/upload/comment/${task.projectId}/${task.id}`, fd));
      }
      const c = await api.post<Comment>(`${base}/comment`, { id: newId(), text: text.trim(), ...(attachments.length ? { attachments } : {}), ...(mentions.length ? { mentions: mentions.filter((id) => text.includes(`@${members.find((m) => m.userId === id)?.name ?? ""}`)) } : {}) });
      setList((l) => [...(l ?? []), c]);
      setText("");
      setFiles([]);
      setMentions([]);
      await app.repo.patchFromServer(task.id, { commentCount: (task.commentCount ?? 0) + 1 });
    } catch {
      app.toast("Comments need the server: try again when online");
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async (c: Comment): Promise<void> => {
    try {
      const next = await api.put<Comment>(`${base}/comment/${c.id}`, { text: editText });
      setList((l) => (l ?? []).map((x) => (x.id === c.id ? next : x)));
      setEditing(null);
    } catch {
      app.toast("Could not save the comment");
    }
  };
  const remove = async (c: Comment): Promise<void> => {
    try {
      const r = await api.del<{ commentCount: number }>(`${base}/comment/${c.id}`);
      setList((l) => (l ?? []).filter((x) => x.id !== c.id));
      await app.repo.patchFromServer(task.id, { commentCount: r?.commentCount ?? Math.max(0, (task.commentCount ?? 1) - 1) });
    } catch {
      app.toast("Could not delete the comment");
    }
  };

  return (
    <div className="cmt-panel" data-testid="comments">
      <div className="cmt-head">
        <span className="strong">Comments</span>
        {list && list.length > 0 && <span className="muted small">{list.length}</span>}
        <span className="grow" />
        <button className="icon-btn xs" aria-label="Hide comments" onClick={onClose}><X size={13} /></button>
      </div>
      <div className="cmt-list">
        {list === null && <div className="muted small">Loading...</div>}
        {list?.map((c) => (
          <div key={c.id} className="cmt" data-testid="comment">
            <span className="avatar sm">{(c.userProfile?.displayName ?? "N").slice(0, 1).toUpperCase()}</span>
            <div className="cmt-body">
              <div className="cmt-meta">
                <span className="strong small">{c.userProfile?.displayName ?? "NoorTasks"}</span>
                <span className="muted small">{when(c.createdTime)}{c.modifiedTime && c.modifiedTime !== c.createdTime && parseDate(c.modifiedTime) - parseDate(c.createdTime) > 1000 ? " · edited" : ""}</span>
                <span className="grow" />
                <button className="icon-btn xs cmt-act" aria-label="Edit comment" onClick={() => (setEditing(c.id), setEditText(c.text))}><Pencil size={12} /></button>
                <button className="icon-btn xs cmt-act" aria-label="Delete comment" data-testid="comment-delete" onClick={() => void remove(c)}><Trash2 size={12} /></button>
              </div>
              {editing === c.id ? (
                <div className="col gap-s">
                  <textarea className="field full cmt-input" value={editText} autoFocus onChange={(e) => setEditText(e.target.value)} />
                  <div className="row gap end">
                    <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                    <button className="btn sm primary" onClick={() => void saveEdit(c)}>Save</button>
                  </div>
                </div>
              ) : (
                c.text && <div className="cmt-text md-body" data-testid="comment-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.text) }} />
              )}
              <CommentImages list={c.attachments ?? []} taskId={task.id} />
            </div>
          </div>
        ))}
      </div>
      {files.length > 0 && (
        <div className="cmt-pending">
          {files.map((f, i) => (
            <span key={i} className="cmt-chip" data-testid="comment-pending-file">
              {f.name}
              <button className="pill-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}><X size={10} /></button>
            </span>
          ))}
        </div>
      )}
      {hints.length > 0 && (
        <div className="mention-hints" role="listbox" data-testid="mention-hints">
          {hints.map((m) => (
            <button key={m.userId} role="option" aria-selected={false} className="mention-hint" onMouseDown={(e) => (e.preventDefault(), pickMention(m))}>
              <strong>{m.name}</strong> <span className="muted small">{m.email}</span>
            </button>
          ))}
        </div>
      )}
      {!canComment && <div className="muted small cmt-ro">View only: you cannot comment in this list.</div>}
      <div className="cmt-compose" hidden={!canComment}>
        <textarea
          ref={boxRef}
          className="cmt-input"
          placeholder="Write a comment"
          data-testid="comment-input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const f = clipboardFiles(e);
            if (f.length) {
              e.preventDefault();
              setFiles((x) => [...x, ...f]);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (hints.length > 0) return pickMention(hints[0]!);
              void send();
            }
          }}
        />
        <button className="icon-btn sm" aria-label="Emoji" data-testid="comment-emoji" onClick={(e) => setEmoji(anchorOf(e.currentTarget))}><Smile size={16} /></button>
        <button className="icon-btn sm" aria-label="Attach image" data-testid="comment-image-btn" onClick={() => fileRef.current?.click()}><ImagePlus size={16} /></button>
        <button className="icon-btn sm primary" aria-label="Send comment" data-testid="comment-send" disabled={busy || (!text.trim() && !files.length)} onClick={() => void send()}><Send size={15} /></button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden data-testid="comment-file" onChange={(e) => setFiles((x) => [...x, ...Array.from(e.target.files ?? [])])} />
      </div>
      {emoji && (
        <Popover anchor={emoji} onClose={() => setEmoji(null)} placement="bottom-end" className="emoji-pop">
          <div className="emoji-grid">
            {EMOJI.map((e) => (
              <button key={e} onClick={() => (setText((t) => t + e), setEmoji(null), boxRef.current?.focus())}>{e}</button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
