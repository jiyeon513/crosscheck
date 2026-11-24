import { useEffect, useState } from "react";
import { api, getToken, onSignedOut } from "./api";
import GroupPage from "./Group";
import Home from "./Home";
import Login from "./Login";
import { cleanCode } from "./model";
import Room from "./Room";
import { CreateGroup, InviteCode, JoinGroup } from "./Start";

type Route =
  | { screen: "home" }
  | { screen: "create" }
  | { screen: "join" }
  | { screen: "invite"; code: string }
  | { screen: "group"; code: string }
  | { screen: "room"; code: string };

export default function App() {
  const [me, setMe] = useState<string | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [route, setRoute] = useState<Route>({ screen: "home" });
  // An invitation link (?join=CODE) opens the join screen with the code filled in, after logging in if needed.
  const [invited, setInvited] = useState(() => cleanCode(new URLSearchParams(window.location.search).get("join") ?? ""));

  useEffect(() => {
    if (invited) window.history.replaceState(null, "", window.location.pathname);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onSignedOut(() => setMe(null));
    if (!getToken()) return;
    api
      .me()
      .then((result) => setMe(result.name))
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="screen loading" aria-busy="true" />;
  if (!me) {
    return (
      <Login
        onLogin={(name) => {
          setMe(name);
          setRoute({ screen: "home" });
        }}
      />
    );
  }

  const home = () => setRoute({ screen: "home" });
  const toGroup = (code: string) => setRoute({ screen: "group", code });

  if (invited && route.screen === "home") {
    return (
      <JoinGroup
        initialCode={invited}
        onBack={() => setInvited("")}
        onJoined={(code) => {
          setInvited("");
          toGroup(code);
        }}
      />
    );
  }

  switch (route.screen) {
    case "create":
      return <CreateGroup onBack={home} onCreated={(code) => setRoute({ screen: "invite", code })} />;
    case "join":
      return <JoinGroup onBack={home} onJoined={toGroup} />;
    case "invite":
      return <InviteCode code={route.code} onBack={home} onEnter={() => toGroup(route.code)} />;
    case "group":
      return (
        <GroupPage
          code={route.code}
          me={me}
          onBack={home}
          onOpenChat={() => setRoute({ screen: "room", code: route.code })}
        />
      );
    case "room":
      return (
        <Room
          code={route.code}
          me={me}
          onBack={() => toGroup(route.code)}
          onLogout={() => {
            void api.logOut().then(() => setMe(null));
          }}
        />
      );
    default:
      return (
        <Home
          me={me}
          onCreate={() => setRoute({ screen: "create" })}
          onJoin={() => setRoute({ screen: "join" })}
          onOpen={toGroup}
          onShowCode={(code) => setRoute({ screen: "invite", code })}
          onLogout={() => {
            void api.logOut().then(() => setMe(null));
          }}
        />
      );
  }
}
