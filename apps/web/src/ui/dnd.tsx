import { DndContext, DragOverlay, PointerSensor, pointerWithin, closestCenter, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useState, type ReactNode } from "react";
import { orderBetween, type Task } from "../lib/core";
import { addDays, startOfDay } from "../lib/dates";
import type { ViewRef } from "../model/views";
import { useApp } from "./ctx";
import { moveToDay } from "./taskutil";

/**
 * The visible order of the current list, written by the active view on render. Board views (kanban, matrix)
 * register `onDrop`, which handles drops on their own cards and lanes before the list reorder runs.
 */
export const dragModel: { ids: string[]; view: ViewRef | null; onDrop?: (activeId: string, overId: string) => Promise<void> } = { ids: [], view: null };

/** Lanes and quadrants: droppable containers that lose to a card under the pointer. */
const isLane = (id: string): boolean => id.startsWith("drop:lane:") || id.startsWith("drop:quad:");

/** Sidebar rows are droppable: drop:project:<id>, drop:tag:<name>, drop:smart:<today|tomorrow|week>. */
export function useDropTarget(id: string, disabled = false): { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean } {
  const { setNodeRef, isOver } = useDroppable({ id, disabled });
  return { setNodeRef, isOver };
}

// sidebar targets win when the pointer is inside them, then a card under the pointer, then a lane
// (kanban column, matrix quadrant); otherwise sort among rows
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const side = within.filter((c) => String(c.id).startsWith("drop:") && !isLane(String(c.id)));
  if (side.length) return side;
  const cards = within.filter((c) => !String(c.id).startsWith("drop:") && c.id !== args.active.id);
  if (cards.length) return cards;
  const lanes = within.filter((c) => isLane(String(c.id)));
  if (lanes.length) return lanes;
  return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => !String(c.id).startsWith("drop:")) });
};

export function DndShell({ children }: { children: ReactNode }): JSX.Element {
  const app = useApp();
  const { repo, tasks, now, toast, selected } = app;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [active, setActive] = useState<Task | null>(null);

  const onStart = (e: DragStartEvent): void => {
    setActive(tasks.find((t) => t.id === e.active.id) ?? null);
  };

  const onEnd = async (e: DragEndEvent): Promise<void> => {
    setActive(null);
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || overId === id) return;
    const dragged = selected.has(id) ? [...selected] : [id];
    if (dragModel.onDrop && (!overId.startsWith("drop:") || isLane(overId))) {
      await dragModel.onDrop(id, overId);
      return;
    }
    if (overId.startsWith("drop:") && !isLane(overId)) {
      const parts = overId.split(":");
      const kind = parts[1] ?? "";
      const key = parts.slice(2).join(":");
      if (kind === "project") {
        await repo.moveTasks(dragged, key);
        toast(`Moved to ${app.projectName(key)}`, () => void repo.undo());
      } else if (kind === "tag") {
        await repo.updateEach(dragged, (t) => ({ tags: [...new Set([...(t.tags ?? []), key])] }), "Tag added");
        toast("Tag added", () => void repo.undo());
      } else if (kind === "smart") {
        const today = startOfDay(now);
        const day = key === "tomorrow" ? addDays(today, 1) : today;
        await repo.updateEach(dragged, (t) => moveToDay(t, day), "Date changed");
        toast("Date changed", () => void repo.undo());
      }
      return;
    }
    // reorder inside the list: new sortOrder between the neighbours at the drop position
    const ids = dragModel.ids;
    const from = ids.indexOf(id);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const order = ids.filter((x) => x !== id);
    order.splice(to, 0, id);
    const byId = new Map(tasks.map((x) => [x.id, x]));
    // neighbours among siblings (same parent)
    const sibs = order.filter((x) => (byId.get(x)?.parentId ?? null) === (t.parentId ?? null));
    const i = sibs.indexOf(id);
    const before = i > 0 ? byId.get(sibs[i - 1]!)?.sortOrder : undefined;
    const after = i < sibs.length - 1 ? byId.get(sibs[i + 1]!)?.sortOrder : undefined;
    const r = orderBetween(before, after);
    if (r.needsRebalance) await repo.renumber(sibs);
    else await repo.reorder(id, r.order);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onStart} onDragEnd={(e) => void onEnd(e)} onDragCancel={() => setActive(null)}>
      {children}
      <DragOverlay dropAnimation={null}>{active ? <div className="drag-ghost">{selected.has(active.id) && selected.size > 1 ? `${selected.size} tasks` : active.title}</div> : null}</DragOverlay>
    </DndContext>
  );
}
