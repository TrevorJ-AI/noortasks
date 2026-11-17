/** Synthetic fixture data for e2e tests and screenshots. Nothing here comes from a real account. */
const API = process.env.NOORTASKS_API ?? "http://127.0.0.1:18731";

let c = Math.floor(Math.random() * 0xffffff);
export function oid(): string {
  c = (c + 1) & 0xffffff;
  const secs = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  const rnd = Array.from({ length: 5 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
  return secs + rnd + c.toString(16).padStart(6, "0");
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t}`);
  return (t ? JSON.parse(t) : undefined) as T;
}

const midnight = (offsetDays: number): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().replace("Z", "+0000");
};
const at = (offsetDays: number, h: number, m = 0): string => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().replace("Z", "+0000");
};

export async function inboxId(): Promise<string> {
  const s = await api<{ inboxId: string }>("GET", "/api/v2/user/status");
  return s.inboxId;
}

export async function seedBaseline(): Promise<void> {
  const inbox = await inboxId();
  const step = 2 ** 40;
  const lists = [
    { id: oid(), name: "Home projects", color: "#3fa66b" },
    { id: oid(), name: "Reading list", color: "#2f8fbf" },
    { id: oid(), name: "Garden", color: null },
    { id: oid(), name: "Trip planning", color: "#e2b714" },
  ];
  const folder = { id: oid(), name: "Personal", sortOrder: step * 10 };
  await api("POST", "/api/v2/batch/projectGroup", { add: [folder] });
  await api("POST", "/api/v2/batch/project", {
    add: lists.map((l, i) => ({ ...l, sortOrder: i * step, viewMode: "list", kind: "TASK", inAll: true, groupId: i >= 2 ? folder.id : null, sortOption: { groupBy: "sortOrder", orderBy: "sortOrder", order: "asc" } })),
  });
  await api("POST", "/api/v2/batch/tag", {
    add: [
      { name: "errands", label: "errands", color: "#e5484d", sortOrder: 0 },
      { name: "deep-work", label: "deep-work", color: "#5b6ee1", sortOrder: step },
      { name: "weekend", label: "weekend", color: "#3fa66b", sortOrder: step * 2 },
    ],
  });
  const tz = "Europe/Amsterdam";
  const T = (p: Record<string, unknown>, i: number) => ({ id: oid(), status: 0, kind: "TEXT", priority: 0, sortOrder: i * step, timeZone: tz, isFloating: false, tags: [], items: [], reminders: [], exDate: [], content: "", ...p });
  const tasks = [
    T({ projectId: lists[0]!.id, title: "Fix the squeaky hallway door", priority: 3, startDate: midnight(0), dueDate: midnight(0), isAllDay: true, tags: ["errands"] }, 0),
    T({ projectId: lists[0]!.id, title: "Paint the spare room", content: "Two coats.\n\n- buy rollers\n- tape edges", priority: 1, startDate: midnight(3), dueDate: midnight(3), isAllDay: true }, 1),
    T({ projectId: lists[0]!.id, title: "Replace kitchen light bulbs", startDate: at(0, 18, 30), dueDate: at(0, 18, 30), isAllDay: false, reminders: [{ id: oid(), trigger: "TRIGGER:PT0S" }] }, 2),
    T({ projectId: lists[0]!.id, title: "Clean out the garage", priority: 5, startDate: midnight(-2), dueDate: midnight(-2), isAllDay: true, tags: ["weekend"] }, 3),
    T({ projectId: lists[0]!.id, title: "Water the plants", startDate: midnight(0), dueDate: midnight(0), isAllDay: true, repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1", repeatFrom: "2" }, 4),
    T({ projectId: lists[1]!.id, title: "Finish the history book", kind: "CHECKLIST", items: [{ id: oid(), title: "Chapter 7", status: 2, sortOrder: 0 }, { id: oid(), title: "Chapter 8", status: 0, sortOrder: step }, { id: oid(), title: "Chapter 9", status: 0, sortOrder: step * 2 }], startDate: midnight(1), dueDate: midnight(1), isAllDay: true, tags: ["deep-work"] }, 0),
    T({ projectId: lists[1]!.id, title: "Pick the next novel", priority: 1 }, 1),
    T({ projectId: lists[2]!.id, title: "Order tomato seeds", startDate: midnight(5), dueDate: midnight(5), isAllDay: true, tags: ["errands"] }, 0),
    T({ projectId: lists[3]!.id, title: "Book train tickets", priority: 5, startDate: at(1, 9), dueDate: at(1, 9), isAllDay: false }, 0),
    T({ projectId: inbox, title: "Call the dentist", priority: 3, startDate: midnight(0), dueDate: midnight(0), isAllDay: true }, 0),
    T({ projectId: inbox, title: "Renew library card" }, 1),
    T({ projectId: inbox, title: "Sketch ideas for the workshop", priority: 0, startDate: midnight(9), dueDate: midnight(9), isAllDay: true }, 2),
  ];
  await api("POST", "/api/v2/batch/task", { add: tasks });
  const parent = tasks[1]!;
  await api("POST", "/api/v2/batch/task", { add: [T({ projectId: lists[0]!.id, title: "Buy paint samples", parentId: parent.id }, 0), T({ projectId: lists[0]!.id, title: "Choose a colour", parentId: parent.id, status: 2 }, 1)] });
  await api("POST", "/api/v2/batch/task", {
    add: [
      T({ projectId: lists[0]!.id, title: "Hang the shelf", status: 2, completedTime: at(0, 9) }, 9),
      T({ projectId: lists[1]!.id, title: "Return borrowed magazine", status: 2, completedTime: at(-1, 15) }, 9),
    ],
  });
}
