import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "../src/data/api";
import {
  DEFAULT_SERVER_URL,
  buildWidgetPayload,
  formatSharedText,
  getApiBase,
  getNativeCsrfToken,
  hasConfirmedServerUrl,
  isCapacitor,
  normalizeServerUrl,
  notificationIntId,
  saveServerUrl,
  scanQrCode,
} from "../src/lib/capacitor";
import { TaskStatus, type Project, type Task } from "../src/lib/core";

function mockStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

describe("Capacitor web bridge", () => {
  const origCap = (globalThis as Record<string, unknown>).Capacitor;
  const origBridge = (globalThis as Record<string, unknown>).NoorNativeBridge;
  const origStorage = (globalThis as Record<string, unknown>).localStorage;

  afterEach(() => {
    if (origCap === undefined) delete (globalThis as Record<string, unknown>).Capacitor;
    else (globalThis as Record<string, unknown>).Capacitor = origCap;
    if (origBridge === undefined) delete (globalThis as Record<string, unknown>).NoorNativeBridge;
    else (globalThis as Record<string, unknown>).NoorNativeBridge = origBridge;
    if (origStorage === undefined) delete (globalThis as Record<string, unknown>).localStorage;
    else (globalThis as Record<string, unknown>).localStorage = origStorage;
  });

  it("stays inactive in standard web environments", () => {
    delete (globalThis as Record<string, unknown>).Capacitor;
    expect(isCapacitor()).toBe(false);
    expect(getApiBase()).toBe("");
    expect(hasConfirmedServerUrl()).toBe(true);
    const api = new Api();
    expect(api.base).toBe("");
    expect(api.url("/api/v1/attachment/a1")).toBe("/api/v1/attachment/a1");
  });

  it("reads default and saved server URL + native CSRF token inside Capacitor", async () => {
    const setServerUrl = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).localStorage = mockStorage();
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { NoorNative: { setServerUrl } },
    };
    (globalThis as Record<string, unknown>).NoorNativeBridge = {
      getCsrfToken: (url: string) => (url.startsWith("https://") ? "native_csrf_123" : ""),
    };

    const testServer = "https://tasks.example.com";
    expect(isCapacitor()).toBe(true);
    expect(hasConfirmedServerUrl()).toBe(false);
    if (!process.env.VITE_DEFAULT_SERVER_URL) {
      expect(DEFAULT_SERVER_URL).toBe("");
      expect(saveServerUrl("")).toBe("");
      expect(hasConfirmedServerUrl()).toBe(false);
    }
    expect(getApiBase()).toBe(DEFAULT_SERVER_URL);
    expect(normalizeServerUrl("  example.ts.net:8207/  ")).toBe("https://example.ts.net:8207");

    const saved = saveServerUrl("http://192.0.2.10:8207///");
    expect(saved).toBe("http://192.0.2.10:8207");
    expect(hasConfirmedServerUrl()).toBe(true);
    expect(setServerUrl).toHaveBeenCalledWith({ url: "http://192.0.2.10:8207" });

    saveServerUrl(testServer);
    expect(getNativeCsrfToken(testServer)).toBe("native_csrf_123");

    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const api = new Api({ fetch: mockFetch as typeof fetch });
    expect(api.base).toBe(testServer);
    await api.post("/api/v2/batch/task", { add: [] });
    expect(mockFetch).toHaveBeenCalledWith(
      `${testServer}/api/v2/batch/task`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Csrftoken": "native_csrf_123" }),
      }),
    );
  });

  it("formats shared text and deterministic notification IDs", () => {
    expect(formatSharedText("Article", "https://example.com")).toBe("Article https://example.com");
    expect(formatSharedText("Title", "Title\nhttps://example.com")).toBe("Title\nhttps://example.com");
    expect(formatSharedText("", "  buy milk  ")).toBe("buy milk");

    const id1 = notificationIntId("task:t1::r1:1000");
    const id2 = notificationIntId("task:t1::r1:1000");
    const id3 = notificationIntId("task:t2::r1:1000");
    expect(id1).toBe(id2);
    expect(id1).toBeGreaterThan(0);
    expect(id1).toBeLessThanOrEqual(0x7fffffff);
    expect(id1).not.toBe(id3);
  });

  it("builds Today widget payload with overdue + today open tasks sorted cleanly", () => {
    const now = new Date(2026, 10, 16, 12, 0, 0).getTime();
    const projects: Project[] = [{ id: "p1", name: "Work", inAll: true } as Project];
    const tasks: Task[] = [
      { id: "future", projectId: "inbox", title: "Tomorrow", status: TaskStatus.Open, startDate: "2026-11-17T09:00:00.000+0000", dueDate: "2026-11-17T09:00:00.000+0000", isAllDay: true } as Task,
      { id: "today_low", projectId: "inbox", title: "Today Low", status: TaskStatus.Open, priority: 1, startDate: "2026-11-16T00:00:00.000+0000", dueDate: "2026-11-16T00:00:00.000+0000", isAllDay: true } as Task,
      { id: "overdue", projectId: "p1", title: "Overdue Task", status: TaskStatus.Open, priority: 0, startDate: "2026-11-14T00:00:00.000+0000", dueDate: "2026-11-14T00:00:00.000+0000", isAllDay: true } as Task,
      { id: "done", projectId: "inbox", title: "Done", status: TaskStatus.Completed, startDate: "2026-11-16T00:00:00.000+0000", isAllDay: true } as Task,
      { id: "note", projectId: "inbox", title: "Note", kind: "NOTE", status: TaskStatus.Open, startDate: "2026-11-16T00:00:00.000+0000", isAllDay: true } as Task,
    ];
    const items = buildWidgetPayload(tasks, projects, "inbox", now, true);
    expect(items.map((x) => x.id)).toEqual(["overdue", "today_low"]);
    expect(items[0]!.dueLabel).toBe("Nov 14");
  });

  it("scans QR codes via CapacitorBarcodeScanner and handles cancellation/errors", async () => {
    await expect(scanQrCode()).rejects.toThrow("scanner_unavailable");

    const scanBarcode = vi.fn().mockResolvedValue({ ScanResult: "  https://tasks.example.com/#pair=tok1  ", format: 0 });
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorBarcodeScanner: { scanBarcode } },
    };

    await expect(scanQrCode()).resolves.toBe("https://tasks.example.com/#pair=tok1");
    expect(scanBarcode).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: 0,
        cameraDirection: 1,
        android: { scanningLibrary: "zxing" },
      }),
    );

    scanBarcode.mockRejectedValueOnce({ code: "OS-PLUG-BARC-0006", message: "User cancelled" });
    await expect(scanQrCode()).resolves.toBeNull();

    scanBarcode.mockRejectedValueOnce(new Error("Camera permission denied"));
    await expect(scanQrCode()).rejects.toThrow("scanner_failed");
  });
});
