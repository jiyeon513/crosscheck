// The meeting room: team chat (with the Moderator), the current meeting's decision log,
// and this person's private window with their Personal Agent.
//
// The agents run on the server (agents/meeting.ts, served by server/rooms.ts). This page polls
// its own view of the room. Stream keeps the schedule, manual decisions and the persistent chat copy.
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import type { Channel } from "stream-chat";
import { useCreateChatClient } from "stream-chat-react";
import type { ModeratorNote } from "../agents/protocol";
import { Logo, type JoinResult, type RoomGroupMessage, joinGroup } from "./api";
import {
  Bubble,
  Composer,
  People,
  clearCarried,
  readDrop,
  type Quote,
  type Source,
} from "./chatParts";
import CurrentLog from "./Meetings";
import {
  currentMeeting,
  decisionsFor,
  demoMessagesFor,
  formatMeetingTime,
  markOpened,
  meetingsFor,
  saveDecisions,
  saveMeetings,
  sortMeetings,
  type Decision,
  type Group,
  type Meeting,
  type Profile,
} from "./model";
import PrivateWindow, { type AgentReference } from "./PrivateWindow";
import { Avatar } from "./ui";
import { useRoom } from "./useRoom";

type Target = "team" | "agent" | "log";

const LOG_OPEN_KEY = "crosscheck.logOpen";

/** A team chat line as this page draws it. */
type ChatLine = {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  mine: boolean;
  kind: "user" | "moderator";
  anonymous?: boolean;
  note?: ModeratorNote;
  quote?: Quote;
  forwarded?: boolean;
};

