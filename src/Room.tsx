// The meeting room: team chat (with the Moderator), the current meeting's decision log,
// and this member's private window with their Personal Agent.
//
// The agents run on the server (agents/meeting.ts, served by server/rooms.ts). This page polls
// the signed-in member's own view of the room.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { TEAM_QUESTION_NOTICE, type GroupMessage } from "../agents/protocol";
import { api, Logo, type RoomView } from "./api";
import {
  Bubble,
  Composer,
  People,
  clearCarried,
  joinDraft,
  pasteToDraft,
  readDrop,
  useAttachments,
  type Quote,
  type Source,
} from "./chatParts";
import { AgentIcon } from "./icons";
import CurrentLog, { AgreementBox, ModeratorMenu } from "./Meetings";
import { currentMeeting, formatMeetingTime, type GroupDetail, type Meeting } from "./model";
import PrivateWindow, { type AgentReference } from "./PrivateWindow";
import { Avatar } from "./ui";
import { useRoom } from "./useRoom";
import { TableBelowChat } from "./AgentsTable";

type Target = "team" | "agent" | "log";

/** Closed by default; the "Decision log" button in the team chat header opens it. */
const LOG_OPEN_KEY = "crosscheck.logOpen.v2";
const GROUP_POLL_MS = 20_000;

