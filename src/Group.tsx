import { useCallback, useEffect, useState } from "react";
import { api, Logo } from "./api";
import { DecisionList, MeetingDate, ScheduleForm, StatusBadge } from "./Meetings";
import { formatMeetingTime, meetingStatus, type GroupDetail, type Meeting } from "./model";
import { Avatar, BackButton } from "./ui";

export default function GroupPage({
  code,
  me,
  onBack,
  onOpenChat,
}: {
  code: string;
  me: string;
  onBack: () => void;
  onOpenChat: () => void;
}) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [error, setError] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.group(code));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the group.");
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!detail) {
    return (
      <main className="screen scroll">
        <header className="app-header">
          <BackButton onClick={onBack} label="Groups" />
        </header>
        <section className="page">{error ? <p className="error">{error}</p> : <p className="muted">Loading...</p>}</section>
      </main>
    );
  }

  const { group, meetings, decisions } = detail;
  const now = new Date();
  const upcoming = meetings.filter((item) => meetingStatus(item, now) !== "past");
  const done = meetings.filter((item) => meetingStatus(item, now) === "past").reverse();
  const logged = meetings.filter((item) => meetingStatus(item, now) !== "upcoming").reverse();
  const known = new Set(meetings.map((item) => item.id));
  const loose = decisions.filter((item) => !item.meetingId || !known.has(item.meetingId));
  const decisionsOf = (meeting: Meeting) => decisions.filter((item) => item.meetingId === meeting.id);
  const edit = async (id: string, text: string) => {
    await api.editDecision(code, id, text);
    await load();
  };

  async function schedule(title: string, startsAt: string) {
    await api.scheduleMeeting(code, title, startsAt);
    setScheduling(false);
    await load();
  }

  function jumpTo(id: string) {
    document.getElementById(`log-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlight(id);
    setTimeout(() => setHighlight(null), 1400);
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(group.code.toUpperCase());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="screen scroll">
      <header className="app-header">
        <div className="header-actions">
          <BackButton onClick={onBack} label="Groups" />
          <Logo />
        </div>
        <span className="me">
          <Avatar name={me} />
          {me}
        </span>
      </header>

      <section className="page wide">
        <div className="group-hero card">
          <div className="group-hero-text">
            <span className="group-initial big" aria-hidden="true">
              {group.title.trim().charAt(0).toUpperCase() || "#"}
            </span>
            <div>
              <h1>{group.title}</h1>
              <p className="muted">
                {group.members.join(", ")} · {meetings.length} meeting{meetings.length === 1 ? "" : "s"} ·{" "}
                {decisions.length} decision{decisions.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          <div className="group-hero-actions">
            <button className="code-chip" type="button" onClick={copyCode} title="Copy invitation code">
              {copied ? "Copied" : group.code.toUpperCase()}
            </button>
            <button className="btn primary" type="button" onClick={onOpenChat}>
              Open chat room →
            </button>
          </div>
        </div>

        <div className="group-grid">
          <section className="card schedule-card">
            <header className="section-head">
              <h2>Meeting schedule</h2>
              <button
                className={scheduling ? "btn small schedule-btn on" : "btn small schedule-btn"}
                type="button"
                onClick={() => setScheduling((value) => !value)}
                aria-expanded={scheduling}
              >
                + Schedule
              </button>
            </header>
            {scheduling ? <ScheduleForm onSubmit={schedule} onCancel={() => setScheduling(false)} /> : null}

            <h3 className="sub-head">Upcoming</h3>
            {upcoming.length === 0 ? (
              <p className="muted small-note">Nothing scheduled. Plan the next meeting.</p>
            ) : (
              <ul className="schedule-list">
                {upcoming.map((meeting) => {
                  const status = meetingStatus(meeting, now);
                  return (
                    <li key={meeting.id} className={`schedule-row ${status}`}>
                      <MeetingDate value={meeting.startsAt} status={status} />
                      <div className="meeting-info">
                        <strong>{meeting.title}</strong>
                        <span>
                          {formatMeetingTime(meeting.startsAt)}
                          <StatusBadge status={status} />
                        </span>
                      </div>
                      {status === "today" ? (
                        <button className="btn small primary" type="button" onClick={onOpenChat}>
                          Join
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <h3 className="sub-head">Completed</h3>
            {done.length === 0 ? (
              <p className="muted small-note">No meetings have happened yet.</p>
            ) : (
              <ul className="schedule-list">
                {done.map((meeting) => (
                  <li key={meeting.id}>
                    <button className="schedule-row past" type="button" onClick={() => jumpTo(meeting.id)}>
                      <MeetingDate value={meeting.startsAt} status="past" />
                      <span className="meeting-info">
                        <strong>{meeting.title}</strong>
                        <span>
                          {formatMeetingTime(meeting.startsAt)}
                          <StatusBadge status="past" />
                        </span>
                      </span>
                      <span className="row-count">
                        {decisionsOf(meeting).length} decision{decisionsOf(meeting).length === 1 ? "" : "s"} ›
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="logs-col">
            <header className="section-head plain">
              <h2>Decision logs</h2>
              <p className="muted">What the team agreed on, meeting by meeting. You can fix the wording.</p>
            </header>
            {logged.length === 0 && loose.length === 0 ? (
              <div className="card empty-card">
                <p className="muted">Decision logs appear here once your meetings happen.</p>
              </div>
            ) : null}
            {logged.map((meeting) => {
              const status = meetingStatus(meeting, now);
              const items = decisionsOf(meeting);
              return (
                <article
                  key={meeting.id}
                  id={`log-${meeting.id}`}
                  className={highlight === meeting.id ? "card log-card highlight" : "card log-card"}
                >
                  <header className="log-card-head">
                    <MeetingDate value={meeting.startsAt} status={status} />
                    <div className="meeting-info">
                      <strong>{meeting.title}</strong>
                      <span>
                        {formatMeetingTime(meeting.startsAt)}
                        <StatusBadge status={status} />
                      </span>
                    </div>
                    <span className="count">{items.length}</span>
                  </header>
                  {items.length === 0 ? (
                    <p className="muted small-note">
                      {status === "today" ? "In progress. Nothing agreed yet." : "No decisions were agreed."}
                    </p>
                  ) : (
                    <DecisionList decisions={items} onEdit={edit} />
                  )}
                </article>
              );
            })}
            {loose.length > 0 ? (
              <article className="card log-card">
                <header className="log-card-head">
                  <MeetingDate status="none" />
                  <div className="meeting-info">
                    <strong>Not tied to a meeting</strong>
                    <span>Agreed outside a scheduled meeting</span>
                  </div>
                  <span className="count">{loose.length}</span>
                </header>
                <DecisionList decisions={loose} onEdit={edit} />
              </article>
            ) : null}
          </section>
        </div>
      </section>
    </main>
  );
}
