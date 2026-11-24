import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { ModeratorIcon } from "./icons";
import type { RoomView } from "./api";
import { GrowingInput } from "./chatParts";
import { formatMeetingTime, meetingStatus, type Decision, type Meeting, type MeetingStatus } from "./model";

type Agreement = NonNullable<RoomView["agreement"]>;
type Discussing = RoomView["discussing"];
type Board = RoomView["board"];
type BoardTopic = Board["topics"][number];
type BoardPoll = Board["polls"][number];
type Act = (action: string, body: object) => Promise<void>;

export type Zone = {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
};

/**
 * The chat room's middle panel: the decision log of the meeting happening now (or next).
 * Only the Moderator adds decisions (after everyone agrees); members can fix the wording.
 * Dropping a message here proposes it, and the Moderator opens an agreement check.
 */
export default function CurrentLog({
  meeting,
  decisions,
  open,
  onToggle,
  onEdit,
  onSchedule,
  onOpenGroup,
  zone,
  over,
  dragging,
  flash,
  agreement,
  discussing,
  isHost,
  act,
  onPropose,
  board,
}: {
  discussing: Discussing;
  board: Board | null;
  meeting: Meeting | null;
  decisions: Decision[];
  open: boolean;
  onToggle: () => void;
  onEdit: (id: string, text: string) => Promise<void>;
  onSchedule: (title: string, startsAt: string) => Promise<void>;
  onOpenGroup: () => void;
  zone: Zone;
  over: boolean;
  dragging: boolean;
  flash: boolean;
  agreement: Agreement | null;
  isHost: boolean;
  act: Act;
  /** Propose a decision typed in the log; the Moderator opens an agreement check on it. */
  onPropose: (text: string) => Promise<void>;
}) {
  const [scheduling, setScheduling] = useState(false);
  const status = meeting ? meetingStatus(meeting) : null;
  const panelClass = [
    "log-panel",
    open ? "open" : "closed",
    over ? "over" : "",
    dragging ? "active" : "",
    flash ? "flash" : "",
  ].join(" ");
  const dropLabel = "Drop to propose it for an agreement check";

  // Closed: the panel is gone; the "Decision log" button in the team chat header opens it.
  if (!open) return null;


  return (
    <section className={panelClass} {...zone}>
      <header className="panel-head log-head">
        <div>
          <h2>
            Decision log <span className="count">{decisions.length}</span>
          </h2>
          <p>Recorded by the Moderator when everyone agrees</p>
        </div>
        <button className="icon-btn" type="button" onClick={onToggle} aria-label="Close decision log" aria-expanded="true" title="Close">
          ×
        </button>
      </header>

      {meeting && status ? (
        <div className="current-meeting">
          <MeetingDate value={meeting.startsAt} status={status} />
          <div className="meeting-info">
            <strong>{meeting.title}</strong>
            <span>
              {formatMeetingTime(meeting.startsAt)}
              <StatusBadge status={status} />
            </span>
          </div>
        </div>
      ) : null}

      <div className="log-split">
        <section className="log-current">
          <h3>On the table</h3>
          {board && (board.topics.length > 0 || board.polls.length > 0) ? (
            <BoardView board={board} agreement={agreement} isHost={isHost} act={act} />
          ) : agreement && agreement.status !== "cancelled" && agreement.status !== "aligned" ? (
            <AgreementBox agreement={agreement} isHost={isHost} act={act} />
          ) : discussing ? (
            <DiscussionBox discussing={discussing} />
          ) : (
            <p className="muted small-note">Nothing yet. Proposals and private questions appear here.</p>
          )}
        </section>

        <section className="log-agreed">
          <h3>Agreed</h3>
          {!meeting && !scheduling ? (
            <div className="empty">
              <p>No meeting scheduled.</p>
              <button className="btn small schedule-btn" type="button" onClick={() => setScheduling(true)}>
                + Schedule a meeting
              </button>
            </div>
          ) : null}
          {!meeting && scheduling ? (
            <ScheduleForm
              onCancel={() => setScheduling(false)}
              onSubmit={async (title, startsAt) => {
                await onSchedule(title, startsAt);
                setScheduling(false);
              }}
            />
          ) : null}
          {decisions.length === 0 && meeting ? (
            <div className="empty">
              <p>Nothing agreed yet.</p>
            </div>
          ) : null}
          {decisions.length > 0 ? <DecisionList decisions={decisions} onEdit={onEdit} /> : null}
        </section>
      </div>

      <ProposeBox onPropose={onPropose} />
      <button className="past-link" type="button" onClick={onOpenGroup}>
        Schedule & past decision logs ›
      </button>
      <DropOverlay label={dropLabel} />
    </section>
  );
}

