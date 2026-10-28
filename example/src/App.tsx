import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { UpdateBanner } from "@convex-dev/static-hosting/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

const REPO = "https://github.com/convex/batch-worker";

type WorkerStatus = { kind: "idle" | "running" | "stopped" } | null | undefined;

function App() {
  return (
    <div className="page">
      <UpdateBanner message="A new version is available." buttonText="Reload" />

      <header className="hero">
        <span className="eyebrow">@convex-dev/batch-worker</span>
        <h1>
          One background loop that <span className="accent">batches</span> your
          work.
        </h1>
        <p className="lede">
          Insert rows cheaply, <code>ping</code> the worker, and a single
          self-healing loop drains the queue in batches — restarting if it dies,
          going idle when there's nothing to do. Everything below is live,
          served straight from Convex.
        </p>
        <div className="hero-links">
          <a className="btn ghost" href={REPO} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <a
            className="btn ghost"
            href="https://www.convex.dev/components"
            target="_blank"
            rel="noreferrer"
          >
            Convex Components ↗
          </a>
        </div>
      </header>

      <main className="grid">
        <EventsPanel />
        <ScoresPanel />
        <LlmPanel />
      </main>

      <footer className="footer">
        <p>
          Three named workers, one component. Source in{" "}
          <code>example/convex/</code> —{" "}
          <a href={`${REPO}/tree/main/example/convex/example.ts`}>example.ts</a>,{" "}
          <a href={`${REPO}/tree/main/example/convex/aggregates.ts`}>
            aggregates.ts
          </a>
          , and{" "}
          <a href={`${REPO}/tree/main/example/convex/rateLimited.ts`}>
            rateLimited.ts
          </a>
          . Hosted with{" "}
          <a href="https://github.com/convex/static-hosting">
            @convex-dev/static-hosting
          </a>
          .
        </p>
      </footer>
    </div>
  );
}

/** Colored pill showing a worker's run state. */
function StatusPill({ status }: { status: WorkerStatus }) {
  const kind = status?.kind ?? "never";
  const label =
    kind === "running"
      ? "running"
      : kind === "idle"
        ? "idle"
        : kind === "stopped"
          ? "stopped"
          : "never run";
  return (
    <span className={`pill pill-${kind}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

// ── Panel 1: a plain work queue that sums events ───────────────────────────
function EventsPanel() {
  const totals = useQuery(api.example.getTotals, {});
  const status = useQuery(api.example.workerStatus, {}) as WorkerStatus;
  const addEvent = useMutation(api.example.addEvent);
  const [value, setValue] = useState("1");

  const enqueue = (n: number) => addEvent({ value: n });

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Work queue</h2>
          <p className="tagline">Batch and sum a stream of events.</p>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="controls">
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Event value"
        />
        <button className="btn" onClick={() => enqueue(Number(value) || 0)}>
          Add event
        </button>
        <button
          className="btn subtle"
          onClick={() =>
            Array.from({ length: 25 }, (_, i) => enqueue(i + 1))
          }
        >
          +25
        </button>
      </div>

      <div className="metrics">
        <Metric label="queued" value={totals?.pending ?? 0} />
        <Metric label="processed" value={totals?.count ?? 0} />
        <Metric label="running total" value={totals?.total ?? 0} />
      </div>
    </section>
  );
}

// ── Panel 2: serial aggregate updates, no write contention ─────────────────
const TEAMS = ["Red", "Blue", "Green"] as const;
const TEAM_COLOR: Record<string, string> = {
  Red: "#ef4444",
  Blue: "#3b82f6",
  Green: "#22c55e",
};

function ScoresPanel() {
  const data = useQuery(api.aggregates.getTotals, {});
  const status = useQuery(api.aggregates.workerStatus, {}) as WorkerStatus;
  const recordScore = useMutation(api.aggregates.recordScore);

  const totals = data?.totals ?? {};
  const max = Math.max(1, ...Object.values(totals));

  const rain = () =>
    Array.from({ length: 50 }, () => {
      const team = TEAMS[Math.floor(Math.random() * TEAMS.length)];
      return recordScore({ team, points: 1 + Math.floor(Math.random() * 5) });
    });

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Live scoreboard</h2>
          <p className="tagline">
            One writer folds scores into per-team totals — no OCC conflicts.
          </p>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="controls">
        {TEAMS.map((team) => (
          <button
            key={team}
            className="btn subtle"
            onClick={() => recordScore({ team, points: 3 })}
          >
            {team} +3
          </button>
        ))}
        <button className="btn" onClick={rain}>
          Score rain ×50
        </button>
      </div>

      <div className="bars">
        {TEAMS.map((team) => {
          const total = totals[team] ?? 0;
          return (
            <div key={team} className="bar-row">
              <span className="bar-label">{team}</span>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width: `${(total / max) * 100}%`,
                    background: TEAM_COLOR[team],
                  }}
                />
              </div>
              <span className="bar-value">{total}</span>
            </div>
          );
        })}
      </div>
      <p className="hint">{data?.pending ?? 0} scores waiting in the queue</p>
    </section>
  );
}

// ── Panel 3: rate-limited async LLM batches ────────────────────────────────
const SAMPLE_PROMPTS = [
  "Summarize the batch worker pattern.",
  "Why avoid write contention?",
  "Explain token bucket rate limiting.",
  "What is a debounce window?",
  "When does a loop go idle?",
];

function LlmPanel() {
  const requests = useQuery(api.rateLimited.listRequests, {});
  const stats = useQuery(api.rateLimited.stats, {});
  const status = useQuery(api.rateLimited.workerStatus, {}) as WorkerStatus;
  const submit = useMutation(api.rateLimited.submitRequest);
  const [prompt, setPrompt] = useState("");

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // ~150 tokens each (base context + prompt). The budget is only ~300 tokens
    // per 5s, so a couple of these already exceed it — see rateLimited.ts.
    submit({ prompt: trimmed, inputTokens: 120 + trimmed.length });
  };

  // Enough requests to clearly blow past the budget and back the queue up.
  const flood = () =>
    Array.from({ length: 12 }, (_, i) => send(SAMPLE_PROMPTS[i % SAMPLE_PROMPTS.length]));

  return (
    <section className="card wide">
      <div className="card-head">
        <div>
          <h2>Rate-limited LLM batches</h2>
          <p className="tagline">
            Collect requests, spend a tiny token budget (~300 / 5s), call the
            model async. Exceed it and batches wait their turn.
          </p>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="controls">
        <input
          type="text"
          placeholder="Ask something…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              send(prompt);
              setPrompt("");
            }
          }}
          aria-label="Prompt"
          style={{ flex: 1 }}
        />
        <button
          className="btn"
          onClick={() => {
            send(prompt);
            setPrompt("");
          }}
        >
          Submit
        </button>
        <button className="btn subtle" onClick={flood}>
          Flood ×12
        </button>
      </div>

      <div className="metrics">
        <Metric label="queued" value={stats?.pending ?? 0} />
        <Metric label="in flight" value={stats?.started ?? 0} />
        <Metric label="done" value={stats?.finished ?? 0} />
      </div>

      <ul className="requests">
        {(requests ?? []).length === 0 && (
          <li className="empty">No requests yet — submit one above.</li>
        )}
        {(requests ?? []).map((r, i) => (
          <li key={i} className="request">
            <span className={`badge badge-${r.state}`}>{r.state}</span>
            <span className="prompt">{r.prompt}</span>
            {r.response && <span className="response">{r.response}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default App;
