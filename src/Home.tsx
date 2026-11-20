import { useState, type FormEvent } from "react";
import {
  cleanCode,
  getCurrentGroup,
  loadGroups,
  loadProfile,
  makeCode,
  saveGroup,
  saveProfile,
  setCurrentGroup,
  type Profile,
} from "./model";
import { Logo, joinGroup } from "./api";

export default function Home({ onOpenGroups }: { onOpenGroups: () => void }) {
  const existing = loadProfile();
  const [profile, setProfile] = useState<Profile>({
    name: existing?.name ?? "",
    role: existing?.role ?? "",
  });
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"create" | "join" | null>(null);
  const hasGroups = loadGroups().length > 0;

  function remember(next: Profile) {
    saveProfile(next);
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    const name = profile.name.trim();
    const role = profile.role.trim();
    const groupTitle = title.trim();
    if (!name || !role || !groupTitle) return;
    setError("");
    setPending("create");
    const nextCode = makeCode();
    try {
      const joined = await joinGroup({ name, role, code: nextCode, title: groupTitle });
      remember({ name, role });
      const now = new Date().toISOString();
      saveGroup({
        id: joined.code,
        code: joined.code,
        title: joined.title || groupTitle,
        createdAt: now,
        openedAt: now,
      });
      setCurrentGroup(joined.code);
      onOpenGroups();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the group.");
    } finally {
      setPending(null);
    }
  }

  async function joinWithCode(event: FormEvent) {
    event.preventDefault();
    const name = profile.name.trim();
    const role = profile.role.trim();
    const nextCode = cleanCode(code);
    if (!name || !role || !nextCode) return;
    setError("");
    setPending("join");
    try {
      const joined = await joinGroup({ name, role, code: nextCode });
      remember({ name, role });
      const previous = loadGroups().find((group) => group.id === joined.code);
      const now = new Date().toISOString();
      saveGroup({
        id: joined.code,
        code: joined.code,
        title: previous?.title || joined.title,
        createdAt: previous?.createdAt ?? now,
        openedAt: now,
      });
      setCurrentGroup(joined.code);
      onOpenGroups();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join the group.");
    } finally {
      setPending(null);
    }
  }

  const ready = profile.name.trim().length > 0 && profile.role.trim().length > 0;
  const current = getCurrentGroup();

  return (
    <main className="screen">
      <header className="app-header">
        <Logo />
      </header>
      <section className="home">
        <div className="home-copy">
          <h1>Start a group, or come back to one.</h1>
          <p>
            Create a room for this project, or enter with a code. Groups you have already
            joined stay in the list.
          </p>
        </div>
        <div className="identity">
          <label>
            Your name
            <input
              value={profile.name}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
              maxLength={40}
              required
            />
          </label>
          <label>
            Role
            <input
              value={profile.role}
              onChange={(event) => setProfile({ ...profile, role: event.target.value })}
              placeholder="UI/UX design"
              maxLength={40}
              required
            />
          </label>
        </div>
        <div className="split">
          <form className="panel-card" onSubmit={createGroup}>
            <h2>New group</h2>
            <p>A code is created for the rest of the team.</p>
            <label>
              Group name
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="CS473 · Prototype meeting"
                maxLength={80}
              />
            </label>
            <button type="submit" disabled={!ready || title.trim().length === 0 || pending !== null}>
              {pending === "create" ? "Creating..." : "Create group"}
            </button>
          </form>
          <form className="panel-card" onSubmit={joinWithCode}>
            <h2>Join with a code</h2>
            <p>Use the code someone in the group shares with you.</p>
            <label>
              Group code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="cs473"
                maxLength={40}
                autoCapitalize="none"
              />
            </label>
            <button
              className="secondary"
              type="submit"
              disabled={!ready || cleanCode(code).length === 0 || pending !== null}
            >
              {pending === "join" ? "Joining..." : "Join group"}
            </button>
          </form>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {hasGroups ? (
          <button className="text-link" type="button" onClick={onOpenGroups}>
            {current ? "Back to your groups" : "Your groups"}
          </button>
        ) : null}
      </section>
    </main>
  );
}
