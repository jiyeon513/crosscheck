// Pieces shared by the team chat and the private window: bubbles, composer, drag and drop.
import type { DragEvent, FormEvent, ReactNode } from "react";
import { Avatar } from "./ui";

export type Source = "team" | "agent" | "user";
export type Quote = { author: string; text: string };
/** What is being dragged. `messageId` is the room's id for a team message, so the agent can refer to it. */
export type Carried = { from: Source | ""; author: string; text: string; messageId?: string };
export type Zone = {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
};

let carried: Carried | null = null;

export function readDrop(event: DragEvent): Carried | null {
  if (carried?.text) return carried;
  const raw = event.dataTransfer.getData("application/x-crosscheck");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Carried>;
      if (parsed.text?.trim()) {
        return {
          from: parsed.from ?? "",
          author: parsed.author ?? "",
          text: parsed.text.trim(),
          messageId: parsed.messageId,
        };
      }
    } catch {
      // Fall through to plain text from another app.
    }
  }
  const text = event.dataTransfer.getData("text/plain").trim();
  return text ? { from: "", author: "Pasted text", text } : null;
}

export function clearCarried() {
  carried = null;
}

export function Bubble({
  from,
  mine = false,
  author,
  label,
  text,
  quote,
  forwarded = false,
  variant,
  messageId,
  footer,
  onDragState,
}: {
  from: Source;
  mine?: boolean;
  author: string;
  label?: string;
  text: string;
  quote?: Quote;
  forwarded?: boolean;
  variant?: "moderator" | "anonymous" | "failed" | "status";
  messageId?: string;
  footer?: ReactNode;
  onDragState: (from: Source | null) => void;
}) {
  const shownText = forwarded ? "" : text;
  const dragText = shownText || quote?.text || text;

  function dragStart(event: DragEvent) {
    carried = { from, author, text: dragText, messageId };
    event.dataTransfer.setData("application/x-crosscheck", JSON.stringify(carried));
    event.dataTransfer.setData("text/plain", dragText);
    event.dataTransfer.effectAllowed = "copy";
    setDragGhost(event, author, dragText, from);
    onDragState(from);
  }

  const className = ["bubble-row", from, mine ? "mine" : "", variant ?? ""].join(" ");
  const showAuthor = from === "team" && !mine;

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
      {showAuthor ? (
        variant === "moderator" ? (
          <span className="avatar mod-avatar" aria-hidden="true">
            ◆
          </span>
        ) : variant === "anonymous" ? (
          <span className="avatar anon-avatar" aria-hidden="true">
            ?
          </span>
        ) : (
          <Avatar name={author} />
        )
      ) : null}
      <div className="bubble-col">
        {showAuthor ? (
          <p className="bubble-author">
            {author}
            {variant === "moderator" ? <em className="ai-tag">AI</em> : null}
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
          {footer}
        </div>
      </div>
    </article>
  );
}

export function Composer({
  tone,
  active,
  over,
  zone,
  quote,
  quoteLabel,
  onClearQuote,
  value,
  onChange,
  onSubmit,
  placeholder,
  quotePlaceholder = "Add a note (optional)",
  canSend,
  dropLabel,
  busy = false,
}: {
  tone: "team" | "agent";
  active: boolean;
  over: boolean;
  zone: Zone;
  quote: Quote | null;
  quoteLabel?: string;
  onClearQuote: () => void;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  placeholder: string;
  quotePlaceholder?: string;
  canSend: boolean;
  dropLabel: string;
  busy?: boolean;
}) {
  const className = ["composer", `${tone}-composer`, active ? "active" : "", over ? "over" : ""].join(" ");
  return (
    <form className={className} onSubmit={onSubmit} {...zone}>
      {quote ? (
        <div className="quote-card attached">
          <div>
            <p className="quote-author">
              {quoteLabel ?? "↪"} {quote.author}
            </p>
            <p className="quote-text">{quote.text}</p>
          </div>
          <button className="icon-btn small" type="button" onClick={onClearQuote} aria-label="Remove attachment">
            ×
          </button>
        </div>
      ) : null}
      <div className="composer-row">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={quote ? quotePlaceholder : placeholder}
          aria-label={placeholder}
        />
        <button className="btn primary small" type="submit" disabled={!canSend || busy}>
          {busy ? "..." : "Send"}
        </button>
      </div>
      <div className="drop-overlay" aria-hidden="true">
        <span>{dropLabel}</span>
      </div>
    </form>
  );
}

export function People({ people }: { people: string[] }) {
  const shown = people.slice(0, 4);
  return (
    <div className="people" title={people.join(", ")}>
      <div className="avatar-stack">
        {shown.map((name) => (
          <Avatar key={name} name={name} size="sm" />
        ))}
      </div>
      <span>{people.length}</span>
    </div>
  );
}

export function Typing({ label }: { label: string }) {
  return (
    <div className="typing" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
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
