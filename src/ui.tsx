export function Avatar({ name, size }: { name: string; size?: "sm" }) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={`avatar tone-${tone(name)}${size ? ` ${size}` : ""}`} aria-hidden="true">
      {letter}
    </span>
  );
}

export function tone(name: string) {
  return name.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
}

export function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button className="btn ghost small back-btn" type="button" onClick={onClick}>
      <span aria-hidden="true">←</span> {label}
    </button>
  );
}