/** A box to type a proposal straight into the log (dropping a message here does the same). */
function ProposeBox({ onPropose }: { onPropose: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const proposal = text.trim();
    if (!proposal || busy) return;
    setBusy(true);
    try {
      await onPropose(proposal);
      setText("");
    } catch {
      // Keep the text; the room shows why it did not work.
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="composer log-composer" onSubmit={submit}>
      <div className="composer-row">
        <GrowingInput value={text} onChange={setText} placeholder="Propose a decision…" label="Propose a decision" />
        <button className="btn primary small" type="submit" disabled={!text.trim() || busy}>
          {busy ? "..." : "Propose"}
        </button>
      </div>
    </form>
  );
}

/** Shortcuts to the Moderator that any member can use. */
/** Shortcuts to the Moderator that any member can use; shown above the team chat composer. */
export function ModeratorTools({ act, checking, onDone }: { act: Act; checking: boolean; onDone?: () => void }) {
  const [angle, setAngle] = useState("");
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [polling, setPolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function run(action: string, body: object, done: string) {
    setBusy(true);
    setNote("");
    try {
      await act(action, body);
      setNote(done);
      setAngle("");
      setAsking(false);
      setQuestion("");
      setPolling(false);
      onDone?.();
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-tools">
      <span className="chat-tools-label">Ask the Moderator</span>
      {asking ? (
        <form
          className="angle-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (angle.trim()) void run("angle", { angle: angle.trim() }, "Asked the agents privately.");
          }}
        >
          <input
            aria-describedby="angle-audience"
            value={angle}
            onChange={(event) => setAngle(event.target.value)}
            placeholder="An angle nobody raised, e.g. real campus data"
            aria-label="Angle to ask about"
            autoFocus
          />
          <button className="btn primary small" type="submit" disabled={busy || !angle.trim()}>
            Ask
          </button>
          <button className="btn ghost small" type="button" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </form>
      ) : polling ? (
        <form
          className="angle-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (question.trim()) void run("poll", { question: question.trim() }, "Asked everyone privately.");
          }}
        >
          <input
            aria-describedby="poll-audience"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="e.g. What time on Tuesday works for you?"
            aria-label="Question to ask everyone privately"
            autoFocus
          />
          <button className="btn primary small" type="submit" disabled={busy || !question.trim()}>
            Ask privately
          </button>
          <button className="btn ghost small" type="button" onClick={() => setPolling(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="host-buttons">
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => setAsking(true)}>
            Ask about an angle
          </button>
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => setPolling(true)}>
            Ask everyone privately
          </button>
          {!checking ? (
            <button
              className="btn ghost small"
              type="button"
              disabled={busy}
              onClick={() => void run("check/start", {}, "The Moderator is checking the latest proposal.")}
            >
              Check agreement now
            </button>
          ) : null}
        </div>
      )}
      {asking ? <p className="host-note" id="angle-audience">Your question will appear in the team chat.</p> : null}
      {polling ? (
        <p className="host-note" id="poll-audience">
          Each member answers in their own window. Only the combined result is shown, never who said what.
        </p>
      ) : null}
      {note ? <p className="host-note">{note}</p> : null}
    </div>
  );
}

