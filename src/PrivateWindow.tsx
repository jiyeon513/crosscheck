// The private window: this person's chat with their personal agent, and the cards the agent offers.
// Nothing here reaches the group unless the person presses Share / Raise themselves.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Card,
  ConcernCard,
  MemoryCard,
  MemoryItem,
  JointCard,
  PairCard,
  PollCard,
  PrivateItem,
  ShareSuggestionCard,
  Stance,
  UnderstandingCheckCard,
} from "../agents/protocol";
import type { RoomView } from "./api";
import { isUnsure } from "./model";
import type { Attachment } from "../agents/protocol";
import { Bubble, Composer, Typing, joinDraft, pasteToDraft, useAttachments, type Source, type Zone } from "./chatParts";
import { AgentIcon } from "./icons";

/** What the next private message refers to. */
export type AgentReference =
  | { kind: "group"; id: string; author: string; text: string }
  | { kind: "card"; id: string; author: string; text: string }
  | { kind: "text"; author: string; text: string };

type Act = (action: string, body: object) => Promise<void>;

/** Decisions from earlier meetings of this group, and the next meeting, shown at the top of the private window. */
export type CarriedOver = { earlier: { meeting: string; text: string }[]; next: { title: string; when: string } | null };
type Local = { id: string; type: "user" | "failed"; text: string; attachments?: Attachment[] };

