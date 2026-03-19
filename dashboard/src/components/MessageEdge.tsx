import { memo } from "react";
import {
  BaseEdge,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";

function MessageEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const active = (data as Record<string, unknown> | undefined)?.active as boolean;
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: active ? "#22d3ee" : "var(--border-subtle)",
          strokeWidth: active ? 2 : 1,
          transition: "stroke 0.3s, stroke-width 0.3s",
        }}
      />
      {active && (
        <circle r="4" fill="#22d3ee" filter="url(#glow)">
          <animateMotion dur="1s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
    </>
  );
}

export default memo(MessageEdgeInner);
