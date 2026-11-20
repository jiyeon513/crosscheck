import { useState, type FormEvent, type ReactNode } from "react";
import { Logo, joinGroup } from "./api";
import {
  cleanCode,
  loadGroups,
  makeCode,
  saveGroup,
  setCurrentGroup,
  type Group,
  type Profile,
} from "./model";
import { BackButton } from "./ui";

function StartLayout({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <main className="screen scroll">
      <header className="app-header">
        <Logo />
        <BackButton onClick={onBack} />
      </header>
      <section className="page narrow">{children}</section>
    </main>
  );
}

export function CreateChat({
  profile,
  onBack,
  onCreated,
}: {
  profile: Profile;
  onBack: () => void;
  onCreated: (groupId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const groupTitle = title.trim();
    if (!groupTitle) return;
    setError("");
    setPending(true);
    try {
      const joined = await joinGroup({ name: profile.name, code: makeCode(), title: groupTitle });
      const now = new Date().toISOString();
      saveGroup({
        id: joined.code,
        code: joined.code,
        title: joined.title || groupTitle,
        createdAt: now,
        openedAt: now,
      });
      setCurrentGroup(joined.code);
      onCreated(joined.code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the group.");
    } finally {
      setPending(false);
    }
  }

  return (
    <StartLayout onBack={onBack}>
      <form className="card form-card" onSubmit={submit}>
        <span className="step-icon create" aria-hidden="true">
          +
        </span>
        <h1>Create a group</h1>
        <p className="muted">
          One group per team project. You'll schedule meetings inside it and get an invitation code
          next.
        </p>
        <label>
          Group name
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="CS473 · Team project"
            maxLength={80}
            autoFocus
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="btn primary block" type="submit" disabled={!title.trim() || pending}>
          {pending ? "Creating..." : "Create group"}
        </button>
      </form>
    </StartLayout>
  );
}

export function JoinChat({
  profile,
  onBack,
  onJoined,
}: {
  profile: Profile;
  onBack: () => void;
  onJoined: (groupId: string) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextCode = cleanCode(code);
    if (!nextCode) return;
    setError("");
    setPending(true);
    try {
      const joined = await joinGroup({ name: profile.name, code: nextCode });
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
      onJoined(joined.code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join the group.");
    } finally {
      setPending(false);
    }
  }

  return (
    <StartLayout onBack={onBack}>
      <form className="card form-card" onSubmit={submit}>
        <span className="step-icon join" aria-hidden="true">
          #
        </span>
        <h1>Join a group</h1>
        <p className="muted">Enter the invitation code a teammate shared with you.</p>
        <label>
          Invitation code
          <input
            className="code-input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="ABC123"
            maxLength={40}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button
          className="btn primary block"
          type="submit"
          disabled={cleanCode(code).length === 0 || pending}
        >
          {pending ? "Joining..." : "Join group"}
        </button>
      </form>
    </StartLayout>
  );
}

export function InviteCode({
  group,
  onBack,
  onEnter,
}: {
  group: Group;
  onBack: () => void;
  onEnter: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const code = group.code.toUpperCase();

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <StartLayout onBack={onBack}>
      <div className="card form-card invite">
        <span className="step-icon done" aria-hidden="true">
          ✓
        </span>
        <h1>{group.title}</h1>
        <p className="muted">Share this invitation code so your team can join.</p>
        <div className="invite-code" aria-label={`Invitation code ${code}`}>
          {code.split("").map((char, index) => (
            <span key={index}>{char}</span>
          ))}
        </div>
        <button className="btn secondary block" type="button" onClick={copy}>
          {copied ? "Copied!" : "Copy code"}
        </button>
        <button className="btn primary block" type="button" onClick={onEnter}>
          Enter group
        </button>
      </div>
    </StartLayout>
  );
}
