"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { burstDollars, prefersReducedMotion } from "@/app/(app)/dollar-burst";
import { TOAST_ANIMATION, TOAST_DURATION_MS, TOAST_ENTER_MS, TOAST_LEAVE_MS, TOAST_SHAKE_MS } from "./config";

export type ToastKind = "success" | "error" | "info";

export type ToastInput = {
  message: ReactNode;
  kind?: ToastKind;
  /** Showing a toast with an id that is already up replaces it (and restarts its timer). */
  id?: string;
};

type ToastItem = { id: string; version: number; kind: ToastKind; message: ReactNode };

type ToastApi = {
  show: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
};

const noop: ToastApi = { show: () => "", dismiss: () => {} };
const ToastContext = createContext<ToastApi>(noop);

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((toast: ToastInput) => {
    const id = toast.id ?? `toast-${++nextId}`;
    setToasts((prev) => {
      const existing = prev.find((t) => t.id === id);
      const item: ToastItem = {
        id,
        version: (existing?.version ?? 0) + 1,
        kind: toast.kind ?? "info",
        message: toast.message,
      };
      return existing ? prev.map((t) => (t.id === id ? item : t)) : [...prev, item];
    });
    return id;
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col items-start gap-4"
      >
        {toasts.map((t) => (
          <Toast key={`${t.id}:${t.version}`} item={t} onRemove={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const DOT: Record<ToastKind, string> = {
  success: "bg-green-500",
  error: "bg-red-500",
  info: "bg-zinc-400",
};

function canAnimate(el: HTMLElement | null): el is HTMLElement {
  return TOAST_ANIMATION && !!el && typeof el.animate === "function";
}

function Toast({ item, onRemove }: { item: ToastItem; onRemove: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef(TOAST_DURATION_MS);
  const startedAt = useRef(0);
  const leaving = useRef(false);
  const removeRef = useRef(onRemove);
  useEffect(() => {
    removeRef.current = onRemove;
  });

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    if (timer.current) clearTimeout(timer.current);
    const remove = () => removeRef.current();
    const el = ref.current;
    if (!canAnimate(el)) return remove();
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TOAST_LEAVE_MS, easing: "ease-in", fill: "forwards" });
    fade.finished.then(remove, remove);
  }, []);

  const start = useCallback(() => {
    if (leaving.current || timer.current) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(leave, remaining.current);
  }, [leave]);

  const pause = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  }, []);

  useEffect(() => {
    start();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [start]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!canAnimate(el)) return;
    const reduced = prefersReducedMotion();
    const enter = el.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: "translateY(16px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
      { duration: TOAST_ENTER_MS, easing: "ease-out" },
    );
    if (reduced) return;
    enter.finished.then(
      () => {
        if (leaving.current || !el.isConnected) return;
        el.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(-3px)" },
            { transform: "translateX(3px)" },
            { transform: "translateX(-2px)" },
            { transform: "translateX(2px)" },
            { transform: "translateX(0)" },
          ],
          { duration: TOAST_SHAKE_MS, easing: "ease-in-out" },
        );
        const rect = el.getBoundingClientRect();
        burstDollars(rect.left + rect.width - 20, rect.top + 4, Math.random, { count: 3 + Math.floor(Math.random() * 3) });
      },
      () => {},
    );
  }, []);

  return (
    <div
      ref={ref}
      role={item.kind === "error" ? "alert" : "status"}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
      className="pointer-events-auto relative flex w-full items-start gap-2.5 rounded-lg border border-black/15 bg-white py-2.5 pl-3 pr-2 text-sm text-zinc-800 shadow-lg dark:border-white/20 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[item.kind]}`} />
      <div className="min-w-0 flex-1">{item.message}</div>
      <button
        type="button"
        onClick={leave}
        aria-label="Dismiss notification"
        className="-my-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-black/[.05] hover:text-zinc-700 dark:hover:bg-white/[.08] dark:hover:text-zinc-200"
      >
        ×
      </button>
      <span
        aria-hidden="true"
        className="absolute -bottom-[6px] left-5 h-3 w-3 rotate-45 border-b border-r border-black/15 bg-white dark:border-white/20 dark:bg-zinc-900"
      />
    </div>
  );
}
