// The agents' table in the UI: the table below the team chat (no names, finished steps only), and each member's own
// agent in their private window. Everything here comes from view.table (agents/table-protocol.ts).
import { useState } from "react";
import type { TableDraft, TableRound, ThreadView } from "../agents/table-protocol";
import { AgentIcon, ModeratorIcon } from "./icons";
import "./agents-table.css";

type Act = (action: string, body: object) => Promise<void>;

function useRun(act: Act) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: string, body: object) {
    setBusy(true);
    setError("");
    try {
      await act(action, body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

/** Below the team chat: the offer after a split, then the table as it happens. */
export function TableBelowChat({ table, act }: { table: ThreadView[]; act: Act }) {
  const [hidden, setHidden] = useState<string | null>(null);
  const latest = table[table.length - 1];
  if (!latest || latest.status === "closed" || hidden === latest.id) return null;
  if (latest.status === "offered") return <TableOffer thread={latest} act={act} onHide={() => setHidden(latest.id)} />;
  return <TableTalk thread={latest} onHide={latest.status === "talking" ? undefined : () => setHidden(latest.id)} />;
}

function TableOffer({ thread, act, onHide }: { thread: ThreadView; act: Act; onHide: () => void }) {
  const { busy, error, run } = useRun(act);
  return (
    <section className="agents-table offer" aria-label="Agents' table">
      <header className="at-head">
        <ModeratorIcon size={15} />
        <strong>Let the agents talk it over?</strong>
        <button className="at-close" type="button" onClick={onHide} aria-label="Not now" title="Not now">
          ×
        </button>
      </header>
      <p className="at-note">
        Each Personal Agent first tells the Moderator, alone, why its member read “{thread.decision}” that way. Then the agents
        work out one compromise together, without names. Anything from your private notes is sent only if you approve it.
      </p>
      <div className="at-actions">
        <button className="btn primary small" type="button" disabled={busy} onClick={() => run("table/start", { threadId: thread.id })}>
          Let our agents talk it over
        </button>
      </div>
      {error ? <p className="error small-note">{error}</p> : null}
    </section>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where the table is, as four steps: 0 reasons, 1 compromise, 2 agents answer, 3 team check. */
function currentStep(thread: ThreadView): number {
  if (thread.status === "bridged") return 3;
  if (thread.step === "position") return 0;
  return thread.waitingFor ? 2 : 1;
}

const STEPS = ["Reasons", "Compromise", "Agents answer", "Team check"];

function Steps({ thread }: { thread: ThreadView }) {
  const now = currentStep(thread);
  return (
    <ol className="at-steps" aria-label="Progress">
      {STEPS.map((label, i) => (
        <li key={label} className={i < now ? "ok" : i === now ? "now" : ""} aria-current={i === now ? "step" : undefined}>
          <span className="at-dot" aria-hidden="true">{i < now ? "✓" : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** One circle per agent: ✓ accepted, ✎ suggested an edit, ✕ rejected, – no answer, … still answering. */
function Votes({ round, agents, waitingFor }: { round: TableRound; agents: number; waitingFor?: number }) {
  if (!round.answered) {
    const answered = Math.max(0, agents - (waitingFor ?? agents));
    return (
      <p className="at-votes">
        {Array.from({ length: agents }, (_, i) => (
          <span key={i} className={`at-v ${i < answered ? "in" : "wait"}`} aria-hidden="true">{i < answered ? "•" : "…"}</span>
        ))}
        <span>{answered} of {agents} agents answered</span>
      </p>
    );
  }
  const marks = [
    ...Array(round.accepted).fill(["yes", "✓"]),
    ...Array(round.changed).fill(["edit", "✎"]),
    ...Array(round.rejected).fill(["no", "✕"]),
    ...Array(round.silent).fill(["none", "–"]),
  ] as [string, string][];
  const total = marks.length || agents;
  const parts = [
    `${round.accepted} of ${total} ${round.accepted === 1 ? "agent accepts" : "agents accept"}`,
    round.changed ? `${plural(round.changed, "suggested an edit", "suggested edits")}` : "",
    round.rejected ? `${round.rejected} rejected it` : "",
    round.silent ? `${round.silent} did not answer` : "",
  ].filter(Boolean);
  return (
    <p className="at-votes">
      {marks.map(([kind, mark], i) => (
        <span key={i} className={`at-v ${kind}`} aria-hidden="true">{mark}</span>
      ))}
      <span>{parts.join(" · ")}</span>
    </p>
  );
}

function Edits({ round }: { round: TableRound }) {
  if (!round.changes.length) return null;
  return (
    <ul className="at-edits">
      {round.changes.map((change) => (
        <li key={change.id}>
          <p className="at-edit-text">
            <b>Suggested edit:</b> “{change.wording}”
          </p>
          <p className="at-react">
            {round.reacted ? (
              <>
                Other agents: <b className="yes">✓ {change.support} {change.support === 1 ? "agrees" : "agree"}</b>
                <b className="no">✕ {change.object} {change.object === 1 ? "disagrees" : "disagree"}</b>
              </>
            ) : (
              "The other agents are reacting."
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Compromise({ round, label, thread, latest }: { round: TableRound; label: string; thread: ThreadView; latest: boolean }) {
  return (
    <article className={latest ? "at-card" : "at-card earlier"}>
      <p className="at-kicker">{label}</p>
      <p className="at-text-main">“{round.wording}”</p>
      <Votes round={round} agents={thread.agents} waitingFor={latest ? thread.waitingFor : 0} />
      <Edits round={round} />
    </article>
  );
}

function TableTalk({ thread, onHide }: { thread: ThreadView; onHide?: () => void }) {
  const rounds = thread.rounds;
  const latest = rounds[rounds.length - 1];
  const done = thread.status === "bridged";
  const stuck = thread.status === "no_bridge";
  const earlier = done || stuck ? rounds : rounds.slice(0, -1);
  return (
    <section className={`agents-table ${thread.status}`} aria-label="Agents' table">
      <header className="at-head">
        <ModeratorIcon size={15} />
        <strong>Agents’ table</strong>
        <span
          className="at-lock"
          tabIndex={0}
          title="Each agent told the Moderator its member’s reasons alone. Only compromises and answers are shown here, without names."
        >
          🔒 Reasons stay private
        </span>
        {onHide ? (
          <button className="at-close" type="button" onClick={onHide} aria-label="Hide" title="Hide">
            ×
          </button>
        ) : null}
      </header>
      {stuck ? null : <Steps thread={thread} />}

      {done ? (
        <article className="at-card">
          <p className="at-kicker">
            {thread.bridgedBy === "agents" ? "The agents settled on a suggested edit" : `All ${thread.agents} agents accept this compromise`}
          </p>
          <p className="at-text-main">“{thread.bridge}”</p>
          <p className="at-next">↓ Sent to the team as a new agreement check. Answer it in your own window.</p>
        </article>
      ) : stuck ? (
        <article className="at-card">
          <p className="at-kicker">No compromise everyone accepts yet</p>
          {latest ? <p className="at-text-main">Last one: “{latest.wording}”</p> : null}
          <p className="at-next stuck">Keep talking in the chat. When the team settles on a version, the Moderator checks it again.</p>
        </article>
      ) : latest ? (
        <Compromise round={latest} label={rounds.length > 1 ? "Latest compromise" : "Compromise"} thread={thread} latest />
      ) : (
        <p className="at-wait">The Moderator is asking each agent, alone, why its member read it that way.</p>
      )}

      {earlier.length ? (
        <details className="at-earlier">
          <summary>
            {done || stuck ? `How they got here (${plural(earlier.length, "compromise", "compromises")})` : `Earlier compromise (${earlier.length})`}
          </summary>
          {earlier.map((round, i) => (
            <Compromise key={round.round} round={round} label={`Compromise ${i + 1}`} thread={thread} latest={false} />
          ))}
        </details>
      ) : null}
    </section>
  );
}

const STEP_LABEL: Record<TableDraft["step"], string> = {
  position: "Told the Moderator, privately",
  respond: "At the table",
  react: "Reacted to the other agents' changes",
};

/** In the private window: what your agent did at the table, and anything waiting for your approval. */
export function TableDrafts({ table, act }: { table: ThreadView[]; act: Act }) {
  return (
    <>
      {table.map((thread) => {
        const waiting = thread.drafts.filter((d) => d.status === "waiting");
        const done = thread.drafts.filter((d) => d.status !== "waiting");
        if (!waiting.length && !done.length) return null;
        return (
          <div className="at-drafts" key={thread.id}>
            {done.length ? (
              <details className="at-said" open={thread.status === "talking"}>
                <summary>
                  <AgentIcon size={13} className="inline-icon" /> Your agent at the agents’ table ({done.length})
                </summary>
                <ul>
                  {done.map((d) => (
                    <li key={d.id}>
                      <span className="at-step">{STEP_LABEL[d.step]}</span> {describe(d)}
                      {d.note ? <em className="at-why"> · {d.note}</em> : null}
                      {d.status === "closed" ? <em> · not sent, the step ended</em> : d.auto && d.step !== "react" ? <em> · sent without asking: it used nothing private</em> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {waiting.map((d) => (
              <ApprovalCard key={d.id} draft={d} act={act} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function describe(d: TableDraft): string {
  if (d.status === "declined") return "Nothing (you chose not to send).";
  if (d.step === "position") return d.text + (d.condition ? ` (condition: ${d.condition})` : "");
  if (d.step === "react") {
    return (d.reactions ?? []).map((r) => `${r.act === "accept" ? "supported" : "objected to"} “${r.wording}”`).join("; ") || "No reaction.";
  }
  return d.act === "accept" ? "Accepted the compromise." : d.act === "reject" ? "Rejected the compromise." : `Proposed a change: “${d.text}”`;
}

function ApprovalCard({ draft, act }: { draft: TableDraft; act: Act }) {
  const [text, setText] = useState(draft.text);
  const { busy, error, run } = useRun(act);
  const position = draft.step === "position";
  return (
    <article className="pcard speak open">
      <p className="pcard-kicker">{position ? "Your agent would tell the Moderator, privately" : "Your agent would propose this change to the other agents"}</p>
      <blockquote className="pcard-decision">{position ? `Moderator · ${draft.prompt}` : draft.prompt}</blockquote>
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label={position ? "What your agent would say" : "The changed wording"} />
      {draft.condition ? <p className="pcard-why">Condition: {draft.condition}</p> : null}
      {draft.note ? (
        <p className="pcard-why">
          <AgentIcon size={13} className="inline-icon" /> {draft.note}
        </p>
      ) : null}
      {draft.why ? <p className="pcard-why">{draft.why}</p> : null}
      <div className="pcard-actions">
        <button className="btn primary small" type="button" disabled={busy || !text.trim()} onClick={() => run("table/speak", { draftId: draft.id, send: true, text })}>
          {position ? "Send to the Moderator only" : "Propose this change"}
        </button>
        <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("table/speak", { draftId: draft.id, send: false })}>
          {position ? "Don't send" : "Don't propose"}
        </button>
      </div>
      <p className="fine-left">
        {position
          ? "Only the Moderator reads this, without your name. It may use what you need to word a proposal for everyone, but never quotes you."
          : "The change is shown to everyone without your name."}
      </p>
      {error ? <p className="error small-note">{error}</p> : null}
    </article>
  );
}