export default function PrivateWindow({
  me,
  view,
  act,
  reference,
  onReference,
  zone,
  active,
  over,
  onDragState,
  carried,
}: {
  me: string;
  view: RoomView | null;
  act: Act;
  reference: AgentReference | null;
  onReference: (reference: AgentReference | null) => void;
  zone: Zone;
  active: boolean;
  over: boolean;
  onDragState: (from: Source | null) => void;
  carried?: CarriedOver;
}) {
  const [draft, setDraft] = useState("");
  const files = useAttachments();
  const [sending, setSending] = useState(false);
  const [local, setLocal] = useState<Local[]>([]);
  const end = useRef<HTMLDivElement | null>(null);
  const items = view?.private ?? [];
  // The member's own private notes, so a suggestion card can show which note it is based on.
  const notes = new Map(items.flatMap((item) => (item.type === "user" ? [[item.id, item.text] as const] : [])));
  const typing = sending || Boolean(view?.agentTyping);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length, local.length, typing]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const typed = draft.trim();
    const attached = files.items;
    if ((!typed && !reference && attached.length === 0) || sending || files.uploading > 0) return;
    setDraft("");
    files.clear();
    onReference(null);
    await deliver(
      { ...messageFor(typed, reference), ...(attached.length ? { attachments: attached.map((file) => file.id) } : {}) },
      typed,
      reference,
      attached,
    );
  }

  /** A starter prompt: sends a ready-made message to the agent. */
  function ask(text: string) {
    if (!sending) void deliver({ text }, text, null, []);
  }

  async function deliver(
    body: { text: string; attachments?: string[] },
    typed: string,
    sentReference: AgentReference | null,
    attached: Attachment[],
  ) {
    const pending: Local = { id: crypto.randomUUID(), type: "user", text: body.text, ...(attached.length ? { attachments: attached } : {}) };
    setLocal((current) => [...current.filter((item) => item.type !== "failed"), pending]);
    setSending(true);
    try {
      await act("private", body);
      setLocal((current) => current.filter((item) => item.id !== pending.id));
    } catch (caught) {
      setDraft(typed);
      files.set(attached);
      onReference(sentReference);
      setLocal((current) => [
        ...current.filter((item) => item.id !== pending.id),
        {
          id: crypto.randomUUID(),
          type: "failed",
          text: caught instanceof Error ? caught.message : "The personal agent did not answer.",
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="chat-panel agent-panel">
      <header className="panel-head agent-head">
        <div className="agent-title">
          <span className="agent-mark" aria-hidden="true">
            <AgentIcon size={18} />
          </span>
          <div>
            <h2>Personal agent</h2>
            <p>Only you can see this</p>
          </div>
        </div>
        <MemoryNotes items={view?.memory ?? []} act={act} />
      </header>
      <div
        className={["panel-stream", active ? "drop-target" : "", over ? "over" : ""].filter(Boolean).join(" ")}
        tabIndex={-1}
        {...zone}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("textarea, input, button, a, .quote-card")) return;
          event.currentTarget.focus({ preventScroll: true });
        }}
        onPaste={(event) => pasteToDraft(event, (text) => setDraft((current) => joinDraft(current, text)))}
      >
        <div className="thread">
          {carried && (carried.earlier.length > 0 || carried.next) ? (
            <aside className="carried">
              <p className="carried-title">{carried.earlier.length ? "Carried over from earlier meetings" : "Coming up"}</p>
              {carried.earlier.map((item, index) => (
                <p key={index}>
                  <strong>{item.meeting}:</strong> {item.text}
                </p>
              ))}
              {carried.next ? (
                <p className="carried-next">
                  Next up: {carried.next.title} · {carried.next.when}
                </p>
              ) : null}
            </aside>
          ) : null}
          {items.length === 0 && local.length === 0 ? (
            <div className="empty">
              <p>Think out loud here. Only you can see this.</p>
              <div className="start-prompts">
                <button className="start-prompt" type="button" disabled={sending} onClick={() => ask("Help me explore ideas for our meeting goal.")}>
                  Help me find a starting idea
                </button>
                <button className="start-prompt" type="button" onClick={() => setDraft("What matters to me here: ")}>
                  Tell my agent what matters to me
                </button>
                <button className="start-prompt" type="button" disabled={sending} onClick={() => ask("What is the group talking about right now?")}>
                  Explore what the group is thinking
                </button>
              </div>
            </div>
          ) : null}
          {items.map((item) => (
            <PrivateEntry
              key={item.id}
              item={item}
              notes={notes}
              me={me}
              act={act}
              onAsk={(card) => onReference(card)}
              onDragState={onDragState}
            />
          ))}
          {local.map((item) =>
            item.type === "user" ? (
              <Bubble
                key={item.id}
                from="user"
                mine
                author={me}
                text={item.text}
                attachments={item.attachments}
                onDragState={onDragState}
              />
            ) : (
              <Bubble
                key={item.id}
                from="agent"
                author="Agent"
                label="Agent unavailable"
                text={item.text}
                variant="failed"
                onDragState={onDragState}
              />
            ),
          )}
          {typing ? <Typing label="Personal agent is thinking" /> : null}
          <div ref={end} />
        </div>
        <Composer
          tone="agent"
          active={active}
          over={over}
          quote={reference ? { author: reference.author, text: reference.text } : null}
          quoteLabel={reference?.kind === "card" ? "About" : "↪"}
          onClearQuote={() => onReference(null)}
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          placeholder="Ask your personal agent..."
          quotePlaceholder="Ask about it (optional)"
          canSend={files.uploading === 0 && (draft.trim().length > 0 || reference !== null || files.items.length > 0)}
          files={files}
          busy={sending}
          dropLabel="Drop to ask your agent about it"
        />
      </div>
    </section>
  );
}

function messageFor(typed: string, reference: AgentReference | null) {
  if (!reference) return { text: typed };
  if (reference.kind === "group") {
    return { text: typed || "What do you make of this message?", groupMessageId: reference.id };
  }
  if (reference.kind === "card") return { text: typed || "Tell me more about this.", cardId: reference.id };
  const quoted = `"${reference.text}"`;
  return { text: typed ? `${quoted}\n\n${typed}` : `${quoted}\n\nWhat do you make of this?` };
}

