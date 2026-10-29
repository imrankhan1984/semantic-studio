/*
================================================================================
FILE: frontend/src/components/useLoadRun.tsx
================================================================================

SUMMARY
    One ontology load and everything said about it while it runs: the step it
    is on, its bar, its Cancel, what a Cancel ended with, and the failure. The
    Load dialog's file and address tabs and Settings → Library's catalogue
    both use it, so a load reads the same wherever it starts
    (home-and-settings 5.3, 5.4).

BASIC IDEA
    It was the Load dialog's own until the catalogue moved out of that dialog
    into Settings (home-and-settings 5.3). Two copies of the cancel rules would
    have drifted within a build, and those rules are load-progress's whole
    substance: an answer is applied only while its load is still the current
    one, a file still being sent is stopped whatever the server says, and
    unmounting cancels.

    The ref is the load's identity, the state is what the status draws. The
    seconds tick once a second while a load runs; only the visible sentence
    reads them, and the live region speaks each step once (load-progress 5.4).

    Where focus goes after a Cancel is the caller's: it alone holds the
    controls a load starts from. The callback is read through a ref, so the
    caller need not keep it stable.

INPUTS / INPUT SOURCES
    - onLoaded: the summary of a load that finished while still current.
    - onLibraryChanged: a cancel came too late, so the library has an entry.
    - focusOrigin: give focus back to where a cancelled load started.
    - api.ts's cancelLoad, and loadWords.ts's sentences.

EXPECTED OUTPUT
    - The run, its error, startLoad, cancelRun, statusAt (the status under a
      control) and the announcement for one polite live region.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { ApiError, cancelLoad, type LoadOptions } from "../api";
import { STOPPED, TOO_LATE, newLoadId, stepAnnouncement, stepSentence, type LoadStep } from "../loadWords";
import type { OntologySummary } from "../types";

/** Where a load started: the status stands there, and focus goes back there. */
export type LoadOrigin = { tab: "file" } | { tab: "url" } | { tab: "suggested"; entryId: string };

export function sameOrigin(a: LoadOrigin, b: LoadOrigin): boolean {
  return a.tab === b.tab && (a.tab !== "suggested" || a.entryId === (b as { entryId: string }).entryId);
}

/** The load running now. `size` is a file's; null for a web address. */
interface LoadRun {
  id: string;
  origin: LoadOrigin;
  controller: AbortController;
  started: number;
  name: string;
  size: number | null;
  sending: boolean;
  sent: number;
  total: number;
}

/** What went wrong, and for a file no parser read, the parsers' own text. */
export interface LoadError {
  message: string;
  technical: string | null;
}

/** A failed load's `parse_error` carries the raw text apart from its
 *  sentence (load-and-shapes 5.1); anything else is its message alone. */
export function loadError(e: unknown): LoadError {
  const message = e instanceof Error ? e.message : String(e);
  const detail = e instanceof ApiError ? e.detail : null;
  if (detail && typeof detail === "object") {
    const { code, technical } = detail as { code?: unknown; technical?: unknown };
    if (code === "parse_error" && typeof technical === "string" && technical) return { message, technical };
  }
  return { message, technical: null };
}

interface Options {
  onLoaded: (summary: OntologySummary) => void;
  onLibraryChanged?: () => void;
  focusOrigin: (origin: LoadOrigin) => void;
}

