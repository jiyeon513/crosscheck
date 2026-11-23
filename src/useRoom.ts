import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type RoomView } from "./api";

const POLL_MS = 1500;

/**
 * The server's meeting room (agents/meeting.ts) for one group meeting: joins it as the signed-in
 * member, polls this member's view, and sends actions.
 */
export function useRoom(code: string, meetingId: string | null, enabled = true) {
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState("");
  const roomKey = useRef<string | null>(null);
  const joining = useRef<Promise<void> | null>(null);
  const target = useRef({ code, meetingId });
  target.current = { code, meetingId };

  const join = useCallback(async () => {
    joining.current ??= api
      .joinRoom(target.current.code, target.current.meetingId)
      .then((result) => {
        roomKey.current = result.roomKey;
      })
      .finally(() => {
        joining.current = null;
      });
    return joining.current;
  }, []);

  /** Runs a call; if the server lost the room (for example after a restart), joins again and retries once. */
  const inRoom = useCallback(
    async <T,>(call: (key: string) => Promise<T>): Promise<T> => {
      if (!roomKey.current) await join();
      try {
        return await call(roomKey.current!);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 404) throw caught;
        roomKey.current = null;
        await join();
        return call(roomKey.current!);
      }
    },
    [join],
  );

  const refresh = useCallback(async () => {
    try {
      setView(await inRoom(api.roomView));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the meeting room.");
    }
  }, [inRoom]);

  useEffect(() => {
    roomKey.current = null;
    setView(null);
    if (!enabled) return;
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
  }, [code, meetingId, enabled, refresh]);

  /** Sends an action, then refreshes the view. Throws so the caller can keep the member's draft. */
  const act = useCallback(
    async (action: string, body: object) => {
      await inRoom((key) => api.roomAction(key, action, body));
      await refresh();
    },
    [inRoom, refresh],
  );

  return { view, error, act, refresh };
}