type WireMessage = {
  id?: string;
  text?: string;
  created_at?: unknown;
  user?: { id?: string; name?: string } | null;
  custom?: { kind?: string; meetingId?: string; meeting?: Meeting } | null;
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
  const [decisions, setDecisions] = useState<Decision[]>(() => decisionsFor(group.id));
  const [meetings, setMeetings] = useState<Meeting[]>(() => meetingsFor(group.id));
  const [teamDraft, setTeamDraft] = useState("");
  const [teamQuote, setTeamQuote] = useState<Quote | null>(null);
  const [sendingTeam, setSendingTeam] = useState(false);
  const [agentReference, setAgentReference] = useState<AgentReference | null>(null);
  const [exploring, setExploring] = useState<string | null>(null);
  const [over, setOver] = useState<Target | null>(null);
  const [dragging, setDragging] = useState<Source | null>(null);
  const [notice, setNotice] = useState("");
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

  const current = currentMeeting(meetings);
  const demo = useMemo(() => demoMessagesFor(group.id), [group.id]);
  const room = useRoom({
    code: group.code,
    user: profile.name,
    groupTitle: group.title,
    meeting: current,
    history: demo,
  });
  const view = room.view;

  useEffect(() => {
    markOpened(group.id);
  }, [group.id]);

  // Stream: membership in the group channel, for the schedule and decision records.
  useEffect(() => {
    let cancelled = false;
    joinGroup({ name: profile.name, code: group.code, title: group.title })
      .then((result) => {
        if (!cancelled) setSession(result);
      })
      .catch((caught: unknown) => {
        // The meeting room works without Stream; it just is not kept after a server restart.
        console.warn("Stream unavailable:", caught);
      });
    return () => {
      cancelled = true;
    };
  }, [group.code, group.title, profile.name]);

  // Decisions the team agreed on through the moderator's check join this meeting's decision log.
  useEffect(() => {
    if (!view || !current || view.decisions.length === 0) return;
    const incoming: Decision[] = view.decisions.map((record) => ({
      id: record.streamId,
      groupId: group.id,
      meetingId: current.id,
      text: record.statement,
      author: "Agreed by everyone",
      createdAt: new Date(record.at).toISOString(),
    }));
    setDecisions((existing) => {
      if (incoming.every((item) => existing.some((known) => known.id === item.id))) return existing;
      const merged = mergeById(existing, incoming).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      saveDecisions(group.id, merged);
      return merged;
    });
  }, [view, current, group.id]);

  const lines: ChatLine[] = useMemo(() => {
    if (!view) {
      return demo.map((message) => ({ ...message, mine: message.author === profile.name, kind: "user" as const }));
    }
    return view.group.map((message: RoomGroupMessage) => ({
      id: message.id,
      author: message.author,
      text: message.text,
      createdAt: new Date(message.at).toISOString(),
      mine: message.kind === "user" && !message.anonymous && message.author === profile.name,
      kind: message.kind,
      anonymous: message.anonymous,
      note: message.note,
      quote: message.quote,
      forwarded: message.forwarded,
    }));
  }, [view, demo, profile.name]);
  const people = view?.participants ?? [profile.name];

  useEffect(() => {
    teamEnd.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

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

  /** A decision written or dropped into the log by hand. */
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
    try {
      await channel.sendMessage({
        message: {
          id: meeting.id,
          text: `Scheduled ${meeting.title} · ${formatMeetingTime(meeting.startsAt)}`,
          custom: { kind: "meeting", meeting: shared },
        },
      });
      return true;
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Saved on this device only.");
      return false;
    }
  }

  /** Meetings scheduled from the group page are announced once Stream is connected. */
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
    if ((!text && !quote) || sendingTeam) return;
    setSendingTeam(true);
    setTeamDraft("");
    setTeamQuote(null);
    try {
      await room.act("group", { text, ...(quote ? { quote } : {}) });
      setNotice("");
    } catch (caught) {
      setTeamDraft(text);
      setTeamQuote(quote);
      setNotice(caught instanceof Error ? caught.message : "Could not send that message.");
    } finally {
      setSendingTeam(false);
    }
  }

  /** The moderator offered an angle to everyone; think about it privately with the agent. */
  async function explore(line: ChatLine) {
    setExploring(line.id);
    try {
      await room.act("private", {
        text: "Help me think about this angle.",
        groupMessageId: line.id,
        intent: "invite_brainstorm",
      });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "The personal agent did not answer.");
    } finally {
      setExploring(null);
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
        setOver((value) => (value === target ? null : value));
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
    clearCarried();
    if (!payload) return;
    if (target === "log") {
      void recordDecision(payload.text);
      return;
    }
    if (target === "team") {
      setTeamQuote({ author: payload.author, text: payload.text });
      return;
    }
    setAgentReference(
      payload.from === "team" && payload.messageId
        ? { kind: "group", id: payload.messageId, author: payload.author, text: payload.text }
        : { kind: "text", author: payload.author, text: payload.text },
    );
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

  const timeline = buildTimeline(lines, meetings, new Date());
  const onDragState = (from: Source | null) => {
    setDragging(from);
    if (!from) setOver(null);
  };
  const status = room.error || notice;

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
          <button className="code-chip" type="button" onClick={copyCode} title="Copy invitation code">
            {copied ? "Copied" : group.code.toUpperCase()}
          </button>
        </div>
        <span className="me">
          <Avatar name={profile.name} />
          {profile.name}
          {view?.isHost ? <em className="host-tag">Host</em> : null}
        </span>
      </header>
      {status ? <p className="status-bar">{status}</p> : null}
      {view?.llm.mode === "unconfigured" ? (
        <p className="status-bar warn">
          Agents are off: set OPENROUTER_API_KEY in the server&apos;s .env and restart it.
        </p>
      ) : null}
      <div className={logOpen ? "workspace" : "workspace log-closed"}>
        <section className="chat-panel team-panel">
          <header className="panel-head">
            <div>
              <h2>Team conversation</h2>
              <p>
                {current ? `${current.title} · ` : ""}
                Moderator is listening
              </p>
            </div>
            <People people={people} />
          </header>
          <div className="thread">
            {timeline.length === 0 ? (
              <p className="empty">Say hello to the team.</p>
            ) : (
              timeline.map((item) =>
                item.kind === "meeting" ? (
                  <div
                    key={`m-${item.meeting.id}`}
                    className={current?.id === item.meeting.id ? "meeting-divider on" : "meeting-divider"}
                  >
                    <span>
                      {item.meeting.title} · {formatMeetingTime(item.meeting.startsAt)}
                    </span>
                  </div>
                ) : (
                  <TeamLine
                    key={item.line.id}
                    line={item.line}
                    exploring={exploring === item.line.id}
                    onExplore={() => void explore(item.line)}
                    onDragState={onDragState}
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
              onChannel={(channel) => {
                channelRef.current = channel;
                void sharePending();
              }}
              onWire={(liveDecisions, liveMeetings) => {
                if (liveMeetings.length) {
                  setMeetings((existing) => {
                    const merged = sortMeetings(mergeById(existing, liveMeetings));
                    saveMeetings(group.id, merged);
                    return merged;
                  });
                }
                if (liveDecisions.length) {
                  setDecisions((existing) => {
                    const merged = mergeById(existing, liveDecisions).sort((a, b) =>
                      a.createdAt.localeCompare(b.createdAt),
                    );
                    saveDecisions(group.id, merged);
                    return merged;
                  });
                }
              }}
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
            placeholder={view ? `Message the team as ${profile.name}...` : "Connecting..."}
            canSend={Boolean(view) && (teamDraft.trim().length > 0 || teamQuote !== null)}
            busy={sendingTeam}
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
          agreement={view?.agreement ?? null}
          isHost={Boolean(view?.isHost)}
          act={room.act}
        />

        <PrivateWindow
          me={profile.name}
          view={view}
          act={room.act}
          reference={agentReference}
          onReference={setAgentReference}
          zone={dropZone("agent")}
          active={dragging !== null && dragging !== "agent" && dragging !== "user"}
          over={over === "agent"}
          onDragState={onDragState}
        />
      </div>
    </main>
  );
}

function TeamLine({
  line,
  exploring,
  onExplore,
  onDragState,
}: {
  line: ChatLine;
  exploring: boolean;
  onExplore: () => void;
  onDragState: (from: Source | null) => void;
}) {
  const note = line.note;
  const footer =
    note?.type === "angle_prompt" ? (
      <button className="bubble-action" type="button" onClick={onExplore} disabled={exploring}>
        {exploring ? "Asking your agent..." : "◇ Think about it privately"}
      </button>
    ) : null;
  const label =
    note?.type === "agreed"
      ? "Decision agreed"
      : note?.type === "agreement_count"
        ? "Agreement check"
        : note?.type === "angle_prompt"
          ? `Missing angle · ${note.angle}`
          : undefined;
  return (
    <Bubble
      from="team"
      mine={line.mine}
      author={line.author}
      label={label}
      text={line.text}
      quote={line.quote}
      forwarded={line.forwarded}
      variant={line.kind === "moderator" ? "moderator" : line.anonymous ? "anonymous" : undefined}
      messageId={line.id}
      footer={footer}
      onDragState={onDragState}
    />
  );
}

/** Stream channel for the schedule and decision records (the chat itself comes from the room). */
function LiveChannel({
  session,
  groupId,
  onChannel,
  onWire,
}: {
  session: JoinResult;
  groupId: string;
  onChannel: (channel: Channel) => void;
  onWire: (decisions: Decision[], meetings: Meeting[]) => void;
}) {
  const client = useCreateChatClient({
    apiKey: session.apiKey,
    tokenOrProvider: session.token,
    userData: { id: session.userId, name: session.name },
  });
  const onWireRef = useRef(onWire);
  const onChannelRef = useRef(onChannel);
  onWireRef.current = onWire;
  onChannelRef.current = onChannel;

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const channel = client.channel("messaging", groupId);
    const sync = () => publish(channel, groupId, onWireRef.current);
    channel
      .watch()
      .then(() => {
        if (cancelled) return;
        onChannelRef.current(channel);
        sync();
        channel.on("message.new", sync);
        channel.on("message.updated", sync);
      })
      .catch((caught: unknown) => console.warn("Could not open the Stream channel:", caught));
    return () => {
      cancelled = true;
      channel.off("message.new", sync);
      channel.off("message.updated", sync);
    };
  }, [client, groupId]);

  return null;
}

function publish(channel: Channel, groupId: string, onWire: (decisions: Decision[], meetings: Meeting[]) => void) {
  const messages = (channel.messagePaginator.items ?? []) as unknown as WireMessage[];
  const decisions: Decision[] = [];
  const meetings: Meeting[] = [];
  for (const message of messages) {
    const text = message.text?.trim() ?? "";
    const custom = message.custom;
    if (!message.id || !text || !custom) continue;
    if (custom.kind === "meeting" && custom.meeting?.id && custom.meeting.startsAt) {
      meetings.push({ ...custom.meeting, groupId });
    } else if (custom.kind === "decision") {
      decisions.push({
        id: message.id,
        groupId,
        ...(custom.meetingId ? { meetingId: custom.meetingId } : {}),
        text,
        author: message.user?.name || "Team",
        createdAt: toIso(message.created_at),
      });
    }
  }
  onWire(decisions, meetings);
}

type TimelineItem =
  | { kind: "message"; at: string; line: ChatLine }
  | { kind: "meeting"; at: string; meeting: Meeting };

/** The team chat is one long thread; meetings that have started appear as dividers in it. */
function buildTimeline(lines: ChatLine[], meetings: Meeting[], now: Date): TimelineItem[] {
  const items: TimelineItem[] = [
    ...lines.map((line) => ({ kind: "message" as const, at: line.createdAt, line })),
    ...meetings
      .filter((meeting) => new Date(meeting.startsAt) <= now)
      .map((meeting) => ({ kind: "meeting" as const, at: meeting.startsAt, meeting })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === "meeting" ? -1 : 1));
}

function mergeById<T extends { id: string }>(existing: T[], incoming: T[]) {
  const map = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, { ...map.get(item.id), ...item });
  return [...map.values()];
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
