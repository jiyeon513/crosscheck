// Small inline icons (currentColor). Moderator ◆ and Personal Agent ◇ keep the original diamonds.

type IconProps = { size?: number; className?: string };

/** The Moderator: a filled diamond. */
export function ModeratorIcon({ size = 16, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 21 12 12 21 3 12Z" fill="currentColor" />
    </svg>
  );
}

/** The Personal Agent: an outlined diamond. */
export function AgentIcon({ size = 16, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon({ size = 18, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function FileIcon({ size = 16, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M14 3v5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Opens the "Ask the Moderator" menu. */
export function ModeratorMenuIcon({ size = 18, className }: IconProps) {
  return <ModeratorIcon size={size} className={className} />;
}
