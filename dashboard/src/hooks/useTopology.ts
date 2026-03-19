import { useState, useEffect } from "react";
import type { Node, Edge } from "@xyflow/react";
import { fetchTopology } from "../lib/api";
import type { TopologyAgent } from "../lib/types";
import { getRoleColor } from "../lib/types";

// Layout agents in role clusters
const ROLE_POSITIONS: Record<string, { x: number; y: number }> = {
  research: { x: 100, y: 50 },
  coding: { x: 500, y: 50 },
  writing: { x: 100, y: 350 },
  control: { x: 500, y: 350 },
};

export function useTopology() {
  const [agents, setAgents] = useState<TopologyAgent[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTopology()
      .then((topology) => {
        setAgents(topology);

        // Group by role
        const roleGroups: Record<string, TopologyAgent[]> = {};
        for (const a of topology) {
          (roleGroups[a.role] ??= []).push(a);
        }

        const newNodes: Node[] = topology.map((a) => {
          const group = roleGroups[a.role] ?? [];
          const idx = group.indexOf(a);
          const base = ROLE_POSITIONS[a.role] ?? { x: 300, y: 200 };

          return {
            id: a.id,
            type: "agentNode",
            position: {
              x: base.x + idx * 160,
              y: base.y + (idx % 2) * 80,
            },
            data: {
              label: a.id,
              role: a.role,
              port: a.port,
              tools: a.tools,
              color: getRoleColor(a.role),
            },
          };
        });

        const edgeSet = new Set<string>();
        const newEdges: Edge[] = [];
        for (const a of topology) {
          for (const peerId of a.peers) {
            const key = [a.id, peerId].sort().join("-");
            if (!edgeSet.has(key)) {
              edgeSet.add(key);
              newEdges.push({
                id: `e-${key}`,
                source: a.id,
                target: peerId,
                type: "messageEdge",
                animated: false,
                data: { active: false },
              });
            }
          }
        }

        setNodes(newNodes);
        setEdges(newEdges);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { agents, nodes, edges, setEdges, loading };
}
