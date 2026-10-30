/*
================================================================================
FILE: frontend/src/components/NetworkConnection.tsx
================================================================================

SUMMARY
    The Connection section of Settings → Network (external-access 5.5, Stage
    4): how Semantic Studio reaches the internet on a corporate network. The
    proxy, as one of three choices; the certificates trusted, with an
    optional certificate file added on top; and Test connection.

BASIC IDEA
    The proxy choice applies on Save, for this section alone: a half-typed
    proxy must never be used, while the rest of the tab keeps applying at
    once. The server judges every field (network_broker.py); a refusal comes
    back naming its fields, each sentence stands under its field tied by
    aria-describedby, and the first refused field takes focus. Save is
    aria-disabled while it is on its way, never disabled, so focus stays.

    The choice is a native radio group, so Tab reaches it and the arrow keys
    move it. *Use my system's proxy settings* is the default and says what
    the system offers now; *Manual* shows its fields; any proxy choice shows
    D-070's residual in one sentence.

    The certificate file is chosen with the browser's own picker, through a
    button (Enter or Space); the server receives the bytes, never a path. A
    file applies at once: it is a whole thing, never half-typed. Remove gives
    focus back to *Choose a file…*, as the row it was on is gone.

    Test connection fetches the RDF vocabulary through the **saved**
    settings; its answer is said in a polite live region, as are Save, a
    file added and a file removed. Every state is a sentence; colour adds
    nothing (AC-47).

INPUTS / INPUT SOURCES
    - GET /api/network/connection, read once when the tab opens.
    - The person's choices and typing.

EXPECTED OUTPUT
    - The section, between Work offline and the sites list.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getNetworkConnection,
  removeNetworkCertificate,
  saveNetworkConnection,
  testNetworkConnection,
  uploadNetworkCertificate,
} from "../api";
import {
  MODES,
  MODE_LABELS,
  PROXY_RESIDUAL,
  certificateLine,
  firstRefused,
  noProxyList,
  noProxyText,
  portText,
  portValue,
  refusedFields,
  systemProxyLine,
  trustLine,
  type ConnectionField,
} from "../connectionWords";
import type { NetworkConnection as Connection, ProxyMode } from "../types";

interface Fields {
  httpsHost: string;
  httpsPort: string;
  httpHost: string;
  httpPort: string;
  noProxy: string;
}

function fieldsOf(connection: Connection): Fields {
  return {
    httpsHost: connection.https.host,
    httpsPort: portText(connection.https.port),
    httpHost: connection.http.host,
    httpPort: portText(connection.http.port),
    noProxy: noProxyText(connection.noProxy),
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function NetworkConnection() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [mode, setMode] = useState<ProxyMode>("system");
  const [fields, setFields] = useState<Fields | null>(null);
  const [refused, setRefused] = useState<Partial<Record<ConnectionField, string>>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [fileRefused, setFileRefused] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [testResult, setTestResult] = useState("");
  const [busy, setBusy] = useState<"save" | "file" | "test" | null>(null);
  const [focusField, setFocusField] = useState<ConnectionField | null>(null);
  const inputs = useRef<Partial<Record<ConnectionField, HTMLInputElement | null>>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const [refocusChoose, setRefocusChoose] = useState(false);

  const take = useCallback((next: Connection) => {
    setConnection(next);
    setMode(next.mode);
    setFields(fieldsOf(next));
  }, []);

  useEffect(() => {
    let live = true;
    getNetworkConnection()
      .then((c) => live && take(c))
      .catch((e: unknown) => live && setFailed(message(e)));
    return () => {
      live = false;
    };
  }, [take]);

  // A refused field takes focus once it is rendered with its sentence.
  useEffect(() => {
    if (!focusField) return;
    inputs.current[focusField]?.focus();
    setFocusField(null);
  }, [focusField]);

  // Remove takes away the row its button stood in; focus goes back to the
  // picker's button, which stays.
  useEffect(() => {
    if (!refocusChoose) return;
    chooseButton.current?.focus();
    setRefocusChoose(false);
  }, [refocusChoose]);

  const edit = (name: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value;
    setFields((f) => (f ? { ...f, [name]: value } : f));
  };

  const save = useCallback(async () => {
    if (!fields || busy) return;
    setBusy("save");
    setFailed(null);
    try {
      const saved = await saveNetworkConnection({
        mode,
        https: { host: fields.httpsHost.trim(), port: portValue(fields.httpsPort) },
        http: { host: fields.httpHost.trim(), port: portValue(fields.httpPort) },
        noProxy: noProxyList(fields.noProxy),
      });
      take(saved);
      setRefused({});
      setStatus(`Saved. ${MODE_LABELS[saved.mode]}.`);
    } catch (e: unknown) {
      const named = e instanceof ApiError ? refusedFields(e.detail) : null;
      if (named && Object.keys(named).length > 0) {
        setRefused(named);
        setStatus("Not saved. Correct the fields marked.");
        setFocusField(firstRefused(named));
      } else {
        setFailed(message(e));
      }
    } finally {
      setBusy(null);
    }
  }, [busy, fields, mode, take]);

  const choose = () => {
    if (busy) return;
    fileInput.current?.click();
  };

  const picked = useCallback(
    async (input: HTMLInputElement) => {
      const file = input.files?.[0];
      // The same file chosen twice must still fire a change.
      input.value = "";
      if (!file) return;
      setBusy("file");
      setFileRefused(null);
      try {
        const next = await uploadNetworkCertificate(file);
        setConnection(next);
        setStatus(`Added ${next.caFile?.name ?? file.name} to the trusted certificates.`);
      } catch (e: unknown) {
        setFileRefused(message(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const remove = useCallback(async () => {
    if (busy) return;
    setBusy("file");
    try {
      const next = await removeNetworkCertificate();
      setConnection(next);
      setFileRefused(null);
      setStatus("Removed the certificate file. Only your system's certificates are trusted.");
      setRefocusChoose(true);
    } catch (e: unknown) {
      setFileRefused(message(e));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const test = useCallback(async () => {
    if (busy) return;
    setBusy("test");
    setTestResult("Testing the connection…");
    try {
      const result = await testNetworkConnection();
      setTestResult(result.message);
    } catch (e: unknown) {
      setTestResult(`The test could not run: ${message(e)}`);
    } finally {
      setBusy(null);
    }
  }, [busy]);

  if (!connection || !fields) {
    return (
      <section className="network-section" aria-labelledby="network-connection-heading">
        <h3 id="network-connection-heading">Connection</h3>
        <p className={failed ? "detail-error" : "network-state"}>{failed ?? "Loading…"}</p>
      </section>
    );
  }

  // `hidden` begins the label with words only a screen reader says: two
  // fields both announced as "Port" would not say which proxy they belong to.
  const field = (
    name: ConnectionField,
    label: string,
    extra: { inputMode?: "numeric"; hint?: string; hidden?: string } = {},
  ) => {
    const id = `network-${name}`;
    const error = refused[name];
    const described = [extra.hint ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ");
    return (
      <div className={`network-field network-field-${name}`}>
        <label htmlFor={id}>
          {extra.hidden && <span className="visually-hidden">{extra.hidden} </span>}
          {label}
        </label>
        <input
          id={id}
          ref={(el) => {
            inputs.current[name] = el;
          }}
          type="text"
          inputMode={extra.inputMode}
          autoComplete="off"
          spellCheck={false}
          value={fields[name]}
          onChange={edit(name)}
          aria-invalid={error ? true : undefined}
          aria-describedby={described || undefined}
        />
        {extra.hint && (
          <p id={`${id}-hint`} className="network-hint">
            {extra.hint}
          </p>
        )}
        {error && (
          <p id={`${id}-error`} className="form-error">
            {error}
          </p>
        )}
      </div>
    );
  };

  return (
    <section className="network-section" aria-labelledby="network-connection-heading">
      <h3 id="network-connection-heading">Connection</h3>

      <fieldset className="network-proxy">
        <legend>Proxy</legend>
        {MODES.map((m) => (
          <label key={m} className="network-proxy-choice">
            <input
              type="radio"
              name="network-proxy-mode"
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            {MODE_LABELS[m]}
          </label>
        ))}
      </fieldset>

      {mode === "system" && <p className="network-state">{systemProxyLine(connection.systemProxy)}</p>}
      {mode === "none" && (
        <p className="network-state">Semantic Studio connects to each site directly.</p>
      )}
      {mode === "manual" && (
        <div className="network-manual">
          <div className="network-pair">
            {field("httpsHost", "HTTPS proxy host")}
            {field("httpsPort", "Port", { inputMode: "numeric", hidden: "HTTPS proxy" })}
          </div>
          <div className="network-pair">
            {field("httpHost", "HTTP proxy host", { hint: "Leave both HTTP fields empty to use the HTTPS proxy." })}
            {field("httpPort", "Port", { inputMode: "numeric", hidden: "HTTP proxy" })}
          </div>
          {field("noProxy", "Don't use the proxy for", {
            hint: "Host names, separated by commas.",
          })}
        </div>
      )}
      {mode !== "none" && <p className="network-state">{PROXY_RESIDUAL}</p>}

      <div className="network-actions">
        <button type="button" className="primary" aria-disabled={busy === "save"} onClick={() => void save()}>
          Save proxy settings
        </button>
      </div>

      <h4 className="network-subheading">Certificates</h4>
      <p className="network-state">{trustLine(connection.trust)}</p>
      <div className="network-row network-ca">
        <span>{certificateLine(connection.caFile)}</span>
        {connection.caFile && (
          <button
            type="button"
            className="ghost"
            aria-disabled={busy === "file"}
            aria-label={`Remove the certificate file ${connection.caFile.name}`}
            onClick={() => void remove()}
          >
            Remove
          </button>
        )}
      </div>
      <p id="network-ca-hint" className="network-hint">
        Your IT department can give you the company's root certificate as a .pem, .crt or .cer
        file. It is added to the certificates already trusted, never in their place.
      </p>
      <button
        ref={chooseButton}
        type="button"
        aria-disabled={busy === "file"}
        aria-describedby={fileRefused ? "network-ca-hint network-ca-error" : "network-ca-hint"}
        onClick={choose}
      >
        Choose a file…
      </button>
      {fileRefused && (
        <p id="network-ca-error" className="form-error">
          {fileRefused}
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".pem,.crt,.cer"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="network-ca-file"
        onChange={(e) => void picked(e.currentTarget)}
      />

      <div className="network-actions">
        <button type="button" aria-disabled={busy === "test"} onClick={() => void test()}>
          Test connection
        </button>
        <p className="network-hint">Uses the saved settings.</p>
      </div>
      <p className="network-test-result" role="status" aria-live="polite">
        {testResult}
      </p>
      {failed && <p className="detail-error">{failed}</p>}

      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
