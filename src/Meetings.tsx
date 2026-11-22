import { useState, type DragEvent, type FormEvent } from "react";
import {
  formatMeetingTime,
  meetingStatus,
  type Decision,
  type Meeting,
  type MeetingStatus,
} from "./model";
import type { RoomView } from "./api";

type Agreement = NonNullable<RoomView["agreement"]>;

export type Zone = {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
};

/** The chat room's middle panel: the decision log for the meeting happening now (or next). */
export default function CurrentLog({
  meeting,
  decisions,
  open,
  onToggle,
  onRecord,
  onSchedule,
  onOpenGroup,
  zone,
  over,
  dragging,
  flash,
  agreement,
  isHost,
  act,
}: {
  meeting: Meeting | null;
  decisions: Decision[];
  open: boolean;
  onToggle: () => void;
  onRecord: (text: string) => void;
  onSchedule: (title: string, startsAt: string) => void;
  onOpenGroup: () => void;
  zone: Zone;
  over: boolean;
  dragging: boolean;
  flash: boolean;
  agreement: Agreement | null;
  isHost: boolean;
  act: (action: string, body: object) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const status = meeting ? meetingStatus(meeting) : null;
  const panelClass = [
    "log-panel",
    open ? "open" : "closed",
    over ? "over" : "",
    dragging ? "active" : "",
    flash ? "flash" : "",
  ].join(" ");
  const dropLabel = meeting ? `Drop into ${meeting.title}` : "Drop to record a decision";

  if (!open) {
    return (
      <section className={panelClass} {...zone}>
        <button
          className="log-rail"
          type="button"
          onClick={onToggle}
          aria-label="Expand decision log"
          aria-expanded="false"
        >
          <span className="rail-icon" aria-hidden="true">
            ✓
          </span>
          <span className="count">{decisions.length}</span>
          <span className="rail-label">Decision log{meeting ? ` · ${meeting.title}` : ""}</span>
        </button>
        <DropOverlay label={dropLabel} />
      </section>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    onRecord(draft);
    setDraft("");
  }

  return (
    <section className={panelClass} {...zone}>
      <header className="panel-head log-head">
        <div>
          <h2>
            Decision log <span className="count">{decisions.length}</span>
          </h2>
          <p>Only for the current meeting</p>
        </div>
        <button
          className="icon-btn"
          type="button"
          onClick={onToggle}
          aria-label="Collapse decision log"
          aria-expanded="true"
          title="Collapse"
        >
          ⇥
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

      {agreement ? <AgreementBox agreement={agreement} isHost={isHost} act={act} /> : null}

      <div className="thread">
        {!meeting && !scheduling ? (
          <div className="empty">
            <p>No meeting today or coming up. Schedule one to start its decision log.</p>
            <button
              className="btn small schedule-btn"
              type="button"
              onClick={() => setScheduling(true)}
            >
              + Schedule a meeting
            </button>
          </div>
        ) : null}
        {!meeting && scheduling ? (
          <ScheduleForm
            onCancel={() => setScheduling(false)}
            onSubmit={(title, startsAt) => {
              onSchedule(title, startsAt);
              setScheduling(false);
            }}
          />
        ) : null}
        {meeting && decisions.length === 0 ? (
          <p className="empty">Drop a message here when the team agrees on something.</p>
        ) : null}
        {decisions.length > 0 ? <DecisionList decisions={decisions} /> : null}
      </div>

      <form className="composer log-composer" onSubmit={submit}>
        <div className="composer-row">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a decision"
            aria-label="Write a decision"
          />
          <button className="btn primary small" type="submit" disabled={!draft.trim()}>
            Record
          </button>
        </div>
      </form>
      <button className="past-link" type="button" onClick={onOpenGroup}>
        Schedule & past decision logs ›
      </button>
      <DropOverlay label={dropLabel} />
    </section>
  );
}

/** The moderator's agreement check, as everyone sees it. Who answered what is never shown. */
function AgreementBox({
  agreement,
  isHost,
  act,
}: {
  agreement: Agreement;
  isHost: boolean;
  act: (action: string, body: object) => Promise<void>;
}) {
  const [revising, setRevising] = useState(false);
  const [revision, setRevision] = useState(agreement.decision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { status, answered, askedOf, approvedCount } = agreement;

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
        ? `Agreed ${agreement.agreed ?? approvedCount}/${agreement.total ?? askedOf}`
        : `Not aligned yet · approved ${agreement.agreed ?? approvedCount}/${agreement.total ?? askedOf}`;

  return (
    <div className={`agreement ${status}`}>
      <p className="agreement-title">
        <span className="agreement-dot" aria-hidden="true" />
        {title}
        {agreement.version > 1 ? <em> · v{agreement.version}</em> : null}
      </p>
      <p className="agreement-decision">{agreement.decision}</p>
      {status === "collecting" ? (
        <>
          <div className="agreement-meter" aria-label={`${answered} of ${askedOf} answered`}>
            <span style={{ width: `${askedOf ? (answered / askedOf) * 100 : 0}%` }} />
          </div>
          <p className="agreement-meta">
            {answered}/{askedOf} answered privately · {approvedCount} approved
          </p>
        </>
      ) : status === "mismatch" ? (
        <p className="agreement-meta">The moderator asked the team one anonymous question in the chat.</p>
      ) : null}

      {isHost && status !== "aligned" ? (
        revising ? (
          <div className="agreement-revise">
            <input value={revision} onChange={(event) => setRevision(event.target.value)} aria-label="Revised proposal" />
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
                Ask again
              </button>
            </div>
          </div>
        ) : (
          <div className="agreement-host">
            <span>Host</span>
            {status === "collecting" && answered >= 2 && answered < askedOf ? (
              <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("check/compare", {})}>
                Compare now
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

export function DecisionList({ decisions }: { decisions: Decision[] }) {
  return (
    <ol className="decision-list">
      {decisions.map((decision) => (
        <li className="decision" key={decision.id}>
          <span className="decision-dot" aria-hidden="true" />
          <div>
            <p className="decision-text">{decision.text}</p>
            <p className="decision-meta">{decision.author}</p>
          </div>
        </li>
      ))}
    </ol>
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
  onSubmit: (title: string, startsAt: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState(defaultWhen);
  const valid = title.trim().length > 0 && !Number.isNaN(new Date(when).getTime());

  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(title.trim(), new Date(when).toISOString());
      }}
    >
      <label>
        Meeting
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="User testing meeting"
          maxLength={60}
          autoFocus
        />
      </label>
      <label>
        Date & time
        <input
          type="datetime-local"
          value={when}
          onChange={(event) => setWhen(event.target.value)}
        />
      </label>
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
