import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import AgentNode from "./AgentNode";
import MessageEdge from "./MessageEdge";
import type { EventRow } from "../lib/types";

interface NetworkGraphProps {
  initialNodes: Node[];
  initialEdges: Edge[];
  events: EventRow[];
  onSelectAgent: (agentId: string | null) => void;
}

const nodeTypes = { agentNode: AgentNode };
const edgeTypes = { messageEdge: MessageEdge };

export default function NetworkGraph({
  initialNodes,
  initialEdges,
  events,
  onSelectAgent,
}: NetworkGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Sync initial data
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Animate edges on peer events
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (!latest) return;

    if (
      latest.event_type === "peer_request" ||
      latest.event_type === "peer_response"
    ) {
      const peerId = latest.data.peer_id as string | undefined;
      if (!peerId) return;

      const edgeKey = [latest.agent_id, peerId].sort().join("-");
      const edgeId = `e-${edgeKey}`;

      setEdges((eds) =>
        eds.map((e) =>
          e.id === edgeId ? { ...e, data: { ...e.data, active: true } } : e
        )
      );

      // Clear previous timeout for this edge
      const prev = timeoutsRef.current.get(edgeId);
      if (prev) clearTimeout(prev);

      const timeout = setTimeout(() => {
        setEdges((eds) =>
          eds.map((e) =>
            e.id === edgeId ? { ...e, data: { ...e.data, active: false } } : e
          )
        );
        timeoutsRef.current.delete(edgeId);
      }, 2000);

      timeoutsRef.current.set(edgeId, timeout);
    }
  }, [events, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectAgent(node.id);
    },
    [onSelectAgent]
  );

  const onPaneClick = useCallback(() => {
    onSelectAgent(null);
  }, [onSelectAgent]);

  const defaultViewport = useMemo(() => ({ x: 50, y: 50, zoom: 1 }), []);

  return (
    <div className="w-full h-full">
      <svg className="absolute w-0 h-0">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={defaultViewport}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--border-subtle)" gap={32} size={1} />
        <Controls />
        <MiniMap
          nodeColor={(n) => (n.data?.color as string) ?? "#666"}
          maskColor="rgba(10,10,15,0.8)"
        />
      </ReactFlow>
    </div>
  );
}
