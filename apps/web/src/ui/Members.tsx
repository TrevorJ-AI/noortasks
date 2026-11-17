import { Crown, LogOut, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { Card } from "./settings/kit";
import { useCallback, useEffect, useState } from "react";
import { HttpError } from "../data/api";
import { PERMISSION_LABEL, initials, type Contact, type MemberRow, type MembersView, type Permission, type ShareRow } from "../data/accounts";
import type { Task } from "../lib/core";
import { useApp } from "./ctx";
import { Menu, Modal, Popover, Select, Switch, anchorOf, type Anchor } from "./primitives";

const errText = (e: unknown, fallback: string): string => {
  const code = e instanceof HttpError ? String((e.body as { errorCode?: string } | undefined)?.errorCode ?? "") : "";
  const map: Record<string, string> = {
    max_users: "The member limit is reached.",
    confirm_required: "Type the email address to confirm.",
    remove_first: "Remove the member first.",
    invalid_email: "That is not an email address.",
    collaboration_off: "Collaboration is turned off by the admin.",
    member_not_found: "That member cannot be added.",
    not_owner: "Only the owner can do this.",
    cannot_delete_admin: "Admin accounts cannot be deleted here.",
  };
  return map[code] ?? fallback;
};

export function Avatar({ name, picture, size = 28 }: { name: string; picture?: string | null; size?: number }): JSX.Element {
  return picture ? (
    <img className="mbr-avatar" src={picture} alt="" width={size} height={size} referrerPolicy="no-referrer" />
  ) : (
    <span className="mbr-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden>
      {initials(name)}
    </span>
  );
}

const ago = (ms: number | null): string => {
  if (!ms) return "never";
  const d = Math.round((Date.now() - ms) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/** Settings > Members (admin): who may join, who is in, and the collaboration switch. */
export function MembersTab({ Row }: { Row: (p: { label: string; hint?: string; children: React.ReactNode }) => JSX.Element }): JSX.Element {
  const { engine, toast, me, refreshMe } = useApp();
  const [v, setV] = useState<MembersView | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState<{ email: string; code: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "remove" | "delete"; user: MemberRow } | null>(null);
  const [typed, setTyped] = useState("");
  const [menu, setMenu] = useState<{ user: MemberRow; anchor: Anchor } | null>(null);

  const load = useCallback(() => engine.api.get<MembersView>("/api/admin/members").then(setV, () => setV(null)), [engine]);
  useEffect(() => void load(), [load]);
  const run = async (p: Promise<MembersView>, ok?: string): Promise<MembersView | null> => {
    try {
      const next = await p;
      setV(next);
      if (ok) toast(ok);
      return next;
    } catch (e) {
      toast(errText(e, "That did not work"));
      return null;
    }
  };

  if (!v) return <div className="muted">Loading members...</div>;
  const active = v.users.filter((u) => u.status !== "removed");
  const removed = v.users.filter((u) => u.status === "removed");
  const pending = v.allowlist.filter((a) => !a.joined);

  return (
    <div className="members" data-testid="members-tab">
      <section className="mbr-section">
        <h3 className="mbr-h">Invite</h3>
        <p className="muted small">
          {v.oidc ? "Only these emails can create an account with their first sign-in." : "Each invite gets a one-time code to set a password."}
        </p>
        <form
          className="mbr-invite"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(engine.api.post<MembersView>("/api/admin/allowlist", { email }), `Invited ${email}`);
            if (r) {
              if (r.inviteCode) setCode({ email: email.trim().toLowerCase(), code: r.inviteCode });
              setEmail("");
            }
          }}
        >
          <input className="field grow" type="email" placeholder="friend@example.com" aria-label="Email to invite" data-testid="invite-email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn primary" type="submit" data-testid="invite-add" disabled={!email.includes("@")}>
            <UserPlus size={15} /> Invite
          </button>
        </form>
        {code && (
          <div className="mbr-code" data-testid="invite-code">
            One-time code for {code.email}: <code>{code.code}</code>
            <span className="muted small">Shown once. They enter it on the sign-in screen.</span>
          </div>
        )}
        {pending.length > 0 && (
          <ul className="mbr-list" data-testid="invite-list">
            {pending.map((a) => (
              <li key={a.email} className="mbr-row">
                <Avatar name={a.email} />
                <div className="mbr-who">
                  <span>{a.email}</span>
                  <span className="muted small">Invited, not joined yet</span>
                </div>
                <button className="icon-btn sm" aria-label={`Cancel invite for ${a.email}`} onClick={() => void run(engine.api.del<MembersView>(`/api/admin/allowlist/${encodeURIComponent(a.email)}`), "Invite cancelled")}>
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mbr-section">
        <h3 className="mbr-h">
          Members <span className="muted small">{v.activeCount} of {v.settings.maxUsers}</span>
        </h3>
        <ul className="mbr-list" data-testid="member-list">
          {active.map((u) => (
            <li key={u.userId} className="mbr-row" data-testid={`member-${u.email}`}>
              <Avatar name={u.name || u.email} picture={u.picture} />
              <div className="mbr-who">
                <span>
                  {u.name || u.email} {u.userId === me?.userId && <span className="muted small">(you)</span>}
                </span>
                <span className="muted small">
                  {u.email} · last seen {ago(u.lastLoginMs)}
                </span>
              </div>
              {u.role === "admin" && <span className="mbr-badge">Admin</span>}
              {u.status === "disabled" && <span className="mbr-badge off">Disabled</span>}
              {u.userId !== me?.userId && (
                <button className="btn sm" data-testid={`member-menu-${u.email}`} onClick={(e) => setMenu({ user: u, anchor: anchorOf(e.currentTarget) })}>
                  Manage
                </button>
              )}
            </li>
          ))}
        </ul>
        {removed.length > 0 && (
          <>
            <h4 className="mbr-sub muted small">Removed (data kept)</h4>
            <ul className="mbr-list">
              {removed.map((u) => (
                <li key={u.userId} className="mbr-row removed">
                  <Avatar name={u.name || u.email} picture={u.picture} />
                  <div className="mbr-who">
                    <span>{u.name || u.email}</span>
                    <span className="muted small">{u.email}</span>
                  </div>
                  <button className="btn sm" onClick={() => void run(engine.api.post<MembersView>(`/api/admin/members/${u.userId}/enable`), "Member restored")}>
                    Restore
                  </button>
                  <button className="btn sm danger" data-testid={`member-delete-${u.email}`} onClick={() => (setTyped(""), setConfirm({ kind: "delete", user: u }))}>
                    Delete data
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="mbr-section">
        <h3 className="mbr-h">Server</h3>
        <Row label="Collaboration" hint="Sharing lists, assigning, comments between members. Off: shared lists turn read-only, nothing is deleted.">
          <Switch
            checked={v.settings.collaboration}
            testId="collab-switch"
            onChange={(on) => void run(engine.api.put<MembersView>("/api/admin/settings", { collaboration: on }), on ? "Collaboration on" : "Collaboration off").then(() => refreshMe())}
          />
        </Row>
        <Row label="Member limit" hint="Accounts this server allows, admins included.">
          <Select
            value={v.settings.maxUsers}
            testId="max-users"
            options={[...new Set([2, 3, 5, 10, 15, 20, 30, v.settings.maxUsers])].sort((a, b) => a - b).map((n) => ({ value: n, label: String(n) }))}
            onChange={(n) => void run(engine.api.put<MembersView>("/api/admin/settings", { maxUsers: n }), `Limit set to ${n}`)}
          />
        </Row>
      </section>

      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} placement="bottom-end" testId="member-menu">
          <Menu
            onClose={() => setMenu(null)}
            items={[
              menu.user.status === "disabled"
                ? { label: "Turn on", onClick: () => void run(engine.api.post<MembersView>(`/api/admin/members/${menu.user.userId}/enable`), "Member turned on") }
                : { label: "Turn off (keeps data)", testId: "member-disable", onClick: () => void run(engine.api.post<MembersView>(`/api/admin/members/${menu.user.userId}/disable`), "Member turned off") },
              { label: "Remove from server", icon: <UserMinus size={15} />, danger: true, testId: "member-remove", onClick: () => (setTyped(""), setConfirm({ kind: "remove", user: menu.user })) },
            ]}
          />
        </Popover>
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} testId="member-confirm">
          <h3>{confirm.kind === "remove" ? `Remove ${confirm.user.name || confirm.user.email}?` : `Delete all data of ${confirm.user.email}?`}</h3>
          <p className="muted">
            {confirm.kind === "remove"
              ? "They are signed out and leave every shared list. Their tasks stay on the server until you delete them."
              : "Their tasks, lists, habits and files are deleted for good. This cannot be undone."}
          </p>
          <input className="field full" placeholder={confirm.user.email} aria-label="Type the email to confirm" data-testid="member-confirm-input" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <div className="row gap end" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button
              className="btn danger"
              data-testid="member-confirm-ok"
              disabled={typed.trim().toLowerCase() !== confirm.user.email}
              onClick={() => {
                const path = confirm.kind === "remove" ? "remove" : "delete-data";
                void run(engine.api.post<MembersView>(`/api/admin/members/${confirm.user.userId}/${path}`, { confirm: typed }), confirm.kind === "remove" ? "Member removed" : "Data deleted");
                setConfirm(null);
              }}
            >
              {confirm.kind === "remove" ? "Remove" : "Delete data"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Settings > Collaborate: the per-person opt-out. */
export function CollaborateTab({ Row }: { Row: (p: { label: string; hint?: string; children: React.ReactNode }) => JSX.Element }): JSX.Element {
  const { engine, me, refreshMe, toast } = useApp();
  if (!me || me.single) return <div className="muted">This server has one account; there is nobody to share with.</div>;
  return (
    <>
      {!me.collaboration.enabled && <div className="banner" data-testid="collab-off-banner">Collaboration is turned off on this server. Shared lists are read-only.</div>}
      <Card>
      <Row label="Share and assign with me" hint="When off, other members cannot share lists with you or assign you tasks, and sharing is hidden for you.">
        <Switch
          checked={!me.collaboration.optedOut}
          testId="collab-optin"
          onChange={(on) =>
            void engine.api
              .put("/api/auth/me", { collabOptOut: !on })
              .then(() => refreshMe())
              .then(() => toast(on ? "Collaboration on for you" : "Collaboration off for you"))
          }
        />
      </Row>
      </Card>
    </>
  );
}

/** Share dialog for a list (COLL-001..011): owner variant with invite and remove, member variant with leave. */
export function ShareDialog({ projectId }: { projectId: string }): JSX.Element {
  const { engine, setModal, toast, projects, me, collab } = useApp();
  const p = projects.find((x) => x.id === projectId);
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pick, setPick] = useState<number | "">("");
  const [perm, setPerm] = useState<Permission>("write");
  const [menu, setMenu] = useState<{ row: ShareRow; anchor: Anchor } | null>(null);
  const owner = p?.isOwner !== false;
  const load = useCallback(async () => {
    setRows(await engine.api.get<ShareRow[]>(`/api/v2/project/${projectId}/shares`).catch(() => []));
    setContacts(await engine.api.get<Contact[]>("/api/v2/share/contacts").catch(() => []));
  }, [engine, projectId]);
  useEffect(() => void load(), [load]);
  const after = async (p2: Promise<unknown>, ok: string): Promise<void> => {
    try {
      await p2;
      toast(ok);
      await load();
      void engine.sync();
    } catch (e) {
      toast(errText(e, "That did not work"));
    }
  };
  const available = contacts.filter((c) => !(rows ?? []).some((r) => r.userId === c.userId));
  const close = (): void => setModal(null);
  const mine = (rows ?? []).find((r) => r.userId === me?.userId && !r.isOwner);

  return (
    <Modal onClose={close} testId="share-dialog">
      <div className="share-head">
        <Users size={18} />
        <h3 className="grow ellipsis">Share "{p?.name ?? "list"}"</h3>
      </div>
      {!me?.collaboration.enabled && <div className="banner small">Collaboration is turned off by the admin. Shared lists are read-only for members.</div>}
      {owner && collab && (
        <div className="share-add">
          <Select<number | "">
            value={pick}
            testId="share-pick"
            options={[{ value: "", label: available.length ? "Choose a member" : "No members to add" }, ...available.map((c) => ({ value: c.userId, label: c.name === c.email ? c.email : `${c.name} (${c.email})` }))]}
            onChange={setPick}
          />
          <Select<Permission> value={perm} testId="share-perm" options={(["write", "comment", "read"] as Permission[]).map((x) => ({ value: x, label: PERMISSION_LABEL[x] }))} onChange={setPerm} />
          <button className="btn primary" data-testid="share-add" disabled={pick === ""} onClick={() => void after(engine.api.post(`/api/v2/project/${projectId}/share`, { userId: pick, permission: perm }), "Shared").then(() => setPick(""))}>
            Share
          </button>
        </div>
      )}
      <ul className="mbr-list share-list" data-testid="share-list">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="mbr-row" data-testid={`share-row-${r.email}`}>
            <Avatar name={r.name} picture={r.picture} />
            <div className="mbr-who">
              <span>
                {r.name} {r.userId === me?.userId && <span className="muted small">(you)</span>}
              </span>
              <span className="muted small">{r.email}</span>
            </div>
            {r.isOwner ? (
              <span className="mbr-badge">
                <Crown size={12} /> Owner
              </span>
            ) : owner && collab ? (
              <>
                <Select<Permission>
                  value={r.permission as Permission}
                  testId={`share-perm-${r.email}`}
                  options={(["write", "comment", "read"] as Permission[]).map((x) => ({ value: x, label: PERMISSION_LABEL[x] }))}
                  onChange={(x) => void after(engine.api.put(`/api/v2/project/${projectId}/permission?permission=${x}&recordId=${r.id}`), "Permission changed")}
                />
                <button className="icon-btn sm" aria-label={`More for ${r.name}`} onClick={(e) => setMenu({ row: r, anchor: anchorOf(e.currentTarget) })}>
                  ⋯
                </button>
              </>
            ) : (
              <span className="muted small">{PERMISSION_LABEL[(r.effectivePermission ?? r.permission) as Permission] ?? ""}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="row gap end">
        {mine && (
          <button
            className="btn danger"
            data-testid="share-leave"
            onClick={() =>
              void after(engine.api.del(`/api/v2/project/${projectId}/share/${mine.id}`), "You left the list").then(() => {
                setModal(null);
                location.hash = "#q/today/tasks";
              })
            }
          >
            <LogOut size={15} /> Leave list
          </button>
        )}
        <button className="btn" onClick={close}>Done</button>
      </div>
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} placement="bottom-end">
          <Menu
            onClose={() => setMenu(null)}
            items={[
              { label: "Make owner", icon: <Crown size={15} />, onClick: () => void after(engine.api.post(`/api/v2/project/${projectId}/transfer?toUserCode=${menu.row.userId}`), `${menu.row.name} now owns this list`) },
              { label: "Remove from list", icon: <UserMinus size={15} />, danger: true, testId: "share-remove", onClick: () => void after(engine.api.del(`/api/v2/project/${projectId}/share/${menu.row.id}`), "Removed") },
            ]}
          />
        </Popover>
      )}
    </Modal>
  );
}

/** Detail "Assign" control for a task in a shared list (COLL-025). */
export function AssignButton({ task, disabled }: { task: Task; disabled?: boolean }): JSX.Element | null {
  const { engine, repo, me } = useApp();
  const [a, setA] = useState<Anchor | null>(null);
  const [rows, setRows] = useState<ShareRow[]>([]);
  useEffect(() => {
    if (a) void engine.api.get<ShareRow[]>(`/api/v2/project/${task.projectId}/users`).then(setRows, () => setRows([]));
  }, [a, engine, task.projectId]);
  const cur = task.assignee !== undefined && task.assignee !== null && Number(task.assignee) > 0 ? Number(task.assignee) : null;
  const [names, setNames] = useState<Record<number, ShareRow>>({});
  useEffect(() => {
    if (cur !== null && !names[cur]) void engine.api.get<ShareRow[]>(`/api/v2/project/${task.projectId}/users`).then((r) => setNames(Object.fromEntries(r.map((x) => [x.userId, x]))), () => undefined);
  }, [cur, engine, task.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const who = cur !== null ? (names[cur] ?? rows.find((r) => r.userId === cur)) : undefined;
  return (
    <>
      <button className={`assign-btn${cur !== null ? " set" : ""}`} data-testid="detail-assign" disabled={disabled} title={who ? `Assigned to ${who.name}` : "Assign"} aria-label={who ? `Assigned to ${who.name}` : "Assign"} onClick={(e) => setA(anchorOf(e.currentTarget))}>
        {who ? <Avatar name={who.name} picture={who.picture} size={22} /> : <UserPlus size={16} />}
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="assign-menu">
          <Menu
            onClose={() => setA(null)}
            items={[
              ...rows.map((r) => ({ label: r.userId === me?.userId ? `${r.name} (me)` : r.name, checked: r.userId === cur, testId: `assign-${r.email}`, onClick: () => void repo.updateTask(task.id, { assignee: r.userId }) })),
              { label: "Nobody", checked: cur === null, onClick: () => void repo.updateTask(task.id, { assignee: null }) },
            ]}
          />
        </Popover>
      )}
    </>
  );
}
