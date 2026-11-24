// The agents' table in the UI: the table below the team chat (no names, finished steps only), and each member's own
// agent in their private window. Everything here comes from view.table (agents/table-protocol.ts).
import { useEffect, useState } from "react";
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
        work on one wording together, without names. Anything from your private notes is sent only if you approve it.
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

function statusLine(thread: ThreadView): string {
  if (thread.status === "bridged") {
    return thread.bridgedBy === "agents" ? "The agents settled on one of their changes" : "Every agent accepted a wording";
  }
  if (thread.status === "no_bridge") return "No wording found yet";
  const waiting = `waiting for ${thread.waitingFor} of ${thread.agents}`;
  if (!thread.waitingFor) return "The Moderator is writing a wording";
  if (thread.step === "position") return `Step 1 · the Moderator talks with each agent alone · ${waiting}`;
  const n = thread.rounds.length;
  return thread.step === "respond" ? `Wording ${n} · agents are answering · ${waiting}` : `Wording ${n} · agents are reacting to the changes · ${waiting}`;
}

function TableTalk({ thread, onHide }: { thread: ThreadView; onHide?: () => void }) {
  const talking = thread.status === "talking";
  const [open, setOpen] = useState(talking);
  useEffect(() => {
    if (!talking) setOpen(false);
  }, [talking]);
  return (
    <section className={`agents-table ${thread.status}`} aria-label="Agents' table">
      <header className="at-head">
        <ModeratorIcon size={15} />
        <strong>Agents’ table</strong>
        <span className={`at-status ${thread.status}`}>{statusLine(thread)}</span>
        <button className="at-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Show the table"}
        </button>
        {onHide ? (
          <button className="at-close" type="button" onClick={onHide} aria-label="Hide" title="Hide">
            ×
          </button>
        ) : null}
      </header>
      {!talking && thread.bridge ? <p className="at-bridge">“{thread.bridge}”</p> : null}
      {open ? (
        <div className="at-body">
          <p className="at-private">
            <AgentIcon size={12} /> Each agent told the Moderator its member’s reasons alone. Those stay private; only wordings and
            answers are shown here, without names.
          </p>
          {thread.rounds.map((round, index) => (
            <RoundView key={round.round} round={round} index={index + 1} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RoundView({ round, index }: { round: TableRound; index: number }) {
  return (
    <article className="at-round">
      <p className="at-meta">
        <span className="at-from">
          <ModeratorIcon size={12} /> Moderator
        </span>
        <span className="act-chip propose">wording {index}</span>
      </p>
      <p className="at-wording">“{round.wording}”</p>
      {round.note ? <p className="at-text">{round.note}</p> : null}
      {round.answered ? (
        <p className="at-tally">
          {round.accepted ? <span className="act-chip accept">{round.accepted} accepted</span> : null}
          {round.changed ? <span className="act-chip counter">{round.changed} proposed a change</span> : null}
          {round.rejected ? <span className="act-chip reject">{round.rejected} rejected</span> : null}
          {round.silent ? <span className="act-chip">{round.silent} no answer</span> : null}
        </p>
      ) : (
        <p className="at-extra">The agents are answering. Their answers appear together once all have answered.</p>
      )}
      {round.changes.map((change) => (
        <div className="at-line agent" key={change.id}>
          <p className="at-meta">
            <span className="at-from">
              <AgentIcon size={12} /> An agent
            </span>
            <span className="act-chip counter">proposes a change</span>
          </p>
          <p className="at-wording">“{change.wording}”</p>
          {round.reacted ? (
            <p className="at-tally">
              <span className="act-chip accept">{change.support} other {change.support === 1 ? "agent supports" : "agents support"}</span>
              {change.object ? <span className="act-chip reject">{change.object} {change.object === 1 ? "objects" : "object"}</span> : null}
            </p>
          ) : (
            <p className="at-extra">The other agents are reacting.</p>
          )}
        </div>
      ))}
    </article>
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
  return d.act === "accept" ? "Accepted the wording." : d.act === "reject" ? "Rejected the wording." : `Proposed a change: “${d.text}”`;
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
