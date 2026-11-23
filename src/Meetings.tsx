import { useState, type DragEvent, type FormEvent } from "react";
import type { RoomView } from "./api";
import { formatMeetingTime, meetingStatus, type Decision, type Meeting, type MeetingStatus } from "./model";

type Agreement = NonNullable<RoomView["agreement"]>;
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
  isHost,
  act,
}: {
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

  if (!open) {
    return (
      <section className={panelClass} {...zone}>
        <button className="log-rail" type="button" onClick={onToggle} aria-label="Expand decision log" aria-expanded="false">
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

  const checking = agreement?.status === "collecting";

  return (
    <section className={panelClass} {...zone}>
      <header className="panel-head log-head">
        <div>
          <h2>
            Decision log <span className="count">{decisions.length}</span>
          </h2>
          <p>Recorded by the Moderator when everyone agrees</p>
        </div>
        <button className="icon-btn" type="button" onClick={onToggle} aria-label="Collapse decision log" aria-expanded="true" title="Collapse">
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

      {agreement && agreement.status !== "cancelled" ? (
        <AgreementBox agreement={agreement} isHost={isHost} act={act} />
      ) : null}

      <div className="thread">
        {!meeting && !scheduling ? (
          <div className="empty">
            <p>No meeting today or coming up. Schedule one to start its decision log.</p>
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
        {meeting && decisions.length === 0 ? (
          <div className="empty">
            <p>Nothing agreed yet.</p>
            <p className="small-note">
              When the team settles something in the chat, the Moderator checks that everyone read it the same way and
              records it here. To propose something yourself, drag a message onto this panel.
            </p>
          </div>
        ) : null}
        {decisions.length > 0 ? <DecisionList decisions={decisions} onEdit={onEdit} /> : null}
      </div>

      {isHost ? <HostTools act={act} checking={checking} /> : null}
      <button className="past-link" type="button" onClick={onOpenGroup}>
        Schedule & past decision logs ›
      </button>
      <DropOverlay label={dropLabel} />
    </section>
  );
}

/** Host-only shortcuts to the Moderator. */
function HostTools({ act, checking }: { act: Act; checking: boolean }) {
  const [angle, setAngle] = useState("");
  const [asking, setAsking] = useState(false);
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
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="host-tools">
      <span className="host-label">Host</span>
      {asking ? (
        <form
          className="angle-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (angle.trim()) void run("angle", { angle: angle.trim() }, "Asked the agents privately.");
          }}
        >
          <input
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
      ) : (
        <div className="host-buttons">
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => setAsking(true)}>
            Ask about an angle
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
      {note ? <p className="host-note">{note}</p> : null}
    </div>
  );
}

/** The Moderator's agreement check as everyone sees it. Who answered what is never shown. */
function AgreementBox({ agreement, isHost, act }: { agreement: Agreement; isHost: boolean; act: Act }) {
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
    <div className={`agreement ${status}`}>
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
            {answered}/{askedOf} answered privately. Answer the card in your own window.
          </p>
        </>
      ) : status === "mismatch" ? (
        <div className="agreement-next">
          <p>
            <strong>What now?</strong> The Moderator asked one question in the chat. Talk it through there. When
            someone states the version the team settles on, the Moderator checks it again automatically.
          </p>
          {isHost ? <p>As host, you can also revise the proposal yourself.</p> : null}
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

/** Agreed decisions. With `onEdit`, members can correct the wording; the agreed original is kept. */
export function DecisionList({
  decisions,
  onEdit,
}: {
  decisions: Decision[];
  onEdit?: (id: string, text: string) => Promise<void>;
}) {
  return (
    <ol className="decision-list">
      {decisions.map((decision) => (
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
    <li className="decision">
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
          {decision.agreed ? `Agreed ${decision.agreed}` : "Agreed"}
          {decision.editedBy ? ` · edited by ${decision.editedBy}` : ""}
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