export default function Room({ code, me, onBack }: { code: string; me: string; onBack: () => void }) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [teamDraft, setTeamDraft] = useState("");
  const [teamQuote, setTeamQuote] = useState<Quote | null>(null);
  const teamFiles = useAttachments();
  const [sendingTeam, setSendingTeam] = useState(false);
  const [agentReference, setAgentReference] = useState<AgentReference | null>(null);
  const [exploring, setExploring] = useState<string | null>(null);
  const [over, setOver] = useState<Target | null>(null);
  const [dragging, setDragging] = useState<Source | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [logOpen, setLogOpen] = useState(() => {
    try {
      return localStorage.getItem(LOG_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [flash, setFlash] = useState(false);
  const teamEnd = useRef<HTMLDivElement | null>(null);

  const loadGroup = useCallback(async () => {
    try {
      setDetail(await api.group(code));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not load the group.");
    }
  }, [code]);

  useEffect(() => {
    void loadGroup();
    const timer = setInterval(() => void loadGroup(), GROUP_POLL_MS);
    return () => clearInterval(timer);
  }, [loadGroup]);

  const meetings = detail?.meetings ?? [];
  const current = currentMeeting(meetings);
  // Wait for the schedule, so the member enters the room of the right meeting.
  const room = useRoom(code, current?.id ?? null, detail !== null);
  const view = room.view;
  const lines: GroupMessage[] = useMemo(() => view?.group ?? [], [view]);
  const people = view?.participants ?? [me];
  const log = view?.log ?? [];

  useEffect(() => {
    teamEnd.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  // A new agreed decision: flash the collapsed panel so it is not missed.
  const logCount = useRef(0);
  useEffect(() => {
    if (log.length > logCount.current && logCount.current > 0 && !logOpen) {
      setFlash(true);
      setTimeout(() => setFlash(false), 900);
    }
    logCount.current = log.length;
  }, [log.length, logOpen]);

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

  async function sendTeam(event: FormEvent) {
    event.preventDefault();
    const text = teamDraft.trim();
    const quote = teamQuote;
    const files = teamFiles.items;
    if ((!text && !quote && files.length === 0) || sendingTeam || teamFiles.uploading > 0) return;
    setSendingTeam(true);
    setTeamDraft("");
    setTeamQuote(null);
    teamFiles.clear();
    try {
      await room.act("group", {
        text,
        ...(quote ? { quote } : {}),
        ...(files.length ? { attachments: files.map((file) => file.id) } : {}),
      });
      setNotice("");
    } catch (caught) {
      setTeamDraft(text);
      setTeamQuote(quote);
      teamFiles.set(files);
      setNotice(caught instanceof Error ? caught.message : "Could not send that message.");
    } finally {
      setSendingTeam(false);
    }
  }

  /** A dropped message becomes a proposal; the Moderator opens an agreement check on it. */
  async function propose(text: string) {
    try {
      await room.act("propose", { text });
      setNotice("");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not propose that.");
    }
  }

  /** The Moderator offered an angle to everyone; think about it privately with the agent. */
  async function explore(line: GroupMessage) {
    setExploring(line.id);
    try {
      await room.act("private", {
        text: "Help me think about this angle.",
        groupMessageId: line.id,
        intent: "invite_brainstorm",
      });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Your agent could not answer just now.");
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
      void propose(payload.text);
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
      await navigator.clipboard.writeText(code.toUpperCase());
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
          <h1>{detail?.group.title ?? ""}</h1>
          <button className="code-chip" type="button" onClick={copyCode} title="Copy invitation code">
            {copied ? "Copied" : code.toUpperCase()}
          </button>
        </div>
        <span className="me">
          <Avatar name={me} />
          {me}
          {view?.isHost ? <em className="host-tag">Host</em> : null}
        </span>
      </header>
      {status ? <p className="status-bar">{status}</p> : null}
      {view?.llm.mode === "unconfigured" ? (
        <p className="status-bar warn">Agents are off: the server has no OPENROUTER_API_KEY.</p>
      ) : null}
      <div className={logOpen ? "workspace" : "workspace log-closed"}>
        <section className="chat-panel team-panel">
          <header className="panel-head">
            <div>
              <h2>Team conversation</h2>
              <p>{current ? `${current.title} · ` : ""}Moderator is listening</p>
            </div>
            <div className="team-head-actions">
              <People people={people} />
              <button
                className={[
                  "log-toggle",
                  logOpen ? "on" : "",
                  flash ? "flash" : "",
                  !logOpen && dragging !== null ? "drop-ready" : "",
                  !logOpen && over === "log" ? "over" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                type="button"
                onClick={toggleLog}
                aria-expanded={logOpen}
                title={logOpen ? "Hide the decision log" : "Show the decision log (drop a message here to propose it)"}
                {...(!logOpen ? dropZone("log") : {})}
              >
                <span className="log-toggle-icon" aria-hidden="true">
                  ✓
                </span>
                Decision log
                <span className="count">{log.length}</span>
                {view?.agreement?.status === "collecting" ? (
                  <span className="log-toggle-live" aria-label="An agreement check is open" />
                ) : null}
              </button>
            </div>
          </header>
          <div
            className={[
              "panel-stream",
              dragging !== null && dragging !== "team" ? "drop-target" : "",
              over === "team" ? "over" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            tabIndex={-1}
            {...dropZone("team")}
            onClick={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest("textarea, input, button, a, .quote-card")) return;
              event.currentTarget.focus({ preventScroll: true });
            }}
            onPaste={(event) => pasteToDraft(event, (text) => setTeamDraft((current) => joinDraft(current, text)))}
          >
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
                      agreement={view?.agreement ?? null}
                      discussing={view?.discussing ?? null}
                      isHost={Boolean(view?.isHost)}
                      act={room.act}
                      mine={item.line.kind === "user" && !item.line.anonymous && item.line.author === me}
                      exploring={exploring === item.line.id}
                      onExplore={() => void explore(item.line)}
                      onDragState={onDragState}
                    />
                  ),
                )
              )}
              <TableBelowChat table={view?.table ?? []} act={room.act} />
              <div ref={teamEnd} />
            </div>
            <Composer
              tone="team"
              active={dragging !== null && dragging !== "team"}
              over={over === "team"}
              quote={teamQuote}
              onClearQuote={() => setTeamQuote(null)}
              value={teamDraft}
              onChange={setTeamDraft}
              onSubmit={sendTeam}
              placeholder={view ? `Message the team as ${me}...` : "Connecting..."}
              canSend={
                Boolean(view) &&
                teamFiles.uploading === 0 &&
                (teamDraft.trim().length > 0 || teamQuote !== null || teamFiles.items.length > 0)
              }
              busy={sendingTeam}
              dropLabel="Drop to reply to it"
              files={teamFiles}
              leading={<ModeratorMenu act={room.act} checking={view?.agreement?.status === "collecting"} />}
            />
          </div>
        </section>

        <CurrentLog
          meeting={current}
          decisions={log}
          open={logOpen}
          onToggle={toggleLog}
          onEdit={async (id, text) => {
            await api.editDecision(code, id, text);
            await room.refresh();
          }}
          onSchedule={async (title, startsAt) => {
            await api.scheduleMeeting(code, title, startsAt);
            await loadGroup();
          }}
          onOpenGroup={onBack}
          zone={dropZone("log")}
          over={over === "log"}
          dragging={dragging !== null}
          flash={flash}
          agreement={view?.agreement ?? null}
          discussing={view?.discussing ?? null}
          isHost={Boolean(view?.isHost)}
          act={room.act}
        />

        <PrivateWindow
          me={me}
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

const NOTE_LABEL: Record<string, string> = {
  agreed: "Decision agreed",
  agreement_count: "Not agreed yet",
  check_opened: "Agreement check",
  check_closed: "Check closed",
  no_proposal: "Nothing to check yet",
  reopen_prompt: "Revisit a decision?",
};

function TeamLine({
  line,
  agreement,
  discussing,
  isHost,
  act,
  mine,
  exploring,
  onExplore,
  onDragState,
}: {
  line: GroupMessage;
  agreement: RoomView["agreement"];
  discussing: RoomView["discussing"];
  isHost: boolean;
  act: (action: string, body: object) => Promise<void>;
  mine: boolean;
  exploring: boolean;
  onExplore: () => void;
  onDragState: (from: Source | null) => void;
}) {
  const note = line.note;
  // Rooms that were already open can still contain the original automatic notice.
  const legacyRelay = note?.type === "angle_requested" && line.quote &&
    line.text === "I passed this question to everyone’s Personal Agent.";
  // The Moderator's "Agreement check" message carries the live status of that check, as in the decision log.
  const liveCheck =
    note?.type === "check_opened" && agreement && agreement.version === note.version && agreement.status !== "cancelled";
  const footer =
    note?.type === "angle_prompt" ? (
      <button className="bubble-action" type="button" onClick={onExplore} disabled={exploring}>
        {exploring ? (
          "Asking your agent..."
        ) : (
          <>
            <AgentIcon size={13} className="inline-icon" /> Think about it privately
          </>
        )}
      </button>
    ) : liveCheck ? (
      <AgreementBox agreement={agreement} isHost={isHost} act={act} inline />
    ) : note?.type === "reopen_prompt" &&
      discussing?.status === "asking" &&
      discussing.recordId === note.recordId ? (
      <RevisitButtons recordId={note.recordId} act={act} />
    ) : null;
  const label = note
    ? note.type === "angle_prompt"
      ? `Missing angle · ${note.angle}`
      : note.type === "reopen_result"
        ? note.reopened
          ? "Revisiting a decision"
          : "Decision kept"
        : NOTE_LABEL[note.type]
    : undefined;
  return (
    <Bubble
      from="team"
      mine={mine}
      author={line.author}
      label={label}
      text={legacyRelay ? TEAM_QUESTION_NOTICE : line.text}
      quote={line.quote}
      variant={line.kind === "moderator" ? "moderator" : line.anonymous ? "anonymous" : undefined}
      messageId={line.id}
      attachments={line.attachments}
      footer={footer}
      onDragState={onDragState}
    />
  );
}

/** Answers to the Moderator's "revisit this agreed decision?" question. Any member can answer. */
function RevisitButtons({ recordId, act }: { recordId: string; act: (action: string, body: object) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function answer(reopen: boolean) {
    setBusy(true);
    setError("");
    try {
      await act("reopen", { recordId, reopen });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="revisit-actions">
      <button className="btn primary small" type="button" disabled={busy} onClick={() => void answer(true)}>
        Yes, revisit it
      </button>
      <button className="btn secondary small" type="button" disabled={busy} onClick={() => void answer(false)}>
        No, keep it
      </button>
      {error ? <p className="error small-note">{error}</p> : null}
    </div>
  );
}

type TimelineItem =
  | { kind: "message"; at: number; line: GroupMessage }
  | { kind: "meeting"; at: number; meeting: Meeting };

/** The team chat is one long thread; meetings that have started appear as dividers in it. */
function buildTimeline(lines: GroupMessage[], meetings: Meeting[], now: Date): TimelineItem[] {
  const items: TimelineItem[] = [
    ...lines.map((line) => ({ kind: "message" as const, at: line.at, line })),
    ...meetings
      .filter((meeting) => new Date(meeting.startsAt) <= now)
      .map((meeting) => ({ kind: "meeting" as const, at: new Date(meeting.startsAt).getTime(), meeting })),
  ];
  return items.sort((a, b) => a.at - b.at || (a.kind === "meeting" ? -1 : 1));
}
