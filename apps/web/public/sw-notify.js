// NoorTasks notification helpers, shared by the service worker (importScripts) and the unit tests.
// Plain script on purpose: the service worker loads it as is. Keep in step with src/lib/notify.ts (a test compares them).
(function (g) {
  /** Hash route a reminder or notification opens (no leading slash). */
  function hashFor(data) {
    var d = data || {};
    var kind = d.kind || (d.data && d.data.kind) || "";
    var taskId = d.taskId || (d.data && d.data.taskId) || "";
    var projectId = d.projectId || (d.data && d.data.projectId) || "";
    if (taskId && projectId) return "#p/" + projectId + "/tasks/" + taskId;
    if (kind === "habit") return "#q/all/habit" + (d.targetId ? "/" + d.targetId : "");
    if (kind === "countdown") return "#countdown" + (d.targetId ? "/" + d.targetId : "");
    if (kind === "dailySummary" || d.type === "dailyReminder") return "#q/today/tasks";
    if (typeof d.url === "string" && d.url.charAt(0) === "#") return d.url;
    return "#n/notification/all";
  }
  /** Absolute URL for a notification click, inside the worker scope. */
  function target(data, scope) {
    var base = String(scope || "/").split("#")[0];
    return base + hashFor(data);
  }
  /** Title and options for showNotification from a push payload. */
  function build(data) {
    var d = data || {};
    var kind = d.kind || "";
    var title = d.title || "NoorTasks";
    var body = "";
    if (kind === "dailySummary" || d.type === "dailyReminder") {
      title = "Daily summary";
      body = (d.todayCount || 0) + " due today" + (d.overdueCount ? ", " + d.overdueCount + " overdue" : "");
    } else if (kind === "habit") body = "Habit";
    else if (kind === "countdown") body = "Countdown";
    else body = d.fireAt ? "Reminder" : "";
    var tag = "notif:" + (kind || "task") + ":" + (d.taskId || d.targetId || "") + ":" + (d.itemId || "");
    return {
      title: title,
      options: { body: body, tag: tag, renotify: true, requireInteraction: !!d.constant, icon: "/icon.svg", badge: "/icon.svg", data: d },
    };
  }
  g.noorNotify = { hashFor: hashFor, target: target, build: build };
})(typeof self !== "undefined" ? self : globalThis);
