import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is making the current request. Set by the multi-user front for every request it hands to an account's
 * app; read by activity and comments so entries written into a shared list's (owner's) store name the member
 * who acted. Absent in single-user mode, where the store's own user is the actor.
 */
export interface Actor {
  userId: number;
  name: string;
  email: string;
  picture: string | null;
}

export const actorAls = new AsyncLocalStorage<Actor>();
export const currentActor = (): Actor | undefined => actorAls.getStore();
