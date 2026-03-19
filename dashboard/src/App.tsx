import { useState } from "react";
import Header from "./components/Header";
import NetworkGraph from "./components/NetworkGraph";
import EventFeed from "./components/EventFeed";
import MissionComposer from "./components/MissionComposer";
import { useEventStream } from "./hooks/useEventStream";
import { useTopology } from "./hooks/useTopology";

export default function App() {
  const { events, connected } = useEventStream();
  const { agents, nodes, edges, loading } = useTopology();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--text-secondary)] text-sm">
        Loading topology...
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-base)]">
      <Header connected={connected} />
      <div className="flex-1 flex overflow-hidden">
        {/* Main area: graph + event feed */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Network graph */}
          <div className="flex-[3] min-h-0">
            <NetworkGraph
              initialNodes={nodes}
              initialEdges={edges}
              events={events}
              onSelectAgent={setSelectedAgent}
            />
          </div>
          {/* Event feed */}
          <div className="flex-[2] min-h-0">
            <EventFeed
              events={events}
              agents={agents}
              selectedAgent={selectedAgent}
            />
          </div>
        </div>
        {/* Right sidebar: mission composer */}
        <div className="w-80 shrink-0">
          <MissionComposer agents={agents} />
        </div>
      </div>
    </div>
  );
}