function PrivateEntry({
  item,
  notes,
  me,
  act,
  onAsk,
  onDragState,
}: {
  item: PrivateItem;
  notes: Map<string, string>;
  me: string;
  act: Act;
  onAsk: (reference: AgentReference) => void;
  onDragState: (from: Source | null) => void;
}) {
  if (item.type !== "card") {
    return item.type === "user" ? (
      <Bubble from="user" mine author={me} text={item.text} attachments={item.attachments} onDragState={onDragState} />
    ) : (
      <Bubble from="agent" author="Your agent" text={item.text} onDragState={onDragState} />
    );
  }
  const { card } = item;
  const ask = (text: string) => onAsk({ kind: "card", id: card.id, author: cardTitle(card), text });
  switch (card.kind) {
    case "share_suggestion":
      return <ShareCard card={card} act={act} onAsk={ask} evidence={(card.evidenceIds ?? []).map((id) => notes.get(id)).find(Boolean)} />;
    case "understanding_check":
      return <CheckCard card={card} act={act} onAsk={ask} />;
    case "concern":
      return <ConcernCardView card={card} act={act} onAsk={ask} />;
    case "poll":
      return <PollCardView card={card} act={act} onAsk={ask} />;
    case "memory":
      return <MemoryCardView card={card} act={act} />;
    case "pair":
      return <PairCardView card={card} act={act} />;
    case "joint":
      return <JointCardView card={card} act={act} />;
  }
}

function cardTitle(card: Card) {
  if (card.kind === "share_suggestion") return "Suggestion";
  if (card.kind === "understanding_check") return "Agreement check";
  if (card.kind === "poll") return "Private question";
  if (card.kind === "memory") return "Note";
  if (card.kind === "pair") return "Combine ideas";
  if (card.kind === "joint") return "Joint draft";
  return "Concern";
}

