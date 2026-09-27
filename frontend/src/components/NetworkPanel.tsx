/*
================================================================================
FILE: frontend/src/components/NetworkPanel.tsx
================================================================================

SUMMARY
    Network settings: the switch that makes Semantic Studio work offline, the
    sites the user has allowed or blocked (each revocable), and the most recent
    connections the application made or refused. The user's view of, and
    control over, everything the network broker does (external-access Stage 1).

BASIC IDEA
    A modal like About, opened from a header control beside it. It makes two
    requests when it opens -- the policy and the activity log -- and none
    before, so the application's mount budget of one request is untouched.

    Three sections, each stated in text:
      * Work offline, a `role="switch"` button whose `aria-checked` is the
        state and whose label says it. Offline refuses every connection with no
        dialog; it is a normal state, not an error, so it is worded as one.
      * Allowed and blocked sites. Remembered decisions only; a just-once
        Allow is spent by the action it was given for and is never a standing
        permission. Revoke returns the site to Ask. Focus moves to the
        section heading after a revoke, because the row that held it is gone.
      * Recent connections, newest first, capped by the server at 200. Each row
        says what happened in words (networkWords.ts); colour adds nothing.

    The corporate network settings (proxy, certificate file, Test connection)
    are a later stage (backlog X-7) and deliberately have no placeholder here.

    Changes are announced in a polite live region, so a screen reader user
    hears that offline took effect or that a site was revoked.

INPUTS / INPUT SOURCES (props)
    - onClose: for the close control, Escape and the backdrop. Focus returns to
      the control that opened the panel (useDialogTrap).
    - The policy and activity from api.ts.

EXPECTED OUTPUT
    - The dialog and its backdrop.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getNetworkActivity,
  getNetworkPolicy,
  revokeNetworkGrant,
  setNetworkOffline,
} from "../api";
import { outcomeLabel, purposeLabel } from "../networkWords";
import type { NetworkActivity, NetworkPolicy } from "../types";
import { useDialogTrap } from "./useDialogTrap";

interface Props {
  onClose: () => void;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export default function NetworkPanel({ onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sitesHeadingRef = useRef<HTMLHeadingElement>(null);
  const [policy, setPolicy] = useState<NetworkPolicy | null>(null);
  const [activity, setActivity] = useState<NetworkActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useDialogTrap(panelRef, headingRef, onClose);

  useEffect(() => {
    let live = true;
    Promise.all([getNetworkPolicy(), getNetworkActivity()])
      .then(([p, a]) => {
        if (!live) return;
        setPolicy(p);
        setActivity(a);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const toggleOffline = useCallback(async () => {
    if (!policy) return;
    const next = !policy.offline;
    // Not disabled while saving: disabling the focused switch would blur it to
    // <body> (measured in Chrome on the remove control). A second press while
    // the first is in flight is simply ignored.
    if (saving) return;
    setSaving(true);
    try {
      const result = await setNetworkOffline(next);
      setPolicy({ ...policy, offline: result.offline });
      setStatus(
        result.offline
          ? "Working offline. Semantic Studio will not connect to any site."
          : "Working online. Semantic Studio asks before connecting to a site.",
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [policy, saving]);

  const revoke = useCallback(
    async (id: string, host: string) => {
      if (!policy) return;
      try {
        await revokeNetworkGrant(id);
        setPolicy({ ...policy, grants: policy.grants.filter((g) => g.id !== id) });
        setStatus(`Removed your decision for ${host}. It will be asked about again.`);
        sitesHeadingRef.current?.focus();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [policy],
  );

  const offline = policy?.offline ?? false;

  return (
    <>
      <div className="modal-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="network-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="network-panel-heading"
      >
        <button className="icon-btn about-close" onClick={onClose} aria-label="Close Network settings">
          ✕
        </button>
        <h2 id="network-panel-heading" ref={headingRef} tabIndex={-1} className="network-heading">
          Network settings
        </h2>

        {error && <p className="detail-error">{error}</p>}
        {!policy && !error && <p className="detail-note">Loading…</p>}

        {policy && (
          <>
            <section className="network-section" aria-labelledby="network-offline-heading">
              <h3 id="network-offline-heading">Connections</h3>
              <button
                type="button"
                role="switch"
                aria-checked={offline}
                className={offline ? "network-switch on" : "network-switch"}
                onClick={() => void toggleOffline()}
              >
                <span className="network-switch-track" aria-hidden="true">
                  <span className="network-switch-thumb" />
                </span>
                Work offline
              </button>
              <p className="network-state">
                {offline
                  ? "Offline. Semantic Studio does not connect to any site, and does not ask."
                  : "Online. Semantic Studio asks before connecting to a site you have not decided about."}
              </p>
            </section>

            <section className="network-section" aria-labelledby="network-sites-heading">
              <h3 id="network-sites-heading" ref={sitesHeadingRef} tabIndex={-1}>
                Allowed and blocked sites
              </h3>
              {policy.grants.length === 0 ? (
                <p className="network-empty">No sites allowed yet.</p>
              ) : (
                <ul className="network-list">
                  {policy.grants.map((g) => (
                    <li key={g.id} className="network-row">
                      <span className="network-host">{g.host}</span>
                      <span className="network-purpose">{purposeLabel(g.capability)}</span>
                      <span className="network-decision">
                        {g.decision === "allow" ? "Always allowed" : "Blocked"}
                      </span>
                      <button
                        className="ghost"
                        onClick={() => void revoke(g.id, g.host)}
                        aria-label={`Revoke your decision for ${g.host}, ${purposeLabel(g.capability)}`}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="network-section" aria-labelledby="network-activity-heading">
              <h3 id="network-activity-heading">Recent connections</h3>
              {activity && activity.length === 0 ? (
                <p className="network-empty">No connections yet.</p>
              ) : (
                <ol className="network-list network-activity">
                  {(activity ?? []).map((a, i) => (
                    <li key={`${a.time}-${i}`} className="network-row">
                      <span className="network-when">{when(a.time)}</span>
                      <span className="network-outcome">{outcomeLabel(a.outcome)}</span>
                      <span className="network-purpose">{purposeLabel(a.capability)}</span>
                      <span className="network-url" title={a.url}>
                        {a.url}
                      </span>
                      {a.bytes > 0 && (
                        <span className="network-bytes">{a.bytes.toLocaleString()} bytes</span>
                      )}
                      {!a.encrypted && <span className="network-plain">not encrypted</span>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}

        <p className="visually-hidden" role="status" aria-live="polite">
          {status}
        </p>
      </div>
    </>
  );
}
