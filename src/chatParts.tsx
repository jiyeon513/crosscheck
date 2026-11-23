// Pieces shared by the team chat and the private window: bubbles, composer, drag and drop.
import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
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
    if ((event.target as HTMLElement).closest?.(".quote-card")) {
      event.preventDefault();
      return;
    }
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
          {quote ? <QuoteCard author={quote.author} text={quote.text} /> : null}
          {shownText ? <p className="bubble-text">{shownText}</p> : null}
          {footer}
        </div>
      </div>
    </article>
  );
}

/** A quoted card. Long text is clamped; clicking it shows the original in full. */
function QuoteCard({
  author,
  text,
  label = "↪",
  attached = false,
  onClear,
}: {
  author: string;
  text: string;
  label?: string;
  attached?: boolean;
  onClear?: () => void;
}) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [open, setOpen] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const expandable = truncated || open;

  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node) return;
    const measure = () => {
      if (open) return;
      setTruncated(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, open]);

  function toggle(event: MouseEvent | ReactKeyboardEvent) {
    if (!expandable) return;
    event.stopPropagation();
    setOpen((value) => !value);
  }

  return (
    <div className={["quote-card", attached ? "attached" : "", open ? "open" : ""].filter(Boolean).join(" ")}>
      <div
        className={expandable ? "quote-body expandable" : "quote-body"}
        onClick={expandable ? toggle : undefined}
        onKeyDown={
          expandable
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                toggle(event);
              }
            : undefined
        }
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        title={truncated && !open ? "Show full text" : undefined}
      >
        <p className="quote-author">
          {label} {author}
        </p>
        <p ref={textRef} className="quote-text">
          {text}
        </p>
      </div>
      {onClear ? (
        <button className="icon-btn small" type="button" onClick={onClear} aria-label="Remove attachment">
          ×
        </button>
      ) : null}
    </div>
  );
}

/** Plain text pasted onto the conversation, rather than into the text box, still lands in the draft. */
export function pasteToDraft(event: ClipboardEvent<HTMLElement>, apply: (text: string) => void) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("textarea, input")) return;
  const text = event.clipboardData.getData("text/plain");
  if (!text) return;
  event.preventDefault();
  apply(text);
}

export function joinDraft(current: string, text: string) {
  if (!current) return text;
  if (current.endsWith("\n") || text.startsWith("\n")) return current + text;
  return `${current}\n${text}`;
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
  zone?: Zone;
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
        <QuoteCard
          author={quote.author}
          text={quote.text}
          label={quoteLabel ?? "↪"}
          attached
          onClear={onClearQuote}
        />
      ) : null}
      <div className="composer-row">
        <GrowingInput
          value={value}
          onChange={onChange}
          placeholder={quote ? quotePlaceholder : placeholder}
          label={placeholder}
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

/**
 * A text box that wraps and grows downwards (up to about six lines) instead of scrolling sideways.
 * Enter sends, Shift+Enter adds a line; Enter while composing Korean/Japanese text is left alone.
 */
export function GrowingInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <textarea
      ref={ref}
      className="growing-input"
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={label}
    />
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
