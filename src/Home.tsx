import { useEffect, useState } from "react";
import { api, Logo } from "./api";
import { currentMeeting, formatDate, formatMeetingTime, meetingStatus, type GroupSummary } from "./model";
import { Avatar } from "./ui";

export default function Home({
  me,
  onCreate,
  onJoin,
  onOpen,
  onShowCode,
  onLogout,
}: {
  me: string;
  onCreate: () => void;
  onJoin: () => void;
  onOpen: (code: string) => void;
  onShowCode: (code: string) => void;
  onLogout: () => void;
}) {
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .groups()
      .then(setGroups)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load your groups."));
  }, []);

  return (
    <main className="screen scroll space-home">
      <header className="app-header">
        <div className="header-actions">
          <Logo />
          <span className="page-title">My space</span>
        </div>
        <div className="header-actions">
          <span className="me">
            <Avatar name={me} />
            {me}
          </span>
          <button className="btn ghost small" type="button" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>
      <section className="page">
        <div className="page-copy">
          <h1>Hi {me}, what's next?</h1>
          <p>Create a group for your team project, or join one with a code.</p>
        </div>

        <div className="choices">
          <button className="choice create" type="button" onClick={onCreate}>
            <span className="choice-icon" aria-hidden="true">
              +
            </span>
            <span className="choice-body">
              <strong>Create a group</strong>
              <span>Get an invitation code to share.</span>
            </span>
            <span className="choice-arrow" aria-hidden="true">
              →
            </span>
          </button>
          <button className="choice join" type="button" onClick={onJoin}>
            <span className="choice-icon" aria-hidden="true">
              #
            </span>
            <span className="choice-body">
              <strong>Join a group</strong>
              <span>Use the code your team sent you.</span>
            </span>
            <span className="choice-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>

        <section className="group-section">
          <h2>Your groups</h2>
          {error ? <p className="error">{error}</p> : null}
          {groups === null && !error ? <p className="muted">Loading...</p> : null}
          {groups?.length === 0 ? <p className="muted">Groups you create or join will show up here.</p> : null}
          {groups && groups.length > 0 ? (
            <div className="group-list">
              {groups.map((group) => {
                const next = currentMeeting(group.meetings);
                const done = group.meetings.filter((item) => meetingStatus(item) === "past").length;
                const ahead = group.meetings.length - done;
                return (
                  <article className="group-card" key={group.code}>
                    <button className="group-open" type="button" onClick={() => onOpen(group.code)}>
                      <span className="group-initial" aria-hidden="true">
                        {group.title.trim().charAt(0).toUpperCase() || "#"}
                      </span>
                      <span className="group-text">
                        <strong>{group.title}</strong>
                        <span>
                          {next
                            ? `Next: ${next.title} · ${formatMeetingTime(next.startsAt)}`
                            : `No upcoming meeting · ${group.members.length} member${group.members.length === 1 ? "" : "s"} · opened ${formatDate(group.openedAt)}`}
                        </span>
                      </span>
                      <span className="group-stats" aria-label={`${done} done, ${ahead} upcoming`}>
                        <em className="badge past">✓ {done} done</em>
                        <em className={ahead ? "badge upcoming" : "badge"}>{ahead} upcoming</em>
                      </span>
                    </button>
                    <button
                      className="code-chip"
                      type="button"
                      onClick={() => onShowCode(group.code)}
                      title="Show invitation code"
                    >
                      {group.code.toUpperCase()}
                    </button>
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
