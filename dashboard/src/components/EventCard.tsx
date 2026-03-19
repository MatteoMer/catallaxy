import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { EventRow } from "../lib/types";
import { getRoleColor } from "../lib/types";

interface EventCardProps {
  event: EventRow;
  agentRole?: string;
}

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 1000) return "now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

export default function EventCard({ event, agentRole }: EventCardProps) {
  const [expanded, setExpanded] = useState(false);
  const color = getRoleColor(agentRole ?? "");

  return (
    <div className="animate-slide-in px-3 py-2 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)] transition-colors">
      <div
        className="flex items-center gap-2 cursor-pointer text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown size={12} className="text-[var(--text-secondary)]" />
        ) : (
          <ChevronRight size={12} className="text-[var(--text-secondary)]" />
        )}

        <span className="text-[var(--text-secondary)] w-12 shrink-0 font-mono">
          {relativeTime(event.timestamp)}
        </span>

        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
          style={{ background: `${color}22`, color }}
        >
          {event.agent_id}
        </span>

        <span className="px-1.5 py-0.5 rounded bg-[var(--bg-base)] text-[10px] font-mono text-[var(--text-secondary)]">
          {event.event_type}
        </span>
      </div>

      {expanded && (
        <pre className="mt-2 ml-5 text-[10px] text-[var(--text-secondary)] font-mono overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
