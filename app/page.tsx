"use client";

import { useMemo, useState } from "react";

type Status = "pending" | "found" | "not_found" | "error";

type Row = {
  domain: string;
  linkedinUrl: string | null;
  type: string | null;
  finalUrl: string | null;
  source: string | null;
  status: Status;
  error?: string;
};

const BATCH_SIZE = 8; // domains per API request

function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const k = d.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function Page() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);

  const domains = useMemo(() => parseDomains(input), [input]);

  const summary = useMemo(() => {
    const found = rows.filter((r) => r.status === "found").length;
    const notFound = rows.filter((r) => r.status === "not_found").length;
    const errored = rows.filter((r) => r.status === "error").length;
    return { found, notFound, errored };
  }, [rows]);

  async function run() {
    if (domains.length === 0 || running) return;
    setRunning(true);
    setDone(0);

    const initial: Row[] = domains.map((domain) => ({
      domain,
      linkedinUrl: null,
      type: null,
      finalUrl: null,
      source: null,
      status: "pending",
    }));
    setRows(initial);

    const indexByDomain = new Map(domains.map((d, i) => [d, i]));

    for (const batch of chunk(domains, BATCH_SIZE)) {
      try {
        const res = await fetch("/api/find", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: batch }),
        });
        const data = await res.json();
        const results: Row[] = data.results ?? [];
        setRows((prev) => {
          const next = [...prev];
          for (const r of results) {
            const idx = indexByDomain.get(r.domain);
            if (idx !== undefined) next[idx] = r;
          }
          return next;
        });
      } catch {
        setRows((prev) => {
          const next = [...prev];
          for (const d of batch) {
            const idx = indexByDomain.get(d);
            if (idx !== undefined)
              next[idx] = {
                ...next[idx],
                status: "error",
                error: "Request failed",
              };
          }
          return next;
        });
      }
      setDone((d) => d + batch.length);
    }

    setRunning(false);
  }

  function downloadCsv() {
    const header = ["domain", "linkedin_url", "type", "status", "source"];
    const lines = rows.map((r) =>
      [r.domain, r.linkedinUrl ?? "", r.type ?? "", r.status, r.source ?? ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "linkedin-urls.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const pct = domains.length ? Math.round((done / domains.length) * 100) : 0;

  return (
    <div className="wrap">
      <div className="header">
        <h1>
          <span className="badge">in</span> LinkedIn Finder
        </h1>
        <p>
          Paste website domains (one per line). It scans each homepage and pulls
          out the LinkedIn company/profile URL.
        </p>
      </div>

      <div className="panel">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={"stripe.com\nvercel.com\nnotion.so"}
          spellCheck={false}
          disabled={running}
        />
        <div className="row">
          <button onClick={run} disabled={running || domains.length === 0}>
            {running ? (
              <>
                <span className="spinner" /> &nbsp;Scanning…
              </>
            ) : (
              `Find LinkedIn URLs`
            )}
          </button>
          <button
            className="secondary"
            onClick={() => {
              setInput("");
              setRows([]);
              setDone(0);
            }}
            disabled={running}
          >
            Clear
          </button>
          <span className="count">{domains.length} domain(s)</span>
        </div>

        {running && (
          <div className="progress">
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="toolbar">
            <span className="muted">
              {summary.found} found · {summary.notFound} not found ·{" "}
              {summary.errored} error
            </span>
            <button className="secondary" onClick={downloadCsv}>
              Export CSV
            </button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>LinkedIn URL</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.domain}</td>
                  <td className="url">
                    {r.linkedinUrl ? (
                      <>
                        <a
                          href={r.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {r.linkedinUrl}
                        </a>
                        {(r.type || r.source) && (
                          <div className="type-tag">
                            {r.type}
                            {r.source && r.source !== r.finalUrl
                              ? ` · via ${r.source.replace(/^https?:\/\//, "")}`
                              : ""}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="muted">
                        {r.error ? r.error : "—"}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.status === "pending" ? (
                      <span className="pill pending">
                        <span className="spinner" />
                      </span>
                    ) : (
                      <span className={`pill ${r.status}`}>
                        {r.status.replace("_", " ")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
