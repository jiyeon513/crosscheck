export type JoinResult = {
  apiKey: string;
  token: string;
  userId: string;
  name: string;
  code: string;
  title: string;
};

export async function joinGroup(input: {
  name: string;
  role: string;
  code: string;
  title?: string;
}): Promise<JoinResult> {
  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as JoinResult & { error?: string };
  if (!response.ok) throw new Error(body.error || "Could not join the group.");
  return body;
}

export function Logo() {
  return (
    <div className="brand">
      <span className="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path
            d="M6 12.5 10 16.5 18 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <strong>CrossCheck.</strong>
    </div>
  );
}
