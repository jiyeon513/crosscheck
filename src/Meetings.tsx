import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { formatMeetingTime, meetingStatus, type Decision, type Meeting } from "./model";

export type Zone = {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
};

/** Key used for decisions that were recorded before any meeting existed. */
export const LOOSE = "";

export default function MeetingsPanel({
  meetings,
  decisions,
  activeId,
  onSelect,
  open,
  onToggle,
  onSchedule,
  onRecord,
  zone,
  over,
  dragging,
  flash,
}: {
  meetings: Meeting[];
  decisions: Decision[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  open: boolean;
  onToggle: () => void;
  onSchedule: (title: string, startsAt: string) => void;
  onRecord: (meetingId: string, text: string) => void;
  zone: (target: string) => Zone;
  over: string | null;
  dragging: boolean;
  flash: boolean;
}) {
  const [scheduling, setScheduling] = useState(false);
  const loose = decisions.filter(
    (item) => !item.meetingId || !meetings.some((meeting) => meeting.id === item.meetingId),
  );
  const active = meetings.find((item) => item.id === activeId) ?? null;
  const panelClass = [
    "log-panel",
    open ? "open" : "closed",
    over === "log:" ? "over" : "",
    dragging ? "active" : "",
    flash ? "flash" : "",
  ].join(" ");

  if (!open) {
    return (
      <section className={panelClass} {...zone("log:")}>
        <button
          className="log-rail"
          type="button"
          onClick={onToggle}
          aria-label="Expand meetings and decision logs"
          aria-expanded="false"
        >
          <span className="rail-icon" aria-hidden="true">
            ✓
          </span>
          <span className="count">{meetings.length}</span>
          <span className="rail-label">Meetings{active ? ` · ${active.title}` : ""}</span>
        </button>
        <DropOverlay label={active ? `Drop into ${active.title}` : "Drop to record a decision"} />
      </section>
    );
  }

  return (
    <section className={panelClass} {...zone("log:")}>
      <header className="panel-head log-head">
        <div>
          <h2>
            Meetings <span className="count">{meetings.length}</span>
          </h2>
          <p>Each meeting keeps its own decision log</p>
        </div>
        <div className="head-actions">
          <button
            className={scheduling ? "btn small schedule-btn on" : "btn small schedule-btn"}
            type="button"
            onClick={() => setScheduling((value) => !value)}
            aria-expanded={scheduling}
          >
            + Schedule
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={onToggle}
            aria-label="Collapse meetings"
            aria-expanded="true"
            title="Collapse"
          >
            ⇥
          </button>
        </div>
      </header>

      {scheduling ? (
        <ScheduleForm
          onCancel={() => setScheduling(false)}
          onSubmit={(title, startsAt) => {
            onSchedule(title, startsAt);
            setScheduling(false);
          }}
        />
      ) : null}

      <div className="thread meeting-list">
        {meetings.length === 0 && loose.length === 0 ? (
          <div className="empty">
            <p>No meetings yet.</p>
            <button
              className="btn small schedule-btn"
              type="button"
              onClick={() => setScheduling(true)}
            >
              Schedule the first one
            </button>
          </div>
        ) : null}
        {loose.length > 0 ? (
          <MeetingCard
            id={LOOSE}
            title="Before meetings"
            meta="Not tied to a meeting"
            decisions={loose}
            expanded={activeId === LOOSE}
            onSelect={onSelect}
            onRecord={onRecord}
            zone={zone}
            over={over}
          />
        ) : null}
        {meetings.map((meeting) => (
          <MeetingCard
            key={meeting.id}
            id={meeting.id}
            meeting={meeting}
            title={meeting.title}
            decisions={decisions.filter((item) => item.meetingId === meeting.id)}
            expanded={activeId === meeting.id}
            onSelect={onSelect}
            onRecord={onRecord}
            zone={zone}
            over={over}
          />
        ))}
      </div>
      <DropOverlay label={active ? `Drop into ${active.title}` : "Drop to record a decision"} />
    </section>
  );
}

function MeetingCard({
  id,
  meeting,
  title,
  meta,
  decisions,
  expanded,
  onSelect,
  onRecord,
  zone,
  over,
}: {
  id: string;
  meeting?: Meeting;
  title: string;
  meta?: string;
  decisions: Decision[];
  expanded: boolean;
  onSelect: (id: string | null) => void;
  onRecord: (meetingId: string, text: string) => void;
  zone: (target: string) => Zone;
  over: string | null;
}) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLElement | null>(null);
  const status = meeting ? meetingStatus(meeting) : "past";
  const start = meeting ? new Date(meeting.startsAt) : null;

  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest" });
  }, [expanded]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    onRecord(id, draft);
    setDraft("");
  }

  const className = [
    "meeting-card",
    status,
    expanded ? "expanded" : "",
    over === `log:${id}` ? "over" : "",
  ].join(" ");

  return (
    <article className={className} ref={ref} {...zone(`log:${id}`)}>
      <button
        className="meeting-head"
        type="button"
        onClick={() => onSelect(expanded ? null : id)}
        aria-expanded={expanded}
      >
        <span className="meeting-date" aria-hidden="true">
          {start ? (
            <>
              <b>{start.getDate()}</b>
              <small>{start.toLocaleDateString("en-US", { month: "short" })}</small>
            </>
          ) : (
            <b>·</b>
          )}
        </span>
        <span className="meeting-info">
          <strong>{title}</strong>
          <span>
            {meeting ? formatMeetingTime(meeting.startsAt) : meta}
            {meeting ? <em className={`badge ${status}`}>{badge(status)}</em> : null}
          </span>
        </span>
        <span className="count">{decisions.length}</span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </button>
      {expanded ? (
        <div className="meeting-body">
          {decisions.length === 0 ? (
            <p className="meeting-empty">
              {status === "upcoming"
                ? "Nothing decided yet. Drop messages here during the meeting."
                : "No decisions were recorded."}
            </p>
          ) : (
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
          )}
          <form className="decision-form" onSubmit={submit}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Add a decision"
              aria-label={`Add a decision to ${title}`}
            />
            <button className="btn primary small" type="submit" disabled={!draft.trim()}>
              Add
            </button>
          </form>
        </div>
      ) : null}
      <DropOverlay label={`Drop into ${title}`} />
    </article>
  );
}

function ScheduleForm({
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

function badge(status: string) {
  if (status === "today") return "Today";
  if (status === "upcoming") return "Upcoming";
  return "Done";
}

function defaultWhen() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(14, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
