// The private window: this person's chat with their personal agent, and the cards the agent offers.
// Nothing here reaches the group unless the person presses Share / Raise themselves.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Card,
  ConcernCard,
  PrivateItem,
  ShareSuggestionCard,
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
}) {
  const [draft, setDraft] = useState("");
  const files = useAttachments();
  const [sending, setSending] = useState(false);
  const [local, setLocal] = useState<Local[]>([]);
  const end = useRef<HTMLDivElement | null>(null);
  const items = view?.private ?? [];
  const typing = sending || Boolean(view?.agentTyping);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length, local.length, typing]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const typed = draft.trim();
    const attached = files.items;
    if ((!typed && !reference && attached.length === 0) || sending || files.uploading > 0) return;
    const body = {
      ...messageFor(typed, reference),
      ...(attached.length ? { attachments: attached.map((file) => file.id) } : {}),
    };
    const pending: Local = { id: crypto.randomUUID(), type: "user", text: body.text, attachments: attached };
    setLocal((current) => [...current.filter((item) => item.type !== "failed"), pending]);
    setDraft("");
    files.clear();
    onReference(null);
    setSending(true);
    try {
      await act("private", body);
      setLocal((current) => current.filter((item) => item.id !== pending.id));
    } catch (caught) {
      setDraft(typed);
      files.set(attached);
      onReference(reference);
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
          {items.length === 0 && local.length === 0 ? (
            <div className="empty">
              <p>Think out loud here. Only you can see this.</p>
            </div>
          ) : null}
          {items.map((item) => (
            <PrivateEntry
              key={item.id}
              item={item}
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
  me,
  act,
  onAsk,
  onDragState,
}: {
  item: PrivateItem;
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
      return <ShareCard card={card} act={act} onAsk={ask} />;
    case "understanding_check":
      return <CheckCard card={card} act={act} onAsk={ask} />;
    case "concern":
      return <ConcernCardView card={card} act={act} onAsk={ask} />;
  }
}

function cardTitle(card: Card) {
  if (card.kind === "share_suggestion") return "Suggestion";
  if (card.kind === "understanding_check") return "Agreement check";
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
  group_question: "Team question relayed by the Moderator",
  react: "Connects to what was just said",
  missing_angle: "An angle the team has not covered",
  chat: "Draft for the team",
};

/** The draft on a card starts folded, so a reply plus its card does not fill the window. */
function DraftToggle({ shown, onToggle, id }: { shown: boolean; onToggle: () => void; id: string }) {
  return (
    <button className="pcard-toggle" type="button" aria-expanded={shown} aria-controls={id} onClick={onToggle}>
      <span aria-hidden="true">{shown ? "▾" : "▸"}</span> {shown ? "Hide draft" : "Show draft"}
    </button>
  );
}

function ShareCard({ card, act, onAsk }: { card: ShareSuggestionCard; act: Act; onAsk: (text: string) => void }) {
  const [text, setText] = useState(card.draft);
  const [shown, setShown] = useState(false);
  const { busy, error, run } = useCardAction(act);
  const open = card.status === "open";
  const draftId = `draft-${card.id}`;
  // A draft from the private chat follows the agent's reply right above it, so it is a single
  // small row until opened. Cards the agent offers on its own keep their reason visible.
  const compact = card.source === "chat";
  return (
    <article className={`pcard share ${card.status}${compact ? " compact" : ""}${compact && shown ? " expanded" : ""}`}>
      {compact ? (
        <button
          className="pcard-row"
          type="button"
          aria-expanded={shown}
          aria-controls={draftId}
          onClick={() => setShown((value) => !value)}
        >
          <span className="pcard-kicker">{SOURCE_LABEL[card.source]}</span>
          {open ? null : <span className="pcard-row-state">{statusLabel(card.status)}</span>}
          <span className="pcard-chevron" aria-hidden="true">
            {shown ? "▾" : "▸"}
          </span>
          <span className="sr-only">{shown ? "Hide draft" : "Show draft"}</span>
        </button>
      ) : (
        <>
          <p className="pcard-kicker">{SOURCE_LABEL[card.source]}</p>
          {card.relayedQuestion && <blockquote className="pcard-decision">{card.relayedQuestion.author} · {card.relayedQuestion.text}</blockquote>}
          <p className="pcard-nudge">{card.nudge}</p>
          <DraftToggle shown={shown} onToggle={() => setShown((value) => !value)} id={draftId} />
        </>
      )}
      {shown ? (
        open ? (
          <textarea id={draftId} value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label="Draft to share" />
        ) : (
          <p id={draftId} className="pcard-draft">{card.draft}</p>
        )
      ) : null}
      {open && shown ? (
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
      ) : open || compact ? null : (
        <p className="pcard-status">{statusLabel(card.status)}</p>
      )}
      {error ? <p className="error small-note">{error}</p> : null}
      {!compact || shown ? (
        <button className="pcard-ask" type="button" onClick={() => onAsk(compact ? card.draft : card.nudge)}>
          Ask my agent about this
        </button>
      ) : null}
    </article>
  );
}

function ConcernCardView({ card, act, onAsk }: { card: ConcernCard; act: Act; onAsk: (text: string) => void }) {
  const [text, setText] = useState(card.draft);
  const [shown, setShown] = useState(false);
  const { busy, error, run } = useCardAction(act);
  const open = card.status === "open";
  const draftId = `draft-${card.id}`;
  return (
    <article className={`pcard concern ${card.status}`}>
      <p className="pcard-kicker">Concern · {card.label}</p>
      <DraftToggle shown={shown} onToggle={() => setShown((value) => !value)} id={draftId} />
      {shown ? (
        open ? (
          <textarea id={draftId} value={text} onChange={(event) => setText(event.target.value)} rows={3} aria-label="Concern to raise" />
        ) : (
          <p id={draftId} className="pcard-draft">{card.draft}</p>
        )
      ) : null}
      {open && shown ? (
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
          <button className="btn ghost small" type="button" disabled={busy} onClick={() => run("dismiss", { cardId: card.id })}>
            Not now
          </button>
        </div>
      ) : open ? null : (
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
    case "dismissed":
      return "Dismissed";
    case "superseded":
      return "The proposal changed, so this is out of date";
    default:
      return status;
  }
}
