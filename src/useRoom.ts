import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, joinRoom, roomAction, roomView, type RoomView } from "./api";
import type { Meeting, TeamMessage } from "./model";

const POLL_MS = 1500;

/**
 * The meeting room on the server (agents/meeting.ts) for this group's current meeting:
 * joins it, polls this participant's view, and sends actions.
 */
export function useRoom(input: {
  code: string;
  user: string;
  groupTitle: string;
  meeting: Meeting | null;
  history: TeamMessage[];
}) {
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState("");
  const session = useRef<{ roomKey: string; token: string } | null>(null);
  const joining = useRef<Promise<void> | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const meetingId = input.meeting?.id ?? "general";

  const join = useCallback(async () => {
    const { code, user, groupTitle, meeting, history } = inputRef.current;
    joining.current ??= joinRoom({
      code,
      user,
      groupTitle,
      meeting: meeting ? { id: meeting.id, title: meeting.title, startsAt: meeting.startsAt } : null,
      history: history.map(({ author, text, createdAt }) => ({ author, text, createdAt })),
    })
      .then((result) => {
        session.current = { roomKey: result.roomKey, token: result.sessionToken };
      })
      .finally(() => {
        joining.current = null;
      });
    return joining.current;
  }, []);

  /** Runs a call; if the server lost the room (restart) or the session, joins again and retries once. */
  const withSession = useCallback(
    async <T,>(call: (roomKey: string, token: string) => Promise<T>): Promise<T> => {
      if (!session.current) await join();
      try {
        return await call(session.current!.roomKey, session.current!.token);
      } catch (caught) {
        if (!(caught instanceof ApiError) || (caught.status !== 404 && caught.status !== 403)) throw caught;
        session.current = null;
        await join();
        return call(session.current!.roomKey, session.current!.token);
      }
    },
    [join],
  );

  const refresh = useCallback(async () => {
    try {
      setView(await withSession(roomView));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the meeting room.");
    }
  }, [withSession]);

  useEffect(() => {
    session.current = null;
    setView(null);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [input.code, input.user, meetingId, refresh]);

  /** Sends an action, then refreshes the view. Throws so the caller can keep the user's draft. */
  const act = useCallback(
    async (action: string, body: object) => {
      await withSession((roomKey, token) => roomAction(roomKey, token, action, body));
      await refresh();
    },
    [refresh, withSession],
  );

  return { view, error, act, refresh };
}
