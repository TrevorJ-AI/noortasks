import { Columns3, GanttChart, List as ListIcon } from "lucide-react";
import { allowedModes, go, viewPath, type ViewMode } from "../model/router";
import type { ViewRef } from "../model/views";
import { useApp, type App } from "./ctx";

const ICONS: Record<ViewMode, { icon: JSX.Element; label: string }> = {
  tasks: { icon: <ListIcon size={16} />, label: "List" },
  kanban: { icon: <Columns3 size={16} />, label: "Kanban" },
  timeline: { icon: <GanttChart size={16} />, label: "Timeline" },
};

/** Persist the layout of a container and open it (VIEW-020): list viewMode, tag/folder viewMode or the smart-list option. */
export async function switchMode(app: App, v: ViewRef, mode: ViewMode): Promise<void> {
  if (!allowedModes(v).includes(mode)) return;
  await app.setViewMode(v, mode);
  go(viewPath(v, mode));
}

/** The View row of the list menu: List, Kanban, Timeline (Timeline only where it is offered, VIEW-022). */
export function ViewModeButtons({ view, onPick }: { view: ViewRef; onPick?: () => void }): JSX.Element {
  const app = useApp();
  const cur = app.route.mode;
  return (
    <>
      {allowedModes(view).map((m) => (
        <button
          key={m}
          className={`icon-btn sm${cur === m ? " on" : ""}`}
          title={ICONS[m].label}
          aria-label={`${ICONS[m].label} view`}
          data-testid={`view-mode-${m}`}
          onClick={() => {
            onPick?.();
            void switchMode(app, view, m);
          }}
        >
          {ICONS[m].icon}
        </button>
      ))}
    </>
  );
}
