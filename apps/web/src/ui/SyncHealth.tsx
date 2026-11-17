import { useApp } from "./ctx";

export function syncAge(lastSync: number | null, now: number): string {
  if (lastSync === null) return "Not synced yet";
  const minutes = Math.floor(Math.max(0, now - lastSync) / 60_000);
  if (minutes < 1) return "Last synced just now";
  if (minutes < 60) return `Last synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Last synced ${hours}h ago` : `Last synced ${Math.floor(hours / 24)}d ago`;
}

export function SyncHealth(): JSX.Element {
  const { sync, now, engine } = useApp();
  const stale = sync.pending > 0 && sync.oldestPending != null && now - sync.oldestPending > 24 * 60 * 60 * 1000;
  return (
    <div className={`sync-health${stale ? " sync-health-warning" : ""}`} data-testid="sync-health" role={stale ? "alert" : "status"}>
      <span data-testid="last-sync-age">{syncAge(sync.lastSync, now)}</span>
      {stale && <>
        <span data-testid="offline-sync-warning">Changes have been waiting to sync for over 24 hours. Connect to the server to back them up.</span>
        <button className="btn sm" onClick={() => void engine.sync()} disabled={sync.state === "syncing"}>Sync now</button>
      </>}
    </div>
  );
}
