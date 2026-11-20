import { formatMeetingTime, loadGroups, meetingsFor, nextMeeting, type Profile } from "./model";
import { Logo } from "./api";
import { Avatar } from "./ui";

export default function Home({
  profile,
  onCreate,
  onJoin,
  onOpen,
  onShowCode,
  onLogout,
}: {
  profile: Profile;
  onCreate: () => void;
  onJoin: () => void;
  onOpen: (groupId: string) => void;
  onShowCode: (groupId: string) => void;
  onLogout: () => void;
}) {
  const groups = loadGroups();

  return (
    <main className="screen scroll">
      <header className="app-header">
        <Logo />
        <div className="header-actions">
          <span className="me">
            <Avatar name={profile.name} />
            {profile.name}
          </span>
          <button className="btn ghost small" type="button" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>
      <section className="page">
        <div className="page-copy">
          <h1>Hi {profile.name}, what's next?</h1>
          <p>
            Start a group for your team project, or join one with an invitation code. Each group
            keeps one ongoing chat and a decision log for every meeting.
          </p>
        </div>

        <div className="choices">
          <button className="choice create" type="button" onClick={onCreate}>
            <span className="choice-icon" aria-hidden="true">
              +
            </span>
            <span className="choice-body">
              <strong>Create a group</strong>
              <span>One per team project. You get an invitation code to share.</span>
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
              <span>Enter the code someone on your team sent you.</span>
            </span>
            <span className="choice-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>

        <section className="group-section">
          <h2>Your groups</h2>
          {groups.length === 0 ? (
            <p className="muted">Groups you create or join will show up here.</p>
          ) : (
            <div className="group-list">
              {groups.map((group) => {
                const next = nextMeeting(group.id);
                const count = meetingsFor(group.id).length;
                return (
                  <article className="group-card" key={group.id}>
                    <button className="group-open" type="button" onClick={() => onOpen(group.id)}>
                      <span className="group-initial" aria-hidden="true">
                        {group.title.trim().charAt(0).toUpperCase() || "#"}
                      </span>
                      <span className="group-text">
                        <strong>{group.title}</strong>
                        <span>
                          {next
                            ? `Next: ${next.title} · ${formatMeetingTime(next.startsAt)}`
                            : count
                              ? `${count} meeting${count === 1 ? "" : "s"} · last opened ${formatDate(group.openedAt)}`
                              : `No meetings yet · last opened ${formatDate(group.openedAt)}`}
                        </span>
                      </span>
                    </button>
                    <button
                      className="code-chip"
                      type="button"
                      onClick={() => onShowCode(group.id)}
                      title="Show invitation code"
                    >
                      {group.code.toUpperCase()}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