/** Shared busy/error handling for card buttons. */
function useCardAction(act: Act) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: string, body: object) {
    setBusy(true);
    setError("");
    try {
      await act(action, body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const SOURCE_LABEL: Record<ShareSuggestionCard["source"], string> = {
  react: "Connects to what was just said",
  missing_angle: "An angle the team has not covered",
  chat: "Draft for the team",
  quiet: "A good moment to add your idea",
};

function ShareCard({ card, act, onAsk, evidence }: { card: ShareSuggestionCard; act: Act; onAsk: (text: string) => void; evidence?: string }) {
  const [text, setText] = useState(card.draft);
  const { busy, error, run } = useCardAction(act);
  const open = card.status === "open";
  return (
    <article className={`pcard share ${card.status}`}>
      <p className="pcard-kicker">{SOURCE_LABEL[card.source]}</p>
      <p className="pcard-nudge">{card.nudge}</p>
      {evidence ? (
        <p className="pcard-evidence">
          <strong>From your note</strong> {evidence}
        </p>
      ) : null}
      {open ? (
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label="Draft to share" />
      ) : (
        <p className="pcard-draft">{card.draft}</p>
      )}
      {open ? (
        <div className="pcard-actions">
          <button
            className="btn primary small"
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => run("share", { cardId: card.id, text, mode: "named" })}
          >
            Share
          </button>
          <button
            className="btn secondary small"
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => run("share", { cardId: card.id, text, mode: "anonymous" })}
          >
            Share anonymously
          </button>
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("dismiss", { cardId: card.id })}>
            Not now
          </button>
        </div>
      ) : (
        <p className="pcard-status">{statusLabel(card.status)}</p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
      <button className="pcard-ask" type="button" onClick={() => onAsk(card.nudge)}>
        Ask my agent about this
      </button>
    </article>
  );
}

function ConcernCardView({ card, act, onAsk }: { card: ConcernCard; act: Act; onAsk: (text: string) => void }) {
  const [text, setText] = useState(card.draft);
  const { busy, error, run } = useCardAction(act);
  const open = card.status === "open";
  return (
    <article className={`pcard concern ${card.status}`}>
      <p className="pcard-kicker">Concern · {card.label}</p>
      {open ? (
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label="Concern to raise" />
      ) : (
        <p className="pcard-draft">{card.draft}</p>
      )}
      {open ? (
        <div className="pcard-actions">
          <button
            className="btn primary small"
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => run("concern", { cardId: card.id, text, mode: "named" })}
          >
            Raise with my name
          </button>
          <button
            className="btn secondary small"
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => run("concern", { cardId: card.id, text, mode: "anonymous" })}
          >
            Raise anonymously
          </button>
          <button
            className="btn secondary small"
            type="button"
            disabled={busy || !text.trim()}
            title="The team sees only the short label above, never your words or your name"
            onClick={() => run("tell", { cardId: card.id, text })}
          >
            Tell the Moderator only
          </button>
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("dismiss", { cardId: card.id })}>
            Not now
          </button>
        </div>
      ) : (
        <p className="pcard-status">{statusLabel(card.status)}</p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
      <button className="pcard-ask" type="button" onClick={() => onAsk(card.label)}>
        Ask my agent about this
      </button>
    </article>
  );
}

function CheckCard({ card, act, onAsk }: { card: UnderstandingCheckCard; act: Act; onAsk: (text: string) => void }) {
  const [choice, setChoice] = useState(card.answer ?? "");
  const [own, setOwn] = useState("");
  const [editing, setEditing] = useState(card.status === "open");
  const { busy, error, run } = useCardAction(act);
  const closed = card.status === "closed";
  const label = choice === "__own__" ? own.trim() : choice;

  async function submit() {
    // Picking a reading means "I agree, as I read it"; "Not sure yet" does not count as agreeing.
    await run("check/answer", { checkId: card.checkId, label, approve: !isUnsure(label) });
    setEditing(false);
  }

  return (
    <article className={`pcard check ${card.status}`}>
      <p className="pcard-kicker">
        Agreement check{card.version > 1 ? ` · version ${card.version}` : ""}
      </p>
      <blockquote className="pcard-decision">{card.decision}</blockquote>
      <p className="pcard-question">{card.question}</p>
      {card.why ? (
        <p className="pcard-why">
          <AgentIcon size={13} className="inline-icon" />{" "}
          {card.why}
        </p>
      ) : null}

      {closed ? (
        <p className="pcard-status">
          {card.answer ? `You answered: ${card.answer}. ` : ""}This version is closed.
        </p>
      ) : editing ? (
        <>
          <div className="pcard-options" role="radiogroup" aria-label={card.question}>
            {card.options.map((option) => (
              <label key={option} className={choice === option ? "option on" : "option"}>
                <input type="radio" name={card.id} checked={choice === option} onChange={() => setChoice(option)} />
                <span>{option}</span>
                {card.suggested === option ? <em className="guess">agent's guess</em> : null}
              </label>
            ))}
            <label className={choice === "__own__" ? "option on" : "option"}>
              <input type="radio" name={card.id} checked={choice === "__own__"} onChange={() => setChoice("__own__")} />
              <input
                className="own"
                value={own}
                placeholder="In my own words"
                onFocus={() => setChoice("__own__")}
                onChange={(event) => setOwn(event.target.value)}
              />
            </label>
          </div>
          <div className="pcard-actions">
            <button className="btn primary small" type="button" disabled={busy || !label} onClick={submit}>
              {card.status === "answered" ? "Update answer" : "Send answer"}
            </button>
          </div>
          <p className="fine-left">Sent without your name. “Not sure yet” means not agreed.</p>
        </>
      ) : (
        <div className="pcard-answered">
          <p>
            You answered <strong>{card.answer}</strong>
          </p>
          <button className="btn ghost small" type="button" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      )}
      {closed ? (
        card.stance ? <p className="pcard-status">You shared your stance: {STANCE_LABEL[card.stance].toLowerCase()}.</p> : null
      ) : (
        <StanceRow card={card} act={act} />
      )}
      {error ? <p className="error small-note">{error}</p> : null}
      <button className="pcard-ask" type="button" onClick={() => onAsk(card.question)}>
        Talk it through with my agent
      </button>
    </article>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "shared":
      return "Shared with the team";
    case "raised_named":
      return "Raised with your name";
    case "raised_anonymous":
      return "Raised anonymously";
    case "told_moderator":
      return "Told the Moderator only. The team sees just the label.";
    case "dismissed":
      return "Dismissed";
    case "superseded":
      return "The proposal changed, so this is out of date";
    default:
      return status;
  }
}

function PollCardView({ card, act, onAsk }: { card: PollCard; act: Act; onAsk: (text: string) => void }) {
  const [text, setText] = useState(card.draft);
  const [touched, setTouched] = useState(false);
  const { busy, error, run } = useCardAction(act);
  const open = card.status === "open";
  // The agent's suggestion arrives a moment after the card; do not overwrite what the member typed.
  useEffect(() => {
    if (!touched) setText(card.draft);
  }, [card.draft, touched]);
  return (
    <article className={`pcard poll ${card.status}`}>
      <p className="pcard-kicker">{card.round > 1 ? "Follow-up from the Moderator" : "Private question from the Moderator"}</p>
      <p className="pcard-question">{card.question}</p>
      {open && card.why ? (
        <p className="pcard-why">
          <AgentIcon size={13} className="inline-icon" /> {card.why}
        </p>
      ) : null}
      {open ? (
        <>
          <textarea
            value={text}
            onChange={(event) => {
              setTouched(true);
              setText(event.target.value);
            }}
            rows={2}
            placeholder="Your answer"
            aria-label="Your private answer"
          />
          <div className="pcard-actions">
            <button
              className="btn primary small"
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => run("poll/answer", { pollId: card.pollId, text })}
            >
              Send to the Moderator only
            </button>
            <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("poll/answer", { pollId: card.pollId, skip: true })}>
              Skip
            </button>
          </div>
          <p className="fine-left">Sent without your name. The team sees only the combined result.</p>
        </>
      ) : (
        <p className="pcard-status">
          {card.status === "skipped"
            ? "You skipped this question."
            : card.answer
              ? `You answered privately: ${card.answer}`
              : "This question is closed."}
        </p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
      <button className="pcard-ask" type="button" onClick={() => onAsk(card.question)}>
        Talk it through with my agent
      </button>
    </article>
  );
}

function MemoryCardView({ card, act }: { card: MemoryCard; act: Act }) {
  const { busy, error, run } = useCardAction(act);
  return (
    <article className={`pcard memory ${card.status}`}>
      <p className="pcard-kicker">Remember this for later meetings?</p>
      <p className="pcard-draft">{card.text}</p>
      {card.status === "open" ? (
        <div className="pcard-actions">
          <button className="btn primary small" type="button" disabled={busy} onClick={() => run("memory/save", { cardId: card.id })}>
            Remember
          </button>
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("dismiss", { cardId: card.id })}>
            No thanks
          </button>
        </div>
      ) : (
        <p className="pcard-status">{card.status === "saved" ? "Saved in your agent's notes." : "Not saved."}</p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
    </article>
  );
}

function MemoryNotes({ items, act }: { items: MemoryItem[]; act: Act }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const { busy, error, run } = useCardAction(act);
  return (
    <div className="memory-notes">
      <button
        className={open ? "memory-toggle on" : "memory-toggle"}
        type="button"
        aria-expanded={open}
        title="What your agent remembers in this group"
        onClick={() => setOpen((value) => !value)}
      >
        Notes <span className="memory-count">{items.length}</span>
      </button>
      {open ? (
        <div className="memory-popover" role="dialog" aria-label="Your agent's notes">
          <p className="memory-title">Your agent remembers</p>
          <p className="fine-left">Only you and your agent see these. They carry over to this group's next meetings.</p>
          {items.length === 0 ? (
            <p className="muted small-note">Nothing yet.</p>
          ) : (
            <ul className="memory-list">
              {items.map((item) => (
                <li key={item.id}>
                  <span>{item.text}</span>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="Forget this note"
                    title="Forget"
                    disabled={busy}
                    onClick={() => void run("memory/delete", { id: item.id })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="memory-add"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              const text = draft.trim();
              if (text) void run("memory/add", { text }).then(() => setDraft(""));
            }}
          >
            <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a note, e.g. I can't meet on Fridays" aria-label="New note" />
            <button className="btn secondary small" type="submit" disabled={busy || !draft.trim()}>
              Add
            </button>
          </form>
          {error ? <p className="error small-note">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const STANCE_LABEL: Record<Stance, string> = { support: "Support", hesitant: "Hesitant", unsure: "Unsure" };

function StanceRow({ card, act }: { card: UnderstandingCheckCard; act: Act }) {
  const { busy, error, run } = useCardAction(act);
  return (
    <div className="stance-row">
      <p className="stance-title">How do you feel about it?</p>
      <div className="stance-chips" role="group" aria-label="Your stance">
        {(["support", "hesitant", "unsure"] as Stance[]).map((stance) => (
          <button
            key={stance}
            type="button"
            className={["stance-chip", stance, card.stance === stance ? "on" : ""].filter(Boolean).join(" ")}
            aria-pressed={card.stance === stance}
            disabled={busy}
            onClick={() => run("stance", { checkId: card.checkId, stance })}
          >
            {STANCE_LABEL[stance]}
            {card.suggestedStance === stance && card.stance !== stance ? <em className="guess">agent's read</em> : null}
          </button>
        ))}
      </div>
      <p className="fine-left">
        {card.stance
          ? `Shared without your name: ${STANCE_LABEL[card.stance].toLowerCase()}. You can change it.`
          : "Shared with the Moderator without your name, only if you click."}
      </p>
      {error ? <p className="error small-note">{error}</p> : null}
    </div>
  );
}

const PAIR_STATUS: Record<PairCard["status"], string> = {
  open: "",
  accepted: "You said yes. Waiting for the other person.",
  declined: "You said no thanks. Nothing was shared.",
  matched: "You both said yes. Your joint draft is below.",
  closed: "This offer is closed. Nothing was shared.",
};

function PairCardView({ card, act }: { card: PairCard; act: Act }) {
  const { busy, error, run } = useCardAction(act);
  return (
    <article className={`pcard pair ${card.status}`}>
      <p className="pcard-kicker">A teammate has something too</p>
      <p className="pcard-nudge">Another teammate also has something on {card.topic}. Want to see if your ideas fit together?</p>
      {card.status === "open" ? (
        <>
          <div className="pcard-actions">
            <button className="btn primary small" type="button" disabled={busy} onClick={() => run("pair", { pairingId: card.pairingId, accept: true })}>
              Yes, let's combine
            </button>
            <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("pair", { pairingId: card.pairingId, accept: false })}>
              No thanks
            </button>
          </div>
          <p className="fine-left">Nobody is named unless you both say yes. Then you see each other's name and one joint draft.</p>
        </>
      ) : (
        <p className="pcard-status">{PAIR_STATUS[card.status]}</p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
    </article>
  );
}

function JointCardView({ card, act }: { card: JointCard; act: Act }) {
  const [text, setText] = useState(card.draft);
  const { busy, error, run } = useCardAction(act);
  const open = card.status === "open";
  return (
    <article className={`pcard joint ${card.status}`}>
      <p className="pcard-kicker">Together with {card.partner}</p>
      {open ? (
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label="Joint draft" />
      ) : (
        <p className="pcard-draft">{card.draft}</p>
      )}
      {open ? (
        <>
          <div className="pcard-actions">
            <button className="btn primary small" type="button" disabled={busy || !text.trim()} onClick={() => run("joint", { cardId: card.id, text })}>
              Post together
            </button>
            <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("dismiss", { cardId: card.id })}>
              Not now
            </button>
          </div>
          <p className="fine-left">Posted under both names. Either of you can post it.</p>
        </>
      ) : (
        <p className="pcard-status">{card.status === "posted" ? `Posted together with ${card.partner}.` : "Not posted."}</p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
    </article>
  );
}
