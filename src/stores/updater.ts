import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { api, errorMessage } from "@/lib/ipc";

type Phase = "idle" | "checking" | "available" | "downloading" | "error";

interface UpdaterState {
  phase: Phase;
  version: string | null;
  progress: number | null;
  error: string | null;
  checkedAt: number;

  check: () => Promise<void>;
  install: () => Promise<void>;
}

let pending: Update | null = null;

export const useUpdater = create<UpdaterState>((set, get) => ({
  phase: "idle",
  version: null,
  progress: null,
  error: null,
  checkedAt: 0,

  async check() {
    if (get().phase === "checking" || get().phase === "downloading") return;
    if (import.meta.env.DEV) {
      set({ phase: "idle", version: null, checkedAt: Date.now() });
      return;
    }
    set({ phase: "checking", error: null });
    try {
      pending = await check();
      set({
        phase: pending ? "available" : "idle",
        version: pending?.version ?? null,
        checkedAt: Date.now(),
      });
    } catch (e) {
      set({ phase: "error", error: errorMessage(e), checkedAt: Date.now() });
    }
  },

  async install() {
    if (!pending) return;
    let total = 0;
    let done = 0;
    set({ phase: "downloading", progress: 0, error: null });
    try {
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          if (total) set({ progress: done / total });
        }
      });
      await api.relaunchApp();
    } catch (e) {
      set({ phase: "error", error: errorMessage(e), progress: null });
    }
  },
}));
