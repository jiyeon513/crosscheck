// The agents' table in the UI: the live talk below the team chat, and each member's own drafts in their private window.
// Everything here comes from view.table (agents/table-protocol.ts): code names only, plus the viewer's own drafts.
import { useEffect, useState } from "react";
import type { SpeechAct, TableDraft, TableMessage, ThreadView } from "../agents/table-protocol";
import { AgentIcon, ModeratorIcon } from "./icons";
import "./agents-table.css";

type Act = (action: string, body: object) => Promise<void>;

const ACT_LABEL: Record<SpeechAct, string> = {
  ask: "asks", inform: "informs", propose: "proposes", counter: "counters",
  accept: "accepts", reject: "rejects", justify: "explains", concede: "concedes",
};

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

/** Below the team chat: the offer after a split, then the talk as it happens. */
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
        The Moderator asks each Personal Agent, under a code name, why its member read “{thread.decision}” that way, and
        looks for one wording that works for everyone. Anything from your private notes is sent only if you approve it.
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

function TableTalk({ thread, onHide }: { thread: ThreadView; onHide?: () => void }) {
  const talking = thread.status === "talking";
  const [open, setOpen] = useState(talking);
  useEffect(() => {
    if (!talking) setOpen(false);
  }, [talking]);
  const status = talking
    ? thread.waitingFor
      ? `Round ${thread.round} · waiting for ${thread.waitingFor} of ${thread.agents} agents`
      : `Round ${thread.round} · the Moderator is thinking`
    : thread.status === "bridged"
      ? "A wording every agent could accept"
      : "No wording found yet";
  return (
    <section className={`agents-table ${thread.status}`} aria-label="Agents' table">
      <header className="at-head">
        <ModeratorIcon size={15} />
        <strong>Agents’ table</strong>
        <span className={`at-status ${thread.status}`}>{status}</span>
        {thread.yours ? <span className="at-yours">you are {thread.yours}</span> : null}
        <button className="at-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide the talk" : `Show the talk (${thread.messages.length})`}
        </button>
        {onHide ? (
          <button className="at-close" type="button" onClick={onHide} aria-label="Hide" title="Hide">
            ×
          </button>
        ) : null}
      </header>
      {!talking && thread.bridge ? <p className="at-bridge">“{thread.bridge}”</p> : null}
      {open ? (
        <ol className="at-messages">
          {thread.messages.map((m) => (
            <TableLine key={m.id} message={m} yours={thread.yours} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function TableLine({ message: m, yours }: { message: TableMessage; yours?: string }) {
  const fromModerator = m.from === "Moderator";
  const mine = m.from === yours;
  return (
    <li className={`at-line ${fromModerator ? "mod" : "agent"} ${mine ? "mine" : ""}`}>
      <p className="at-meta">
        <span className="at-from">
          {fromModerator ? <ModeratorIcon size={12} /> : <AgentIcon size={12} />} {m.from}
          {mine ? " (yours)" : ""}
        </span>
        <span className="at-to">→ {m.to === "all" ? "all agents" : m.to === yours ? `${m.to} (yours)` : m.to}</span>
        <span className={`act-chip ${m.act}`}>{ACT_LABEL[m.act]}</span>
        {m.approved ? <span className="at-approved">approved by its member</span> : null}
      </p>
      {m.act === "propose" && m.reading ? <p className="at-wording">“{m.reading}”</p> : null}
      <p className="at-text">{m.text}</p>
      {m.act !== "propose" && m.reading ? <p className="at-extra">Reading: {m.reading}</p> : null}
      {m.condition ? <p className="at-extra">Condition: {m.condition}</p> : null}
    </li>
  );
}

/** In the private window: drafts waiting for the member, and what the agent already said for them. */
export function TableDrafts({ table, act }: { table: ThreadView[]; act: Act }) {
  return (
    <>
      {table.map((thread) => {
        const waiting = thread.drafts.filter((d) => d.status === "waiting");
        const said = thread.drafts.filter((d) => d.status !== "waiting");
        if (!waiting.length && !said.length) return null;
        return (
          <div className="at-drafts" key={thread.id}>
            {said.length ? (
              <details className="at-said">
                <summary>
                  <AgentIcon size={13} className="inline-icon" /> What your agent said for you as {thread.yours} ({said.length})
                </summary>
                <ul>
                  {said.map((d) => (
                    <li key={d.id}>
                      <span className={`act-chip ${d.act}`}>{ACT_LABEL[d.act]}</span> {d.status === "declined" ? "Nothing (you chose not to send)." : d.text}
                      {d.status === "closed" ? <em> · not sent, the round ended</em> : d.auto ? <em> · sent without asking: it used nothing private</em> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {waiting.map((d) => (
              <SpeakCard key={d.id} draft={d} act={act} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function SpeakCard({ draft, act }: { draft: TableDraft; act: Act }) {
  const [text, setText] = useState(draft.text);
  const { busy, error, run } = useRun(act);
  return (
    <article className="pcard speak open">
      <p className="pcard-kicker">Your agent would say this for you, as {draft.alias}</p>
      <blockquote className="pcard-decision">Moderator · {draft.prompt}</blockquote>
      <p className="at-meta">
        <span className={`act-chip ${draft.act}`}>{ACT_LABEL[draft.act]}</span>
      </p>
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label="What your agent would say" />
      {draft.condition ? <p className="pcard-why">Condition: {draft.condition}</p> : null}
      {draft.why ? (
        <p className="pcard-why">
          <AgentIcon size={13} className="inline-icon" /> {draft.why}
        </p>
      ) : null}
      <div className="pcard-actions">
        <button className="btn primary small" type="button" disabled={busy || !text.trim()} onClick={() => run("table/speak", { draftId: draft.id, send: true, text })}>
          Send for me
        </button>
        <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("table/speak", { draftId: draft.id, send: false })}>
          Don't send
        </button>
      </div>
      <p className="fine-left">Only your code name is shown at the table. Nothing is sent until you press Send.</p>
      {error ? <p className="error small-note">{error}</p> : null}
    </article>
  );
}
