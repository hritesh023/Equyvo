// Global, route-independent upload state. Uploads that start on the Create page
// keep running (and keep reporting progress) even after the user navigates
// away, because the running promise is detached from the component lifecycle.
// Components subscribe to this store to render progress on any page.

export interface UploadProgressState {
  pct: number;
  phase: string;
}

export interface UploadState {
  isUploading: boolean;
  progress: UploadProgressState | null;
  label: string;
  startedAt: number;
}

type Listener = (state: UploadState) => void;

let state: UploadState = {
  isUploading: false,
  progress: null,
  label: '',
  startedAt: 0,
};

const listeners = new Set<Listener>();

export function getUploadState(): UploadState {
  return state;
}

export function subscribeUpload(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export function setUploadState(patch: Partial<UploadState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) {
    try { l(state); } catch { /* ignore */ }
  }
  try { (window as any).__equyvoUploading = state.isUploading; } catch { /* ignore */ }
}

export function resetUploadState(): void {
  setUploadState({ isUploading: false, progress: null, label: '', startedAt: 0 });
}

// A global promise registry so a second tab/action cannot start a
// concurrent upload while one is already running.
let activePromise: Promise<unknown> | null = null;

export function isUploadRunning(): boolean {
  return activePromise !== null;
}

export function runUploadTask<T>(task: () => Promise<T>): Promise<T> {
  if (activePromise) {
    return activePromise as Promise<T>;
  }
  const p = (async () => {
    try {
      return await task();
    } finally {
      activePromise = null;
      // Do not auto-reset progress here; the task owns its own lifecycle.
    }
  })();
  activePromise = p;
  return p;
}
