import { useState } from "react";
import { getGroup, loadProfile, logout, type Profile } from "./model";
import Login from "./Login";
import Home from "./Home";
import { CreateChat, InviteCode, JoinChat } from "./Start";
import Room from "./Room";

type Route =
  | { screen: "home" }
  | { screen: "create" }
  | { screen: "join" }
  | { screen: "invite"; groupId: string }
  | { screen: "room"; groupId: string };

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(loadProfile);
  const [route, setRoute] = useState<Route>({ screen: "home" });
  const home = () => setRoute({ screen: "home" });

  if (!profile) {
    return (
      <Login
        onLogin={(next) => {
          setProfile(next);
          home();
        }}
      />
    );
  }

  const signOut = () => {
    logout();
    setProfile(null);
  };

  switch (route.screen) {
    case "create":
      return (
        <CreateChat
          profile={profile}
          onBack={home}
          onCreated={(groupId) => setRoute({ screen: "invite", groupId })}
        />
      );
    case "join":
      return (
        <JoinChat
          profile={profile}
          onBack={home}
          onJoined={(groupId) => setRoute({ screen: "room", groupId })}
        />
      );
    case "invite": {
      const group = getGroup(route.groupId);
      if (!group) break;
      return (
        <InviteCode
          group={group}
          onBack={home}
          onEnter={() => setRoute({ screen: "room", groupId: group.id })}
        />
      );
    }
    case "room": {
      const group = getGroup(route.groupId);
      if (!group) break;
      return <Room group={group} profile={profile} onBack={home} />;
    }
  }

  return (
    <Home
      profile={profile}
      onCreate={() => setRoute({ screen: "create" })}
      onJoin={() => setRoute({ screen: "join" })}
      onOpen={(groupId) => setRoute({ screen: "room", groupId })}
      onShowCode={(groupId) => setRoute({ screen: "invite", groupId })}
      onLogout={signOut}
    />
  );
}
