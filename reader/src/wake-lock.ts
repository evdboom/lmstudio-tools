import { useEffect, useRef } from "react";

// The browser Screen Wake Lock API only prevents the display from sleeping while
// the tab is visible, and it does not survive the workstation being locked. It is
// a best-effort supplement to the server-side wake lock used while waiting on the model.
export function useScreenWakeLock(active: boolean): void {
  const sentinel = useRef<WakeLockSentinel>();

  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let cancelled = false;

    async function request() {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await lock.release();
          return;
        }
        sentinel.current = lock;
      } catch {
        // Ignored: some browsers refuse the lock (e.g. low battery); narration still works.
      }
    }

    void request();

    function onVisibilityChange() {
      if (document.visibilityState === "visible") void request();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void sentinel.current?.release();
      sentinel.current = undefined;
    };
  }, [active]);
}
