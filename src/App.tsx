import { useState } from "react";
import { getGroup, type Group } from "./model";
import Groups from "./Groups";
import Home from "./Home";
import Room from "./Room";

type Route =
  | { screen: "home" }
  | { screen: "groups" }
  | { screen: "room"; groupId: string };

export default function App() {
  const [route, setRoute] = useState<Route>({ screen: "home" });

  if (route.screen === "home") {
    return <Home onOpenGroups={() => setRoute({ screen: "groups" })} />;
  }

  if (route.screen === "groups") {
    return (
      <Groups
        onHome={() => setRoute({ screen: "home" })}
        onOpen={(group: Group) => setRoute({ screen: "room", groupId: group.id })}
      />
    );
  }

  const group = getGroup(route.groupId);
  if (!group) return <Home onOpenGroups={() => setRoute({ screen: "groups" })} />;

  return <Room group={group} onBack={() => setRoute({ screen: "groups" })} />;
}
