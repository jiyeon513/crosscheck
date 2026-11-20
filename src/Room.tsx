import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import type { Channel } from "stream-chat";
import { useCreateChatClient } from "stream-chat-react";
import { Logo, type JoinResult, joinGroup } from "./api";
import {
  agentReply,
  agentThread,
  decisionsFor,
  demoMessagesFor,
  loadProfile,
  markOpened,
  saveAgentThread,
  saveDecisions,
  type AgentMessage,
  type Decision,
  type Group,
  type Profile,
  type TeamMessage,
} from "./model";

let carried: { from: string; text: string } | null = null;

type WireMessage = {
  id?: string;
  text?: string;
  created_at?: unknown;
  user?: { id?: string; name?: string } | null;
  custom?: { kind?: string; displayRole?: string } | null;
};

export default function Room({ group, onBack }: { group: Group; onBack: () => void }) {
  const [profile] = useState(loadProfile);
  const [session, setSession] = useState<JoinResult | null>(null);
  const [ready, setReady] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [liveChat, setLiveChat] = useState<TeamMessage[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>(() => decisionsFor(group.id));
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>(() =>
    agentThread(group.id, profile?.name ?? "You"),
  );
  const [teamDraft, setTeamDraft] = useState("");
  const [agentDraft, setAgentDraft] = useState("");
  const [decisionDraft, setDecisionDraft] = useState("");
  const [teamOver, setTeamOver] = useState(false);
  const [agentOver, setAgentOver] = useState(false);
  const [logOver, setLogOver] = useState(false);
  const [notice, setNotice] = useState("");
  const channelRef = useRef<Channel | null>(null);

  useEffect(() => {
    markOpened(group.id);
  }, [group.id]);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    joinGroup({ name: profile.name, role: profile.role, code: group.code, title: group.title })
      .then((result) => {
        if (!cancelled) setSession(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setConnectError(caught instanceof Error ? caught.message : "Could not connect.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [group.code, group.title, profile]);

  const demo = useMemo(() => demoMessagesFor(group.id), [group.id]);
  const teamMessages = useMemo(() => {
    const liveIds = new Set(liveChat.map((message) => message.id));
    return [...demo.filter((message) => !liveIds.has(message.id)), ...liveChat];
  }, [demo, liveChat]);
  const people = useMemo(() => {
    const names = new Map<string, string>();
    for (const message of teamMessages) names.set(message.author, message.role);
    if (profile && !names.has(profile.name)) names.set(profile.name, profile.role);
    return [...names.entries()].map(([name, role]) => ({ name, role }));
  }, [profile, teamMessages]);

  function rememberDecisions(next: Decision[]) {
    setDecisions(next);
    saveDecisions(group.id, next);
  }

  function rememberAgent(next: AgentMessage[]) {
    setAgentMessages(next);
    if (profile) saveAgentThread(group.id, profile.name, next);
  }

  async function shareDecision(entry: Decision) {
    const channel = channelRef.current;
    if (!channel || !profile) return;
    await channel.sendMessage({
      message: {
        id: entry.id,
        text: entry.text,
        custom: { kind: "decision", displayRole: profile.role },
      },
    });
  }

  async function recordDecision(text: string) {
    if (!profile) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const entry: Decision = {
      id: `dec_${crypto.randomUUID()}`,
      groupId: group.id,
      text: trimmed,
      author: profile.name,
      role: profile.role,
      createdAt: new Date().toISOString(),
    };
    rememberDecisions([...decisions.filter((item) => item.id !== entry.id), entry]);
    setDecisionDraft("");
    try {
      await shareDecision(entry);
      setNotice("");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Saved on this device only.");
    }
  }

  async function sendTeam(event: FormEvent) {
    event.preventDefault();
    const text = teamDraft.trim();
    const channel = channelRef.current;
    if (!text || !channel || !profile) return;
    setTeamDraft("");
    try {
      await channel.sendMessage({
        message: { text, custom: { displayRole: profile.role } },
      });
      setNotice("");
    } catch (caught) {
      setTeamDraft(text);
      setNotice(caught instanceof Error ? caught.message : "Could not send that message.");
    }
  }

  function sendAgent(event: FormEvent) {
    event.preventDefault();
    const text = agentDraft.trim();
    if (!text || !profile) return;
    const now = new Date().toISOString();
    const next: AgentMessage[] = [
      ...agentMessages,
      { id: crypto.randomUUID(), label: "", text, createdAt: now, from: "user" },
      {
        id: crypto.randomUUID(),
        label: "From your note",
        text: agentReply(profile.name, text),
        createdAt: new Date(Date.now() + 1).toISOString(),
        from: "agent",
      },
    ];
    setAgentDraft("");
    rememberAgent(next);
  }

  function acceptDrop(event: DragEvent, target: "team" | "agent" | "log") {
    event.preventDefault();
    const payload = readDrop(event);
    setTeamOver(false);
    setAgentOver(false);
    setLogOver(false);
    if (!payload) return;
    carried = null;
    if (target === "log") {
      void recordDecision(payload.text);
      return;
    }
    if (payload.from === target) return;
    const append = (current: string) => (current.trim() ? `${current.trim()}\n${payload.text}` : payload.text);
    if (target === "team") setTeamDraft(append);
    else setAgentDraft(append);
  }

  if (!profile) {
    return (
      <main className="screen">
        <p className="muted">Add your name on the first screen before entering a group.</p>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </main>
    );
  }

  const stamp = teamMessages.at(-1)?.createdAt;

  return (
    <main className="screen room-screen">
      <header className="app-header">
        <div className="header-title">
          <button className="back" type="button" onClick={onBack} aria-label="Back to groups">
            <Logo />
          </button>
          <h1>{group.title}</h1>
        </div>
        <span className="you-pill">
          {profile.name} (You) · Role: {profile.role}
        </span>
      </header>
      <p className="drag-hint">
        Drag a bubble into the other box, or onto the decision log.
        {connectError ? ` ${connectError}` : ""}
        {notice ? ` ${notice}` : ""}
      </p>
      <div className="workspace">
        <section className="chat-panel team-panel">
          <header className="panel-head">
            <div>
              <h2>Team conversation</h2>
              {stamp ? <p>{formatStamp(stamp)}</p> : <p>Code {group.code.toUpperCase()}</p>}
            </div>
            <People people={people} />
          </header>
          <div className="thread">
            {teamMessages.length === 0 ? (
              <p className="muted">No messages yet. Say hello to the team.</p>
            ) : (
              teamMessages.map((message) => (
                <Bubble
                  key={message.id}
                  from="team"
                  title={`${message.author} · Role: ${message.role}`}
                  text={message.text}
                />
              ))
            )}
          </div>
          {session ? (
            <LiveChannel
              session={session}
              groupId={group.id}
              profile={profile}
              onChannel={(channel) => {
                channelRef.current = channel;
                setReady(true);
              }}
              onWire={(chat, liveDecisions) => {
                setLiveChat(chat);
                if (liveDecisions.length) {
                  setDecisions((current) => {
                    const merged = mergeDecisions(current, liveDecisions);
                    saveDecisions(group.id, merged);
                    return merged;
                  });
                }
              }}
              onError={setConnectError}
            />
          ) : null}
          <form
            className={teamOver ? "composer over" : "composer"}
            onSubmit={sendTeam}
            onDragOver={(event) => {
              event.preventDefault();
              setTeamOver(true);
            }}
            onDragLeave={() => setTeamOver(false)}
            onDrop={(event) => acceptDrop(event, "team")}
          >
            <input
              value={teamDraft}
              onChange={(event) => setTeamDraft(event.target.value)}
              placeholder={`Message as ${profile.name}...`}
              aria-label={`Message as ${profile.name}`}
            />
            <button type="submit" disabled={!ready || teamDraft.trim().length === 0}>
              Send
            </button>
          </form>
        </section>

        <section
          className={logOver ? "log-panel over" : "log-panel"}
          onDragOver={(event) => {
            event.preventDefault();
            setLogOver(true);
          }}
          onDragLeave={() => setLogOver(false)}
          onDrop={(event) => acceptDrop(event, "log")}
        >
          <header className="panel-head">
            <div>
              <h2>Decision log</h2>
              <p>Kept from earlier in this group.</p>
            </div>
          </header>
          <div className="thread">
            {decisions.length === 0 ? (
              <p className="muted">Drop a message here when the team agrees.</p>
            ) : (
              decisions.map((decision) => (
                <article className="decision" key={decision.id}>
                  <p className="decision-meta">
                    {formatShort(decision.createdAt)} · {decision.author}
                  </p>
                  <p>{decision.text}</p>
                </article>
              ))
            )}
          </div>
          <form
            className="composer log-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void recordDecision(decisionDraft);
            }}
          >
            <input
              value={decisionDraft}
              onChange={(event) => setDecisionDraft(event.target.value)}
              placeholder="Write a decision"
              aria-label="Write a decision"
            />
            <button type="submit" disabled={decisionDraft.trim().length === 0}>
              Record
            </button>
          </form>
        </section>

        <section className="chat-panel agent-panel">
          <header className="agent-head">
            <span className="agent-mark" aria-hidden="true">
              ◇
            </span>
            <h2>{profile.name}&apos;s Personal Agent</h2>
          </header>
          <div className="thread">
            {agentMessages.map((message) =>
              message.from === "agent" ? (
                <Bubble key={message.id} from="agent" label={message.label} text={message.text} />
              ) : (
                <Bubble key={message.id} from="user" title="You" text={message.text} />
              ),
            )}
          </div>
          <form
            className={agentOver ? "composer agent-composer over" : "composer agent-composer"}
            onSubmit={sendAgent}
            onDragOver={(event) => {
              event.preventDefault();
              setAgentOver(true);
            }}
            onDragLeave={() => setAgentOver(false)}
            onDrop={(event) => acceptDrop(event, "agent")}
          >
            <input
              value={agentDraft}
              onChange={(event) => setAgentDraft(event.target.value)}
              placeholder="Message your personal agent"
              aria-label="Message your personal agent"
            />
            <button type="submit" disabled={agentDraft.trim().length === 0}>
              Send
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function LiveChannel({
  session,
  groupId,
  profile,
  onChannel,
  onWire,
  onError,
}: {
  session: JoinResult;
  groupId: string;
  profile: Profile;
  onChannel: (channel: Channel) => void;
  onWire: (chat: TeamMessage[], decisions: Decision[]) => void;
  onError: (message: string) => void;
}) {
  const client = useCreateChatClient({
    apiKey: session.apiKey,
    tokenOrProvider: session.token,
    userData: { id: session.userId, name: session.name },
  });
  const onWireRef = useRef(onWire);
  const onChannelRef = useRef(onChannel);
  const onErrorRef = useRef(onError);
  onWireRef.current = onWire;
  onChannelRef.current = onChannel;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const channel = client.channel("messaging", groupId);
    const sync = () => publish(channel, session.userId, profile, groupId, onWireRef.current);
    channel
      .watch()
      .then(() => {
        if (cancelled) return;
        onChannelRef.current(channel);
        sync();
        channel.on("message.new", sync);
        channel.on("message.updated", sync);
        channel.on("message.deleted", sync);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          onErrorRef.current(caught instanceof Error ? caught.message : "Could not open the room.");
        }
      });
    return () => {
      cancelled = true;
      channel.off("message.new", sync);
      channel.off("message.updated", sync);
      channel.off("message.deleted", sync);
    };
  }, [client, groupId, profile, session.userId]);

  return null;
}

function publish(
  channel: Channel,
  userId: string,
  profile: Profile,
  groupId: string,
  onWire: (chat: TeamMessage[], decisions: Decision[]) => void,
) {
  const messages = (channel.messagePaginator.items ?? []) as unknown as WireMessage[];
  const chat: TeamMessage[] = [];
  const decisions: Decision[] = [];
  for (const message of messages) {
    const text = message.text?.trim() ?? "";
    if (!text || !message.id) continue;
    const author = message.user?.name || profile.name;
    const role = message.custom?.displayRole || (message.user?.id === userId ? profile.role : "Teammate");
    const createdAt = toIso(message.created_at);
    if (message.custom?.kind === "decision") {
      decisions.push({ id: message.id, groupId, text, author, role, createdAt });
    } else {
      chat.push({
        id: message.id,
        text,
        author,
        role,
        createdAt,
        mine: message.user?.id === userId,
      });
    }
  }
  onWire(chat, decisions);
}

function Bubble({
  from,
  title,
  label,
  text,
}: {
  from: "team" | "agent" | "user";
  title?: string;
  label?: string;
  text: string;
}) {
  function dragStart(event: DragEvent) {
    carried = { from, text };
    event.dataTransfer.setData("application/x-crosscheck", JSON.stringify({ from, text }));
    event.dataTransfer.setData("text/plain", text);
    event.dataTransfer.effectAllowed = "copy";
  }

  return (
    <article
      className={`bubble ${from}`}
      draggable
      onDragStart={dragStart}
      onDragEnd={() => {
        setTimeout(() => {
          carried = null;
        }, 0);
      }}
    >
      {from === "team" ? <Avatar name={title?.split("·")[0]?.trim() || "?"} /> : null}
      <div>
        {label ? <p className="bubble-label">{label}</p> : null}
        {title ? <p className="bubble-title">{title}</p> : null}
        <p className="bubble-text">{text}</p>
      </div>
    </article>
  );
}

function Avatar({ name }: { name: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={`avatar tone-${tone(name)}`} aria-hidden="true">
      {letter}
    </span>
  );
}

function People({ people }: { people: { name: string; role: string }[] }) {
  const shown = people.slice(0, 3);
  const count = people.length;
  return (
    <div className="people">
      <div className="avatar-stack">
        {shown.map((person) => (
          <Avatar key={person.name} name={person.name} />
        ))}
      </div>
      <span>
        {count} participant{count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function readDrop(event: DragEvent): { from: string; text: string } | null {
  if (carried?.text) return carried;
  const raw = event.dataTransfer.getData("application/x-crosscheck");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { from?: string; text?: string };
      if (parsed.text?.trim()) return { from: parsed.from ?? "", text: parsed.text.trim() };
    } catch {
      // Fall through to plain text from another app.
    }
  }
  const text = event.dataTransfer.getData("text/plain").trim();
  return text ? { from: "", text } : null;
}

function mergeDecisions(current: Decision[], incoming: Decision[]) {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function toIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e14 ? value / 1e6 : value;
    return new Date(millis).toISOString();
  }
  return new Date().toISOString();
}

function formatStamp(value: string) {
  const date = new Date(value);
  const day = date.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

function formatShort(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function tone(name: string) {
  return name.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
}
