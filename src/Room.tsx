import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import type { Channel } from "stream-chat";
import { useCreateChatClient } from "stream-chat-react";
import { Logo, askModerator, askPersonalAgent, type JoinResult, joinGroup } from "./api";
import {
  agentThread,
  decisionsFor,
  demoMessagesFor,
  formatMeetingTime,
  markOpened,
  meetingsFor,
  currentMeeting,
  saveAgentThread,
  saveDecisions,
  saveMeetings,
  sortMeetings,
  type AgentMessage,
  type Decision,
  type Group,
  type Meeting,
  type Profile,
  type Quote,
  type TeamMessage,
} from "./model";
import { Avatar } from "./ui";
import CurrentLog from "./Meetings";

type Source = "team" | "agent" | "user";
type Carried = { from: Source | ""; author: string; text: string };
type Target = "team" | "agent" | "log";

let carried: Carried | null = null;

const LOG_OPEN_KEY = "crosscheck.logOpen";
/** Stream user id the server posts moderator messages as (see agents/moderator.mjs). */
const MODERATOR_ID = "crosscheck-moderator";

type WireMessage = {
  id?: string;
  text?: string;
  created_at?: unknown;
  user?: { id?: string; name?: string } | null;
  custom?: {
    kind?: string;
    quote?: Quote;
    forwarded?: boolean;
    meetingId?: string;
    meeting?: Meeting;
  } | null;
};

