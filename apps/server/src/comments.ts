import {
  ActivityAction,
  formatServerDate,
  isPlainObject,
  newEtag,
  newId,
  type Attachment,
  type Comment,
  type CommentUserProfile,
  type Loose,
  type Task,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import type { ActivityService } from "./activity.js";
import { currentActor } from "./actor.js";
import { ApiError, type Service } from "./service.js";

function profileFor(svc: Service): CommentUserProfile {
  const a = currentActor();
  if (a) return { userId: String(a.userId), userCode: String(a.userId), username: a.email, name: a.name, displayName: a.name, avatarUrl: a.picture ?? "" };
  const p = (svc.store.getDoc<Loose>("profile")?.json ?? {}) as Loose;
  return {
    userId: String(svc.userId),
    userCode: typeof p.userCode === "string" ? p.userCode : String(svc.userId),
    username: typeof p.username === "string" ? p.username : "noortasks",
    name: typeof p.name === "string" ? p.name : "NoorTasks",
    displayName: typeof p.displayName === "string" ? p.displayName : "NoorTasks",
    avatarUrl: typeof p.picture === "string" ? p.picture : "",
  };
}

export interface CommentHooks {
  /** Called after a comment is stored (multi-user: notifications for the list's members and mentions). */
  onCreate?: (task: Task, comment: Comment) => void;
}

export class CommentService {
  constructor(
    private svc: Service,
    private act?: ActivityService,
    private hooks: CommentHooks = {},
  ) {}

  /** In a shared list a member edits or deletes only their own comments; the list owner may delete any. */
  private requireAuthor(old: Comment, allowOwner: boolean): void {
    const a = currentActor();
    if (!a) return;
    if (String(old.userProfile?.userId ?? "") === String(a.userId)) return;
    if (allowOwner && a.userId === this.svc.userId) return;
    throw new ApiError(403, "no_permission");
  }

  private get store() {
    return this.svc.store;
  }

  private requireTask(projectId: string, taskId: string): Task {
    const t = this.store.getTask(taskId);
    if (!t || (projectId !== "all" && t.projectId !== projectId)) throw new ApiError(404, "task_not_found");
    return t;
  }

  private syncTaskCount(task: Task, now: string, seq: number): number {
    const count = this.store.get<{ n: number }>("select count(*) as n from comments where taskId = ?", task.id)!.n;
    task.commentCount = count;
    task.etag = newEtag();
    task.modifiedTime = now;
    this.store.putTask(task, { seq });
    return count;
  }

  list(projectId: string, taskId: string): Comment[] {
    this.requireTask(projectId, taskId);
    return this.store
      .all<{ json: string }>("select json from comments where taskId = ? order by createdTime asc, rowid asc", taskId)
      .map((r) => JSON.parse(r.json) as Comment);
  }

  create(projectId: string, taskId: string, body: unknown): Comment {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_body");
    const task = this.requireTask(projectId, taskId);
    if (task.deleted) throw new ApiError(400, "task_deleted");

    const text =
      typeof body.text === "string"
        ? body.text
        : typeof body.content === "string"
          ? body.content
          : typeof body.title === "string"
            ? body.title
            : "";
    const attachments = Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : undefined;
    if (!text && (!attachments || attachments.length === 0)) throw new ApiError(400, "empty_comment");
    if (currentActor() && text.length > 1024) throw new ApiError(400, "comment_too_long");

    const replyTo = typeof body.commentId === "string" && body.commentId ? body.commentId : null;
    if (replyTo) {
      const parent = this.store.get("select 1 from comments where id = ? and taskId = ?", replyTo, taskId);
      if (!parent) throw new ApiError(404, "comment_not_found");
    }

    const id = typeof body.id === "string" && body.id ? body.id : newId(this.svc.now());
    if (this.store.get("select 1 from comments where id = ?", id)) throw new ApiError(409, "comment_existed");

    return this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.svc.now());
      // in multi-user mode the author is the signed-in member; a client cannot claim another identity
      const userProfile: CommentUserProfile =
        isPlainObject(body.userProfile) && !currentActor() ? { ...profileFor(this.svc), ...body.userProfile } : profileFor(this.svc);
      const comment: Comment = {
        ...(body as Loose),
        id,
        taskId,
        projectId: task.projectId,
        text,
        commentId: replyTo,
        userProfile,
        ...(attachments !== undefined ? { attachments } : {}),
        createdTime: typeof body.createdTime === "string" ? body.createdTime : now,
        modifiedTime: now,
      };
      this.store.run(
        "insert into comments(id, taskId, projectId, createdTime, json) values (?,?,?,?,?)",
        id,
        taskId,
        task.projectId,
        comment.createdTime,
        JSON.stringify(comment),
      );
      this.syncTaskCount(task, now, seq);
      this.act?.record({
        taskId,
        projectId: task.projectId,
        action: ActivityAction.CommentAdd,
        summary: "Added comment",
        taskTitle: task.title ?? "",
      });
      this.hooks.onCreate?.(task, comment);
      return comment;
    });
  }

  update(projectId: string, taskId: string, commentId: string, body: unknown): Comment {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_body");
    const task = this.requireTask(projectId, taskId);
    const row = this.store.get<{ json: string }>("select json from comments where id = ? and taskId = ?", commentId, taskId);
    if (!row) throw new ApiError(404, "comment_not_found");
    const old = JSON.parse(row.json) as Comment;
    this.requireAuthor(old, false);

    const nextText =
      typeof body.text === "string"
        ? body.text
        : typeof body.content === "string"
          ? body.content
          : typeof body.title === "string"
            ? body.title
            : old.text;
    if (currentActor() && nextText.length > 1024) throw new ApiError(400, "comment_too_long");
    const nextAttachments = Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : old.attachments;
    if (!nextText && (!nextAttachments || nextAttachments.length === 0)) throw new ApiError(400, "empty_comment");

    return this.store.tx(() => {
      const now = formatServerDate(this.svc.now());
      const next: Comment = {
        ...old,
        ...(body as Loose),
        id: old.id,
        taskId: old.taskId,
        projectId: old.projectId,
        text: nextText,
        ...(nextAttachments !== undefined ? { attachments: nextAttachments } : {}),
        userProfile: old.userProfile,
        createdTime: old.createdTime,
        modifiedTime: now,
      };
      this.store.run("update comments set json = ? where id = ?", JSON.stringify(next), commentId);
      this.act?.record({
        taskId,
        projectId: task.projectId,
        action: ActivityAction.CommentEdit,
        summary: "Edited comment",
        taskTitle: task.title ?? "",
      });
      return next;
    });
  }

  remove(projectId: string, taskId: string, commentId: string): { commentCount: number } {
    const task = this.requireTask(projectId, taskId);
    const row = this.store.get<{ json: string }>("select json from comments where id = ? and taskId = ?", commentId, taskId);
    if (!row) throw new ApiError(404, "comment_not_found");
    const old = JSON.parse(row.json) as Comment;
    this.requireAuthor(old, true);

    return this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.svc.now());
      this.store.run("delete from comments where id = ?", commentId);
      for (const att of old.attachments ?? []) {
        if (typeof att?.id === "string") {
          const r = this.store.get<{ taskSet: string | null }>("select taskSet from attachments where id = ?", att.id);
          if (r?.taskSet === "comment" && this.store.get("select 1 from attachments where id = ? and taskId = ?", att.id, taskId)) {
            const stillReferenced = this.store.all<{ json: string }>("select json from comments where taskId = ?", taskId)
              .some((c) => ((JSON.parse(c.json) as Comment).attachments ?? []).some((a) => a.id === att.id));
            if (!stillReferenced) this.svc.removeAttachmentRow(att.id);
          }
        }
      }
      const commentCount = this.syncTaskCount(task, now, seq);
      this.act?.record({
        taskId,
        projectId: task.projectId,
        action: ActivityAction.CommentDel,
        summary: "Deleted comment",
        taskTitle: task.title ?? "",
      });
      return { commentCount };
    });
  }
}

export function registerCommentRoutes(app: FastifyInstance, svc: Service, act?: ActivityService, hooks: CommentHooks = {}): CommentService {
  const cs = new CommentService(svc, act, hooks);
  app.get<{ Params: { projectId: string; taskId: string } }>("/api/v2/project/:projectId/task/:taskId/comments", async (req) =>
    cs.list(req.params.projectId, req.params.taskId),
  );
  app.post<{ Params: { projectId: string; taskId: string } }>("/api/v2/project/:projectId/task/:taskId/comment", async (req) =>
    cs.create(req.params.projectId, req.params.taskId, req.body),
  );
  app.put<{ Params: { projectId: string; taskId: string; commentId: string } }>(
    "/api/v2/project/:projectId/task/:taskId/comment/:commentId",
    async (req) => cs.update(req.params.projectId, req.params.taskId, req.params.commentId, req.body),
  );
  app.delete<{ Params: { projectId: string; taskId: string; commentId: string } }>(
    "/api/v2/project/:projectId/task/:taskId/comment/:commentId",
    async (req) => cs.remove(req.params.projectId, req.params.taskId, req.params.commentId),
  );
  return cs;
}