export function useLoadRun({ onLoaded, onLibraryChanged, focusOrigin }: Options) {
  const runRef = useRef<LoadRun | null>(null);
  const [run, setRun] = useState<LoadRun | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // What a Cancel ended with, standing where the load started.
  const [ended, setEnded] = useState<{ origin: LoadOrigin; text: string } | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const latest = useRef({ onLoaded, onLibraryChanged, focusOrigin });
  latest.current = { onLoaded, onLibraryChanged, focusOrigin };

  // The seconds tick while a load runs; only the visible sentence reads them.
  const runId = run?.id;
  useEffect(() => {
    if (!runId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runId]);

  const startLoad = async (
    origin: LoadOrigin,
    name: string,
    size: number | null,
    request: (options: LoadOptions) => Promise<OntologySummary>,
  ) => {
    if (runRef.current) return;
    const fresh: LoadRun = {
      id: newLoadId(),
      origin,
      controller: new AbortController(),
      started: Date.now(),
      name,
      size,
      sending: size !== null,
      sent: 0,
      total: size ?? 0,
    };
    runRef.current = fresh;
    setRun(fresh);
    setNow(fresh.started);
    setEnded(null);
    setError(null);
    const mine = () => runRef.current?.id === fresh.id;
    try {
      const summary = await request({
        loadId: fresh.id,
        signal: fresh.controller.signal,
        onSent: (sent, total) => {
          if (!mine()) return;
          // On the ref's own object too: Cancel reads `sending` there, and a
          // file all sent may have reached the server whole.
          // Progress fires every few milliseconds; the dialog draws again
          // only when the words, the bar's whole percent or the step change
          // (PR #65 review).
          const shown = (s: number, t: number) =>
            `${stepSentence({ kind: "sending", name, sent: s, total: t })}|${t > 0 ? Math.round((s / t) * 100) : 0}`;
          const before = shown(fresh.sent, fresh.total);
          const wasSending = fresh.sending;
          Object.assign(fresh, { sent, total, sending: sent < total });
          if (shown(sent, total) !== before || fresh.sending !== wasSending) setRun({ ...fresh });
        },
      });
      if (!mine()) return;
      runRef.current = null;
      setRun(null);
      latest.current.onLoaded(summary);
    } catch (e: unknown) {
      if (!mine()) return;
      runRef.current = null;
      setRun(null);
      setError(loadError(e));
    }
  };

  // Cancel, and every way of closing while a load runs (load-progress 5.3).
  // The request is aborted at once, so the dialog stops waiting; the server
  // is asked to throw the result away and says whether it was in time. A
  // file still being sent never reached the server whole, so it is stopped
  // whatever the answer. Closing shows no answer, the dialog being gone, but
  // a load that was too late still refreshes the library; nothing opens.
  const mounted = useRef(true);
  const cancelRun = (closing: boolean) => {
    const current = runRef.current;
    if (!current) return;
    runRef.current = null;
    current.controller.abort();
    setRun(null);
    if (!closing) latest.current.focusOrigin(current.origin);
    const show = (text: string) => {
      if (!closing && mounted.current && !runRef.current) setEnded({ origin: current.origin, text });
    };
    cancelLoad(current.id).then(
      ({ stopped }) => {
        const inTime = stopped || current.sending;
        if (!inTime) latest.current.onLibraryChanged?.();
        show(inTime ? STOPPED : TOO_LATE);
      },
      (e: unknown) => {
        // Not knowing is said as such; the library is read again either way.
        latest.current.onLibraryChanged?.();
        if (!closing && mounted.current && !runRef.current) setError(loadError(e));
      },
    );
  };
  const cancelOnUnmount = useRef(cancelRun);
  cancelOnUnmount.current = cancelRun;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelOnUnmount.current(true);
    };
  }, []);

  const step: LoadStep | null = run
    ? run.size === null
      ? { kind: "downloading", elapsed: Math.max(0, Math.floor((now - run.started) / 1000)) }
      : run.sending
        ? { kind: "sending", name: run.name, sent: run.sent, total: run.total }
        : {
            kind: "reading",
            name: run.name,
            size: run.size,
            elapsed: Math.max(0, Math.floor((now - run.started) / 1000)),
          }
    : null;

  // The status under the control a load started from: the step, its bar and
  // Cancel while it runs; what a Cancel ended with after. Not live: the
  // live region speaks the step once, and never the seconds.
  const statusAt = (origin: LoadOrigin) => {
    if (run && step && sameOrigin(run.origin, origin)) {
      // Sending always has a value, 0 for a file of no bytes: the bar never
      // says reading while the sentence says sending (PR #65 review).
      const share =
        step.kind === "sending" ? (step.total > 0 ? Math.min(100, Math.round((step.sent / step.total) * 100)) : 0) : null;
      return (
        <div className="load-status">
          <p className="load-step">{stepSentence(step)}</p>
          {share !== null ? (
            <div
              className="load-bar"
              role="progressbar"
              aria-label="Sending the file"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={share}
            >
              <div className="load-bar-fill" style={{ width: `${share}%` }} />
            </div>
          ) : (
            <div className="load-bar moving" role="progressbar" aria-label={step.kind === "downloading" ? "Downloading and reading" : "Reading the file"}>
              <div className="load-bar-fill" />
            </div>
          )}
          <button type="button" onClick={() => cancelRun(false)}>
            Cancel
          </button>
        </div>
      );
    }
    if (ended && !run && sameOrigin(ended.origin, origin)) {
      return (
        <div className="load-status">
          <p className="load-step">{ended.text}</p>
        </div>
      );
    }
    return null;
  };

  const announcement = step ? stepAnnouncement(step) : (ended?.text ?? "");

  return { run, ended, error, setError, startLoad, cancelRun, statusAt, announcement };
}

/** A load's failure: the sentence, and the parsers' own text, as text, under
 *  a closed *Technical details* (load-and-shapes 5.1). */
export function LoadErrorView({ error }: { error: LoadError | null }) {
  if (!error) return null;
  return (
    <div className="load-error">
      <p className="detail-error">{error.message}</p>
      {/* Closed by default; the parsers' text is text, never markup. */}
      {error.technical && (
        <details className="technical-details">
          <summary>Technical details</summary>
          <pre>{error.technical}</pre>
        </details>
      )}
    </div>
  );
}