/** The Moderator's agreement check as everyone sees it. Who answered what is never shown. */
export function AgreementBox({
  agreement,
  isHost,
  act,
  inline = false,
}: {
  agreement: Agreement;
  isHost: boolean;
  act: Act;
  /** Shown under the Moderator's message in the team chat. */
  inline?: boolean;
}) {
  const [revising, setRevising] = useState(false);
  const [revision, setRevision] = useState(agreement.decision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { status, answered, askedOf } = agreement;
  const total = agreement.total ?? askedOf;

  async function run(action: string, body: object) {
    setBusy(true);
    setError("");
    try {
      await act(action, body);
      setRevising(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    status === "collecting"
      ? "Checking agreement"
      : status === "aligned"
        ? `Agreed ${total}/${total}`
        : `Not agreed yet · Agreement ${agreement.agreed ?? 0}/${total}`;

  return (
    <div className={`agreement ${status}${inline ? " inline" : ""}`}>
      <p className="agreement-title">
        <span className="agreement-dot" aria-hidden="true" />
        {title}
        {agreement.version > 1 ? <em> · version {agreement.version}</em> : null}
      </p>
      <p className="agreement-decision">{agreement.decision}</p>
      {status === "collecting" ? (
        <>
          <div className="agreement-meter" aria-label={`${answered} of ${askedOf} answered`}>
            <span style={{ width: `${askedOf ? (answered / askedOf) * 100 : 0}%` }} />
          </div>
          <p className="agreement-meta">
            {answered}/{askedOf} answered
          </p>
        </>
      ) : status === "mismatch" ? (
        <div className="agreement-next">
          <p>
            <strong>Next:</strong> talk it through in the chat. Once you settle, say the final version there and it
            is checked again{isHost ? ", or revise it below" : ""}.
          </p>
        </div>
      ) : (
        <p className="agreement-meta">Saved to the decision log below.</p>
      )}

      {isHost && status !== "aligned" ? (
        revising ? (
          <div className="agreement-revise">
            <textarea
              rows={2}
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              aria-label="Revised proposal"
            />
            <div className="schedule-actions">
              <button className="btn ghost small" type="button" onClick={() => setRevising(false)}>
                Cancel
              </button>
              <button
                className="btn primary small"
                type="button"
                disabled={busy || !revision.trim() || revision.trim() === agreement.decision}
                onClick={() => run("check/revise", { checkId: agreement.checkId, decision: revision })}
              >
                Ask everyone again
              </button>
            </div>
          </div>
        ) : (
          <div className="agreement-host">
            {status === "collecting" && answered >= 2 && answered < askedOf ? (
              <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("check/compare", {})}>
                Compare now
              </button>
            ) : null}
            {status === "collecting" ? (
              <button
                className="btn ghost small"
                type="button"
                disabled={busy}
                onClick={() => run("check/cancel", { checkId: agreement.checkId })}
              >
                Close check
              </button>
            ) : null}
            <button
              className="btn ghost small"
              type="button"
              onClick={() => {
                setRevision(agreement.decision);
                setRevising(true);
              }}
            >
              Revise proposal
            </button>
          </div>
        )
      ) : null}
      {error ? <p className="error small-note">{error}</p> : null}
    </div>
  );
}

/** A Moderator button by the team chat input; it opens the "Ask the Moderator" actions only when needed. */
export function ModeratorMenu({ act, checking }: { act: Act; checking: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="mod-menu" ref={ref}>
      <button
        type="button"
        className={open ? "composer-icon-btn mod on" : "composer-icon-btn mod"}
        aria-expanded={open}
        aria-label="Ask the Moderator"
        title="Ask the Moderator"
        onClick={() => setOpen((value) => !value)}
      >
        <ModeratorIcon size={18} />
      </button>
      {open ? (
        <div className="mod-popover" role="dialog" aria-label="Ask the Moderator">
          <ModeratorTools act={act} checking={checking} onDone={() => setTimeout(() => setOpen(false), 1400)} />
        </div>
      ) : null}
    </div>
  );
}

/** A decision the team is talking about again, while no check is open. */
export function DiscussionBox({ discussing }: { discussing: NonNullable<Discussing> }) {
  return (
    <div className="agreement discussing">
      <p className="agreement-title">
        <span className="agreement-dot" aria-hidden="true" />
        {discussing.status === "asking" ? "Revisit this decision?" : "Under discussion"}
      </p>
      <p className="agreement-decision">{discussing.decision}</p>
      <p className="agreement-meta">
        {discussing.status === "asking"
          ? "The Moderator asked the team in the chat whether to discuss it again."
          : "When the team settles on a new version, say it in the chat and it is checked again."}
      </p>
    </div>
  );
}

/** Agreed decisions. With `onEdit`, members can correct the wording; the agreed original is kept. */
export function DecisionList({
  decisions,
  onEdit,
}: {
  decisions: Decision[];
  onEdit?: (id: string, text: string) => Promise<void>;
}) {
  const newestFirst = decisions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <ol className="decision-list">
      {newestFirst.map((decision) => (
        <DecisionItem key={decision.id} decision={decision} onEdit={onEdit} />
      ))}
    </ol>
  );
}

function DecisionItem({
  decision,
  onEdit,
}: {
  decision: Decision;
  onEdit?: (id: string, text: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(decision.text);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!onEdit || !value.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onEdit(decision.id, value.trim());
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className={decision.replacedBy ? "decision replaced" : "decision"}>
      <span className="decision-dot" aria-hidden="true" />
      <div className="decision-body">
        {editing ? (
          <div className="decision-edit">
            <textarea rows={2} value={value} onChange={(event) => setValue(event.target.value)} aria-label="Decision wording" />
            <div className="schedule-actions">
              <button
                className="btn ghost small"
                type="button"
                onClick={() => {
                  setValue(decision.text);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <button className="btn primary small" type="button" disabled={saving || !value.trim()} onClick={save}>
                Save
              </button>
            </div>
            {error ? <p className="error small-note">{error}</p> : null}
          </div>
        ) : (
          <p className="decision-text">{decision.text}</p>
        )}
        <p className="decision-meta" title={decision.text !== decision.original ? `Agreed wording: ${decision.original}` : undefined}>
          {decision.replacedBy ? "Replaced by a newer version · " : ""}
          {decision.agreed ? `Agreed ${decision.agreed}` : "Agreed"}
          {decision.editedBy ? ` · edited by ${decision.editedBy}` : ""}
          {decision.replaces ? " · replaces an earlier decision" : ""}
        </p>
      </div>
      {onEdit && !editing ? (
        <button
          className="icon-btn small edit-btn"
          type="button"
          onClick={() => {
            setValue(decision.text);
            setEditing(true);
          }}
          aria-label="Edit wording"
          title="Edit wording"
        >
          ✎
        </button>
      ) : null}
    </li>
  );
}

export function MeetingDate({ value, status }: { value?: string; status: MeetingStatus | "none" }) {
  const date = value ? new Date(value) : null;
  return (
    <span className={`meeting-date ${status}`} aria-hidden="true">
      {date ? (
        <>
          <b>{date.getDate()}</b>
          <small>{date.toLocaleDateString("en-US", { month: "short" })}</small>
        </>
      ) : (
        <b>–</b>
      )}
    </span>
  );
}

export function StatusBadge({ status }: { status: MeetingStatus }) {
  const label = status === "today" ? "Today" : status === "upcoming" ? "Upcoming" : "✓ Done";
  return <em className={`badge ${status}`}>{label}</em>;
}

export function ScheduleForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (title: string, startsAt: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(defaultWhen);
  const [error, setError] = useState("");
  const valid = title.trim().length > 0 && !Number.isNaN(new Date(when).getTime());

  return (
    <form
      className="schedule-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        try {
          await onSubmit(title.trim(), new Date(when).toISOString());
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Could not schedule it.");
        }
      }}
    >
      <label>
        Meeting
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="User testing meeting" maxLength={60} autoFocus />
      </label>
      <label>
        Date & time
        <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
      </label>
      {error ? <p className="error small-note">{error}</p> : null}
      <div className="schedule-actions">
        <button className="btn ghost small" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary small" type="submit" disabled={!valid}>
          Schedule
        </button>
      </div>
    </form>
  );
}

function DropOverlay({ label }: { label: string }) {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <span>{label}</span>
    </div>
  );
}

function defaultWhen() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(14, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------- the meeting board: everything on the table, as the Moderator tracks it ----------

const TOPIC_LABEL: Record<BoardTopic["status"], string> = {
  checking: "Checking privately",
  split: "Read differently",
  discussing: "Under discussion",
  agreed: "Agreed",
  closed: "Closed",
};
const VERSION_LABEL: Record<BoardTopic["versions"][number]["status"], string> = {
  checking: "checking",
  split: "read differently",
  agreed: "agreed",
  replaced: "replaced",
  cancelled: "closed",
};

/** Proposals with their versions, the open question, the readings found (never who), and private questions. */
export function BoardView({ board, agreement, isHost, act }: { board: Board; agreement: Agreement | null; isHost: boolean; act: Act }) {
  const topics = board.topics.slice().reverse();
  const polls = board.polls.filter((poll, index, all) => poll.status === "collecting" || index === all.length - 1).reverse();
  return (
    <div className="board">
      {polls.map((poll) => (
        <PollRow key={poll.id} poll={poll} act={act} />
      ))}
      {topics.map((topic) => (
        <TopicCard key={topic.id} topic={topic}>
          {topic.status === "checking" && agreement?.status === "collecting" && agreement.decision === topic.statement ? (
            <AgreementBox agreement={agreement} isHost={isHost} act={act} />
          ) : null}
        </TopicCard>
      ))}
    </div>
  );
}

function TopicCard({ topic, children }: { topic: BoardTopic; children?: ReactNode }) {
  const latest = topic.versions[topic.versions.length - 1];
  const earlier = topic.versions.slice(0, -1);
  const previous = earlier[earlier.length - 1];
  const readings = [...topic.versions].reverse().find((v) => v.readings?.length)?.readings;
  return (
    <article className={`topic ${topic.status}`}>
      <p className="topic-head">
        <span className={`topic-chip ${topic.status}`}>{TOPIC_LABEL[topic.status]}</span>
        {topic.versions.length > 1 ? <span className="topic-version">version {latest.version}</span> : null}
      </p>
      <p className="topic-statement">{previous ? <DiffText from={previous.text} to={topic.statement} /> : topic.statement}</p>
      {earlier.length ? (
        <ol className="topic-history" aria-label="Earlier versions">
          {earlier.map((v) => (
            <li key={v.version}>
              <s>{v.text}</s> <em>v{v.version} · {VERSION_LABEL[v.status]}</em>
            </li>
          ))}
        </ol>
      ) : null}
      {topic.status === "checking" ? (
        <p className="topic-meta">
          {topic.question} <span className="topic-count">{topic.answered}/{topic.askedOf} answered</span>
        </p>
      ) : null}
      {topic.ambiguity && topic.status !== "agreed" ? (
        <p className="topic-meta">
          Could be read differently: <strong>{topic.ambiguity}</strong>
        </p>
      ) : null}
      {readings && topic.status !== "agreed" ? <p className="topic-readings">Readings found: {readings.join(" · ")}</p> : null}
      {topic.stances ? (
        <p className="topic-meta">
          Stances so far:{" "}
          {(["support", "hesitant", "unsure"] as const)
            .filter((stance) => topic.stances![stance] > 0)
            .map((stance) => `${topic.stances![stance]} ${stance}`)
            .join(" · ")}
        </p>
      ) : null}
      {children}
    </article>
  );
}

function PollRow({ poll, act }: { poll: BoardPoll; act: Act }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function combine() {
    setBusy(true);
    setError("");
    try {
      await act("poll/combine", { pollId: poll.id });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`topic poll ${poll.status}`}>
      <p className="topic-head">
        <span className="topic-chip poll">{poll.round > 1 ? "Follow-up, asked privately" : "Asked privately"}</span>
      </p>
      <p className="topic-statement">{poll.question}</p>
      {poll.status === "collecting" ? (
        <p className="topic-meta">
          <span className="topic-count">
            {poll.answered}/{poll.askedOf} answered
          </span>
          {poll.answered > 0 && poll.answered < poll.askedOf ? (
            <button className="btn ghost small" type="button" disabled={busy} onClick={() => void combine()}>
              Combine now
            </button>
          ) : null}
        </p>
      ) : (
        <p className={poll.fitsAll ? "topic-readings fits" : "topic-readings"}>{poll.result}</p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
    </article>
  );
}

/** The latest wording, with the words that changed since the previous version highlighted. */
function DiffText({ from, to }: { from: string; to: string }) {
  const a = from.split(/\s+/);
  const b = to.split(/\s+/);
  const clean = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  // Longest common subsequence of words; words of `to` outside it are new.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = clean(a[i]) === clean(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: { word: string; added: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && clean(a[i]) === clean(b[j])) {
      out.push({ word: b[j], added: false });
      i++;
      j++;
    } else if (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      out.push({ word: b[j], added: true });
      j++;
    }
  }
  return (
    <>
      {out.map((token, index) => (
        <span key={index}>
          {index > 0 ? " " : ""}
          {token.added ? <mark className="diff-add">{token.word}</mark> : token.word}
        </span>
      ))}
    </>
  );
}
