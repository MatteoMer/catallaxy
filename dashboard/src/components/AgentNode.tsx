import { memo, useState, useEffect, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

interface AgentNodeData {
  label: string;
  role: string;
  port: number;
  tools: string[];
  color: string;
  [key: string]: unknown;
}

function AgentNodeInner({ data }: NodeProps) {
  const { label, role, port, color } = data as unknown as AgentNodeData;
  const [healthy, setHealthy] = useState<boolean | null>(null);

  const checkHealth = useCallback(() => {
    fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => setHealthy(r.ok))
      .catch(() => setHealthy(false));
  }, [port]);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  return (
    <div
      className="relative rounded-xl px-4 py-3 min-w-[120px] border backdrop-blur-sm"
      style={{
        background: "var(--bg-elevated)",
        borderColor: color,
        boxShadow: `0 0 20px ${color}22`,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-[var(--border-subtle)] !w-2 !h-2" />
      <Handle type="source" position={Position.Right} className="!bg-[var(--border-subtle)] !w-2 !h-2" />

      <div className="flex items-center gap-2 mb-1">
        <div className="relative">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              healthy === null
                ? "bg-gray-500"
                : healthy
                ? "bg-emerald-400"
                : "bg-red-400"
            }`}
          />
          {healthy && (
            <div className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-ring" />
          )}
        </div>
        <span className="font-semibold text-sm capitalize">{label}</span>
      </div>

      <span
        className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
        style={{ background: `${color}22`, color }}
      >
        {role}
      </span>
    </div>
  );
}

export default memo(AgentNodeInner);