export default function Room({
  group,
  profile,
  onBack,
}: {
  group: Group;
  profile: Profile;
  onBack: () => void;
}) {
  const [session, setSession] = useState<JoinResult | null>(null);
  const [ready, setReady] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [liveChat, setLiveChat] = useState<TeamMessage[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>(() => decisionsFor(group.id));
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>(() =>
    agentThread(group.id, profile.name),
  );
  const [teamDraft, setTeamDraft] = useState("");
  const [teamQuote, setTeamQuote] = useState<Quote | null>(null);
  const [agentDraft, setAgentDraft] = useState("");
  const [agentQuote, setAgentQuote] = useState<Quote | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>(() => meetingsFor(group.id));
  const [over, setOver] = useState<Target | null>(null);
  const [dragging, setDragging] = useState<Source | null>(null);
  const [notice, setNotice] = useState("");
  const [agentThinking, setAgentThinking] = useState(false);
  const [moderatorBusy, setModeratorBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [logOpen, setLogOpen] = useState(() => {
    try {
      return localStorage.getItem(LOG_OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [flash, setFlash] = useState(false);
  const channelRef = useRef<Channel | null>(null);
  const teamEnd = useRef<HTMLDivElement | null>(null);
  const agentEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    markOpened(group.id);
  }, [group.id]);

  useEffect(() => {
    let cancelled = false;
    joinGroup({ name: profile.name, code: group.code, title: group.title })
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
  }, [group.code, group.title, profile.name]);

  const demo = useMemo(() => demoMessagesFor(group.id), [group.id]);
  const teamMessages = useMemo(() => {
    const liveIds = new Set(liveChat.map((message) => message.id));
    return [...demo.filter((message) => !liveIds.has(message.id)), ...liveChat];
  }, [demo, liveChat]);
  const people = useMemo(() => {
    const names = new Set<string>();
    for (const message of teamMessages) names.add(message.author);
    names.add(profile.name);
    return [...names];
  }, [profile.name, teamMessages]);

  useEffect(() => {
    teamEnd.current?.scrollIntoView({ block: "end" });
  }, [teamMessages.length]);
  useEffect(() => {
    agentEnd.current?.scrollIntoView({ block: "end" });
  }, [agentMessages.length]);

  function toggleLog() {
    setLogOpen((open) => {
      try {
        localStorage.setItem(LOG_OPEN_KEY, open ? "0" : "1");
      } catch {
        // Preference only.
      }
      return !open;
    });
  }

  function rememberDecisions(next: Decision[]) {
    setDecisions(next);
    saveDecisions(group.id, next);
  }

  function rememberAgent(next: AgentMessage[]) {
    setAgentMessages(next);
    saveAgentThread(group.id, profile.name, next);
  }

  const current = currentMeeting(meetings);

  async function recordDecision(text: string) {
    const meetingId = current?.id ?? "";
    const trimmed = text.trim();
    if (!trimmed) return;
    const entry: Decision = {
      id: `dec_${crypto.randomUUID()}`,
      groupId: group.id,
      ...(meetingId ? { meetingId } : {}),
      text: trimmed,
      author: profile.name,
      createdAt: new Date().toISOString(),
    };
    rememberDecisions([...decisions.filter((item) => item.id !== entry.id), entry]);
    if (!logOpen) {
      setFlash(true);
      setTimeout(() => setFlash(false), 900);
    }
    const channel = channelRef.current;
    if (!channel) return;
    try {
      await channel.sendMessage({
        message: {
          id: entry.id,
          text: entry.text,
          custom: { kind: "decision", ...(meetingId ? { meetingId } : {}) },
        },
      });
      setNotice("");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Saved on this device only.");
    }
  }

  async function scheduleMeeting(title: string, startsAt: string) {
    const meeting: Meeting = {
      id: `mtg_${crypto.randomUUID()}`,
      groupId: group.id,
      title,
      startsAt,
      createdBy: profile.name,
      createdAt: new Date().toISOString(),
    };
    const next = sortMeetings([...meetings, meeting]);
    setMeetings(next);
    saveMeetings(group.id, next);
    await shareMeeting(meeting);
  }

  async function shareMeeting(meeting: Meeting) {
    const channel = channelRef.current;
    if (!channel) return false;
    const { pendingShare: _pending, ...shared } = meeting;
    const { title, startsAt } = meeting;
    try {
      await channel.sendMessage({
        message: {
          id: meeting.id,
          text: `Scheduled ${title} · ${formatMeetingTime(startsAt)}`,
          custom: { kind: "meeting", meeting: shared },
        },
      });
      setNotice("");
      return true;
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Saved on this device only.");
      return false;
    }
  }

  /** Meetings scheduled from the group page are announced once the room is connected. */
  async function sharePending() {
    const pending = meetingsFor(group.id).filter((item) => item.pendingShare);
    if (pending.length === 0) return;
    const sent = new Set<string>();
    for (const meeting of pending) {
      if (await shareMeeting(meeting)) sent.add(meeting.id);
    }
    const next = meetingsFor(group.id).map((item) =>
      sent.has(item.id) ? { ...item, pendingShare: false } : item,
    );
    saveMeetings(group.id, next);
    setMeetings(next);
  }

  async function sendTeam(event: FormEvent) {
    event.preventDefault();
    const text = teamDraft.trim();
    const quote = teamQuote;
    const channel = channelRef.current;
    if ((!text && !quote) || !channel) return;
    setTeamDraft("");
    setTeamQuote(null);
    try {
      await channel.sendMessage({
        message: {
          text: text || quote!.text,
          custom: quote ? { quote, forwarded: !text } : {},
        },
      });
      setNotice("");
      // The moderator's shouldModeratorSpeak() policy decides whether to answer.
      void callModerator("message");
    } catch (caught) {
      setTeamDraft(text);
      setTeamQuote(quote);
      setNotice(caught instanceof Error ? caught.message : "Could not send that message.");
    }
  }

  const meetingRef = current ? { title: current.title, startsAt: current.startsAt } : null;

  async function sendAgent(event: FormEvent) {
    event.preventDefault();
    const text = agentDraft.trim();
    const quote = agentQuote;
    if ((!text && !quote) || agentThinking) return;
    const withMine: AgentMessage[] = [
      ...agentMessages,
      {
        id: crypto.randomUUID(),
        label: "",
        text,
        createdAt: new Date().toISOString(),
        from: "user",
        ...(quote ? { quote } : {}),
      },
    ];
    setAgentDraft("");
    setAgentQuote(null);
    rememberAgent(withMine);
    setAgentThinking(true);
    let reply: AgentMessage;
    try {
      const result = await askPersonalAgent({
        name: profile.name,
        groupTitle: group.title,
        meeting: meetingRef,
        team: teamMessages.map(({ author, text, createdAt, quote }) => ({
          author,
          text,
          createdAt,
          ...(quote ? { quote } : {}),
        })),
        // Failed replies are local notices, not part of the conversation.
        personal: withMine
          .filter((message) => !message.failed)
          .map(({ from, text, quote }) => ({ from, text, ...(quote ? { quote } : {}) })),
      });
      reply = {
        id: crypto.randomUUID(),
        label: "",
        text: result.text,
        createdAt: new Date().toISOString(),
        from: "agent",
      };
    } catch (caught) {
      reply = {
        id: crypto.randomUUID(),
        label: "Agent unavailable",
        text: caught instanceof Error ? caught.message : "The personal agent did not answer.",
        createdAt: new Date().toISOString(),
        from: "agent",
        failed: true,
      };
    } finally {
      setAgentThinking(false);
    }
    rememberAgent([...withMine, reply]);
  }

  async function callModerator(trigger: "manual" | "message") {
    if (trigger === "manual") setModeratorBusy(true);
    try {
      await askModerator({ code: group.code, trigger, meeting: meetingRef });
      if (trigger === "manual") setNotice("");
    } catch (caught) {
      if (trigger === "manual") {
        setNotice(caught instanceof Error ? caught.message : "The moderator did not answer.");
      }
    } finally {
      if (trigger === "manual") setModeratorBusy(false);
    }
  }

  function dropZone(target: Target) {
    return {
      onDragOver: (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        if (over !== target) setOver(target);
      },
      onDragLeave: (event: DragEvent) => {
        const next = event.relatedTarget as Node | null;
        if (next && (event.currentTarget as Node).contains(next)) return;
        setOver((current) => (current === target ? null : current));
      },
      onDrop: (event: DragEvent) => acceptDrop(event, target),
    };
  }

  function acceptDrop(event: DragEvent, target: Target) {
    event.preventDefault();
    event.stopPropagation();
    const payload = readDrop(event);
    setOver(null);
    setDragging(null);
    carried = null;
    if (!payload) return;
    if (target === "log") {
      void recordDecision(payload.text);
      return;
    }
    const quote = { author: payload.author, text: payload.text };
    if (target === "team") setTeamQuote(quote);
    else setAgentQuote(quote);
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

  const now = new Date();
  const timeline = buildTimeline(teamMessages, meetings, now);
  const dragProps = {
    onDragState: (from: Source | null) => {
      setDragging(from);
      if (!from) setOver(null);
    },
  };
  const status = connectError || notice;

  return (
    <main className={dragging ? "screen room-screen is-dragging" : "screen room-screen"}>
      <header className="app-header room-header">
        <div className="header-title">
          <button className="icon-btn" type="button" onClick={onBack} aria-label="Back to group">
            ←
          </button>
          <Logo />
          <span className="divider" aria-hidden="true" />
          <h1>{group.title}</h1>
          <button
            className="code-chip"
            type="button"
            onClick={copyCode}
            title="Copy invitation code"
          >
            {copied ? "Copied" : group.code.toUpperCase()}
          </button>
        </div>
        <span className="me">
          <Avatar name={profile.name} />
          {profile.name}
        </span>
      </header>
      {status ? <p className="status-bar">{status}</p> : null}
      <div className={logOpen ? "workspace" : "workspace log-closed"}>
        <section className="chat-panel team-panel">
          <header className="panel-head">
            <div>
              <h2>Team conversation</h2>
              <p>One ongoing chat across every meeting</p>
            </div>
            <div className="head-actions">
              <People people={people} />
              <button
                className="btn small moderator-btn"
                type="button"
                onClick={() => void callModerator("manual")}
                disabled={!ready || moderatorBusy}
                title="Ask the moderator agent to post in the team chat"
              >
                <span className="mod-mark" aria-hidden="true">
                  ◆
                </span>
                {moderatorBusy ? "Thinking..." : "Ask moderator"}
              </button>
            </div>
          </header>
          <div className="thread">
            {timeline.length === 0 ? (
              <p className="empty">Say hello to the team.</p>
            ) : (
              timeline.map((item) =>
                item.kind === "meeting" ? (
                  <div
                    key={`m-${item.meeting.id}`}
                    className={
                      current?.id === item.meeting.id ? "meeting-divider on" : "meeting-divider"
                    }
                  >
                    <span>
                      {item.meeting.title} · {formatMeetingTime(item.meeting.startsAt)}
                    </span>
                  </div>
                ) : (
                  <Bubble
                    key={item.message.id}
                    from="team"
                    mine={item.message.mine}
                    author={item.message.author}
                    text={item.message.text}
                    quote={item.message.quote}
                    forwarded={item.message.forwarded}
                    moderator={item.message.moderator}
                    {...dragProps}
                  />
                ),
              )
            )}
            <div ref={teamEnd} />
          </div>
          {session ? (
            <LiveChannel
              session={session}
              groupId={group.id}
              profile={profile}
              onChannel={(channel) => {
                channelRef.current = channel;
                setReady(true);
                void sharePending();
              }}
              onWire={(chat, liveDecisions, liveMeetings) => {
                setLiveChat(chat);
                if (liveMeetings.length) {
                  setMeetings((current) => {
                    const merged = sortMeetings(mergeById(current, liveMeetings));
                    saveMeetings(group.id, merged);
                    return merged;
                  });
                }
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
          <Composer
            tone="team"
            active={dragging !== null && dragging !== "team"}
            over={over === "team"}
            zone={dropZone("team")}
            quote={teamQuote}
            onClearQuote={() => setTeamQuote(null)}
            value={teamDraft}
            onChange={setTeamDraft}
            onSubmit={sendTeam}
            placeholder={ready ? `Message the team as ${profile.name}...` : "Connecting..."}
            canSend={ready && (teamDraft.trim().length > 0 || teamQuote !== null)}
            dropLabel="Drop to share with the team"
          />
        </section>

        <CurrentLog
          meeting={current}
          decisions={decisions.filter((item) => current && item.meetingId === current.id)}
          open={logOpen}
          onToggle={toggleLog}
          onRecord={(text) => void recordDecision(text)}
          onSchedule={(title, startsAt) => void scheduleMeeting(title, startsAt)}
          onOpenGroup={onBack}
          zone={dropZone("log")}
          over={over === "log"}
          dragging={dragging !== null}
          flash={flash}
        />

        <section className="chat-panel agent-panel">
          <header className="panel-head agent-head">
            <div className="agent-title">
              <span className="agent-mark" aria-hidden="true">
                ◇
              </span>
              <div>
                <h2>Personal agent</h2>
                <p>Only you can see this</p>
              </div>
            </div>
          </header>
          <div className="thread">
            {agentMessages.map((message) =>
              message.from === "agent" ? (
                <Bubble
                  key={message.id}
                  from="agent"
                  author="Agent"
                  label={message.label}
                  text={message.text}
                  failed={message.failed}
                  {...dragProps}
                />
              ) : (
                <Bubble
                  key={message.id}
                  from="user"
                  mine
                  author={profile.name}
                  text={message.text}
                  quote={message.quote}
                  {...dragProps}
                />
              ),
            )}
            {agentThinking ? (
              <div className="typing" aria-label="Personal agent is thinking">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            <div ref={agentEnd} />
          </div>
          <Composer
            tone="agent"
            active={dragging !== null && dragging !== "agent" && dragging !== "user"}
            over={over === "agent"}
            zone={dropZone("agent")}
            quote={agentQuote}
            onClearQuote={() => setAgentQuote(null)}
            value={agentDraft}
            onChange={setAgentDraft}
            onSubmit={sendAgent}
            placeholder="Ask your personal agent..."
            canSend={agentDraft.trim().length > 0 || agentQuote !== null}
            dropLabel="Drop to bring to your agent"
          />
        </section>
      </div>
    </main>
  );
}

function Composer({
  tone,
  active,
  over,
  zone,
  quote,
  onClearQuote,
  value,
  onChange,
  onSubmit,
  placeholder,
  canSend,
  dropLabel,
}: {
  tone: "team" | "agent";
  active: boolean;
  over: boolean;
  zone: {
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  quote: Quote | null;
  onClearQuote: () => void;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  placeholder: string;
  canSend: boolean;
  dropLabel: string;
}) {
  const className = [
    "composer",
    `${tone}-composer`,
    active ? "active" : "",
    over ? "over" : "",
  ].join(" ");
  return (
    <form className={className} onSubmit={onSubmit} {...zone}>
      {quote ? (
        <div className="quote-card attached">
          <div>
            <p className="quote-author">↪ {quote.author}</p>
            <p className="quote-text">{quote.text}</p>
          </div>
          <button
            className="icon-btn small"
            type="button"
            onClick={onClearQuote}
            aria-label="Remove attached message"
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="composer-row">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={quote ? "Add a note (optional)" : placeholder}
          aria-label={placeholder}
        />
        <button className="btn primary small" type="submit" disabled={!canSend}>
          Send
        </button>
      </div>
      <div className="drop-overlay" aria-hidden="true">
        <span>{dropLabel}</span>
      </div>
    </form>
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
  onWire: (chat: TeamMessage[], decisions: Decision[], meetings: Meeting[]) => void;
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
  onWire: (chat: TeamMessage[], decisions: Decision[], meetings: Meeting[]) => void,
) {
  const messages = (channel.messagePaginator.items ?? []) as unknown as WireMessage[];
  const chat: TeamMessage[] = [];
  const decisions: Decision[] = [];
  const meetings: Meeting[] = [];
  for (const message of messages) {
    const text = message.text?.trim() ?? "";
    if (!text || !message.id) continue;
    const author = message.user?.name || profile.name;
    const createdAt = toIso(message.created_at);
    const custom = message.custom;
    if (custom?.kind === "meeting" && custom.meeting?.id && custom.meeting.startsAt) {
      meetings.push({ ...custom.meeting, groupId });
    } else if (custom?.kind === "decision") {
      decisions.push({
        id: message.id,
        groupId,
        ...(custom.meetingId ? { meetingId: custom.meetingId } : {}),
        text,
        author,
        createdAt,
      });
    } else {
      const quote = message.custom?.quote;
      chat.push({
        id: message.id,
        text,
        author,
        createdAt,
        mine: message.user?.id === userId,
        ...(message.custom?.kind === "moderator" || message.user?.id === MODERATOR_ID
          ? { moderator: true }
          : {}),
        ...(quote?.text ? { quote, forwarded: Boolean(message.custom?.forwarded) } : {}),
      });
    }
  }
  onWire(chat, decisions, meetings);
}

function Bubble({
  from,
  mine = false,
  author,
  label,
  text,
  quote,
  forwarded = false,
  moderator = false,
  failed = false,
  onDragState,
}: {
  from: Source;
  moderator?: boolean;
  failed?: boolean;
  mine?: boolean;
  author: string;
  label?: string;
  text: string;
  quote?: Quote;
  forwarded?: boolean;
  onDragState: (from: Source | null) => void;
}) {
  const shownText = forwarded ? "" : text;
  const dragText = shownText || quote?.text || text;

  function dragStart(event: DragEvent) {
    carried = { from, author, text: dragText };
    event.dataTransfer.setData("application/x-crosscheck", JSON.stringify(carried));
    event.dataTransfer.setData("text/plain", dragText);
    event.dataTransfer.effectAllowed = "copy";
    setDragGhost(event, author, dragText, from);
    onDragState(from);
  }

  const className = [
    "bubble-row",
    from,
    mine ? "mine" : "",
    moderator ? "moderator" : "",
    failed ? "failed" : "",
  ].join(" ");

  return (
    <article
      className={className}
      draggable
      onDragStart={dragStart}
      onDragEnd={() => {
        onDragState(null);
        setTimeout(() => {
          carried = null;
        }, 0);
      }}
    >
      {from === "team" && !mine ? (
        moderator ? (
          <span className="avatar mod-avatar" aria-hidden="true">
            ◆
          </span>
        ) : (
          <Avatar name={author} />
        )
      ) : null}
      <div className="bubble-col">
        {from === "team" && !mine ? (
          <p className="bubble-author">
            {author}
            {moderator ? <em className="ai-tag">AI</em> : null}
          </p>
        ) : null}
        <div className="bubble">
          <span className="grip" aria-hidden="true">
            ⋮⋮
          </span>
          {label ? <p className="bubble-label">{label}</p> : null}
          {quote ? (
            <div className="quote-card">
              <div>
                <p className="quote-author">↪ {quote.author}</p>
                <p className="quote-text">{quote.text}</p>
              </div>
            </div>
          ) : null}
          {shownText ? <p className="bubble-text">{shownText}</p> : null}
        </div>
      </div>
    </article>
  );
}

function setDragGhost(event: DragEvent, author: string, text: string, from: Source) {
  const ghost = document.createElement("div");
  ghost.className = `drag-ghost ${from}`;
  const head = document.createElement("div");
  head.className = "drag-ghost-head";
  head.textContent = author;
  const body = document.createElement("div");
  body.className = "drag-ghost-body";
  body.textContent = text.length > 140 ? `${text.slice(0, 137)}...` : text;
  ghost.append(head, body);
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 24, 20);
  setTimeout(() => ghost.remove(), 0);
}

function People({ people }: { people: string[] }) {
  const shown = people.slice(0, 4);
  const count = people.length;
  return (
    <div className="people" title={people.join(", ")}>
      <div className="avatar-stack">
        {shown.map((name) => (
          <Avatar key={name} name={name} size="sm" />
        ))}
      </div>
      <span>{count}</span>
    </div>
  );
}

function readDrop(event: DragEvent): Carried | null {
  if (carried?.text) return carried;
  const raw = event.dataTransfer.getData("application/x-crosscheck");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Carried>;
      if (parsed.text?.trim()) {
        return { from: parsed.from ?? "", author: parsed.author ?? "", text: parsed.text.trim() };
      }
    } catch {
      // Fall through to plain text from another app.
    }
  }
  const text = event.dataTransfer.getData("text/plain").trim();
  return text ? { from: "", author: "Pasted text", text } : null;
}

type TimelineItem =
  | { kind: "message"; at: string; message: TeamMessage }
  | { kind: "meeting"; at: string; meeting: Meeting };

/** The team chat is one long thread; meetings that have started appear as dividers in it. */
function buildTimeline(messages: TeamMessage[], meetings: Meeting[], now: Date): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((message) => ({ kind: "message" as const, at: message.createdAt, message })),
    ...meetings
      .filter((meeting) => new Date(meeting.startsAt) <= now)
      .map((meeting) => ({ kind: "meeting" as const, at: meeting.startsAt, meeting })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === "meeting" ? -1 : 1));
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, { ...map.get(item.id), ...item });
  return [...map.values()];
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
