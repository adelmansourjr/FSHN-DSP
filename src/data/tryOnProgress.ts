// Lightweight try-on progress pub/sub for the demo app
export type TryOnProgressState = {
  visible: boolean;
  status: 'idle' | 'generating' | 'ready';
  modelName: string | null;
  modelUri: string | null; // final result uri when ready
  navigateToRoute?: string | null;
  totalSteps: number;
  completedSteps: number;
};

let state: TryOnProgressState = {
  visible: false,
  status: 'idle',
  modelName: null,
  modelUri: null,
  navigateToRoute: 'TryOn',
  totalSteps: 0,
  completedSteps: 0,
};

type Listener = (s: TryOnProgressState) => void;
const listeners: Listener[] = [];
const pressListeners: Array<() => void> = [];

function notify() {
  listeners.slice().forEach((l) => l(state));
}

export function getTryOnProgress() {
  return { ...state };
}

export function subscribeTryOnProgress(cb: Listener) {
  listeners.push(cb);
  try { cb(state); } catch {}
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function subscribeTryOnPress(cb: () => void) {
  pressListeners.push(cb);
  return () => {
    const idx = pressListeners.indexOf(cb);
    if (idx >= 0) pressListeners.splice(idx, 1);
  };
}

export function emitTryOnProgressPress() {
  pressListeners.slice().forEach((f) => f());
}

export function startTryOnProgress(opts: { modelName?: string | null; modelUri?: string | null; totalSteps?: number }) {
  state = {
    visible: true,
    status: 'generating',
    modelName: opts.modelName ?? null,
    modelUri: opts.modelUri ?? null,
    navigateToRoute: 'TryOn',
    totalSteps: opts.totalSteps ?? 0,
    completedSteps: 0,
  };
  notify();
}

export function stepTryOnProgress() {
  state = { ...state, completedSteps: Math.min(state.totalSteps, state.completedSteps + 1) };
  notify();
}

export function completeTryOnProgress(resultUri: string | null) {
  state = { ...state, completedSteps: state.totalSteps, status: 'ready', modelUri: resultUri, visible: true };
  notify();
}

export function resetTryOnProgress() {
  state = { visible: false, status: 'idle', modelName: null, modelUri: null, navigateToRoute: 'TryOn', totalSteps: 0, completedSteps: 0 };
  notify();
}
