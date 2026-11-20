import { getCurrentGroup, loadGroups, loadProfile, type Group } from "./model";
import { Logo } from "./api";

export default function Groups({
  onHome,
  onOpen,
}: {
  onHome: () => void;
  onOpen: (group: Group) => void;
}) {
  const profile = loadProfile();
  const currentId = getCurrentGroup();
  const groups = loadGroups();
  const current = groups.find((group) => group.id === currentId) ?? null;
  const past = groups.filter((group) => group.id !== currentId);

  return (
    <main className="screen">
      <header className="app-header">
        <Logo />
        <button className="text-link" type="button" onClick={onHome}>
          New or join
        </button>
      </header>
      <section className="groups">
        <div className="home-copy">
          <h1>Your groups</h1>
          <p>
            {profile
              ? `${profile.name} · ${profile.role}`
              : "Open a past project, or the group you just joined."}
          </p>
        </div>
        {current ? (
          <GroupSection title="Just joined" groups={[current]} onOpen={onOpen} emphasis />
        ) : null}
        <GroupSection
          title="Past projects"
          groups={past}
          onOpen={onOpen}
          empty="Groups you joined before will stay here."
        />
      </section>
    </main>
  );
}

function GroupSection({
  title,
  groups,
  onOpen,
  empty,
  emphasis = false,
}: {
  title: string;
  groups: Group[];
  onOpen: (group: Group) => void;
  empty?: string;
  emphasis?: boolean;
}) {
  return (
    <section className="group-section">
      <h2>{title}</h2>
      {groups.length === 0 ? <p className="muted">{empty}</p> : null}
      <div className="group-list">
        {groups.map((group) => (
          <article className={emphasis ? "group-card current" : "group-card"} key={group.id}>
            <div>
              <h3>{group.title}</h3>
              <p>Code {group.code.toUpperCase()}</p>
            </div>
            <button type="button" onClick={() => onOpen(group)}>
              Enter
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
