// Fetch extra PTDATA pointnames / EFIT scalars into the current shot file
// (POST /api/fetch with `signals`, merged server-side) and follow the job's
// progress stream. Shared by the QS tab's custom-signal panel and the global
// plasma-signal strip, using the same backend + credentials as the left-rail pull.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { apiBase, startFetch, usingLiveBackend } from "./api";

// A valid PTDATA pointname (DIII-D custom-signal entry): letters/digits/underscore,
// e.g. `Ip`, `betan`, `bt`, `MPI66M020D`. Anything else is rejected before fetch.
export const POINTNAME_RE = /^[A-Za-z0-9_]+$/;

// Shown when a fetch is attempted (or would stall) without the left-rail credentials.
export const CREDS_HINT =
  "Enter your username in the left “Pull a shot” panel (plus password/Duo if your "
  + "account needs them) to fetch new signals.";

/** Split an entry box (comma- or space-separated) into names. */
export const splitSignalNames = (text: string): string[] =>
  text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

export function useSignalFetch(machine: string, onDone: (names: string[]) => void) {
  const fetchCreds = useStore((s) => s.fetchCreds);
  const device = useStore((s) => s.device);
  const [busy, setBusy] = useState(false);
  const [frac, setFrac] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  useEffect(() => () => esRef.current?.close(), []); // close stream on unmount

  // remote/mdsthin both require a GA username (password/Duo too unless key auth) —
  // without it the cluster job hangs at 0%, so we block up-front with a clear hint.
  const needsCreds = fetchCreds.backend === "remote" || fetchCreds.backend === "mdsthin";
  const credsMissing = needsCreds && !fetchCreds.username.trim();

  const fetchSignals = useCallback((names: string[]) => {
    if (!names.length || names.some((n) => !POINTNAME_RE.test(n))) return;
    if (!usingLiveBackend()) { setMsg("✗ no live backend configured — run the packaged app or set VITE_API_BASE"); return; }
    if (credsMissing) { setMsg(`✗ ${CREDS_HINT}`); return; }
    setBusy(true); setFrac(0); setMsg("fetching…");
    void (async () => {
      try {
        const { job_id } = await startFetch({
          shot: Number(machine),
          signals: names,
          backend: fetchCreds.backend,
          username: fetchCreds.username || undefined,
          password: fetchCreds.password || undefined,
          duo: fetchCreds.duoMode === "push" ? "1" : fetchCreds.duoPasscode || undefined,
          device: device || undefined,
        });
        esRef.current?.close();
        const es = new EventSource(`${apiBase()}/api/fetch/${job_id}/stream`);
        esRef.current = es;
        // Watchdog: if the job never moves off 0% it is almost always a stuck
        // login (missing/incorrect password or an unanswered Duo push). Surface a
        // credentials hint instead of an eternal 0% spinner.
        const timer: { id?: ReturnType<typeof setTimeout> } = {};
        const close = () => {
          clearTimeout(timer.id);
          es.close();
          if (esRef.current === es) esRef.current = null;
        };
        let moved = false;
        timer.id = setTimeout(() => {
          close();
          setMsg(`✗ no progress after 30s — likely a login issue. ${CREDS_HINT}`);
          setBusy(false);
        }, 30000);
        es.onmessage = (e: MessageEvent) => {
          const f = JSON.parse(e.data as string);
          setFrac(f.progress ?? 0);
          setMsg(f.msg ?? null);
          if (!moved && (f.progress ?? 0) > 0) { moved = true; clearTimeout(timer.id); }
          if (f.status === "done") {
            close();
            onDone(names);
            setMsg(`✓ fetched ${names.length} signal(s)`);
            setBusy(false);
          } else if (f.status === "error") {
            close();
            setMsg(`✗ ${f.error}`);
            setBusy(false);
          }
        };
        es.onerror = () => {
          close();
          setMsg("✗ progress stream lost (the pull may still be running)");
          setBusy(false);
        };
      } catch (e) {
        setMsg(String(e));
        setBusy(false);
      }
    })();
  }, [machine, device, fetchCreds, credsMissing, onDone]);

  return { busy, frac, msg, credsMissing, fetchSignals };
}
