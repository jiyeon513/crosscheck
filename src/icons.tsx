// Small inline icons (currentColor), so the Moderator and the Personal Agent are easy to tell apart.

type IconProps = { size?: number; className?: string };

/** The Moderator: a hub that connects the team. */
export function ModeratorIcon({ size = 16, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 12 5.5 6.5M12 12l6.5-5.5M12 12v7" />
      </g>
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      <circle cx="5" cy="6" r="2.4" fill="currentColor" opacity="0.75" />
      <circle cx="19" cy="6" r="2.4" fill="currentColor" opacity="0.75" />
      <circle cx="12" cy="20" r="2.4" fill="currentColor" opacity="0.75" />
    </svg>
  );
}

/** The Personal Agent: a private assistant (sparkle). */
export function AgentIcon({ size = 16, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10 3.5c.5 3.6 2.4 5.5 6 6-3.6.5-5.5 2.4-6 6-.5-3.6-2.4-5.5-6-6 3.6-.5 5.5-2.4 6-6Z"
      />
      <path fill="currentColor" opacity="0.7" d="M18 13c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z" />
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
