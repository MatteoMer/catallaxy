import { useState, useRef, useEffect } from "react";
import { Pause, Play } from "lucide-react";
import type { EventRow, TopologyAgent } from "../lib/types";
import EventCard from "./EventCard";

interface EventFeedProps {
  events: EventRow[];
  agents: TopologyAgent[];
  selectedAgent: string | null;
}

export default function EventFeed({
  events,
  agents,
  selectedAgent,
}: EventFeedProps) {
  const [paused, setPaused] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const agentRoleMap = new Map(agents.map((a) => [a.id, a.role]));

  const filtered = events.filter((e) => {
    if (selectedAgent && e.agent_id !== selectedAgent) return false;
    if (typeFilter && e.event_type !== typeFilter) return false;
    return true;
  });

  const eventTypes = [...new Set(events.map((e) => e.event_type))].sort();

  // Auto-scroll when not paused
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events, paused]);

  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] border-t border-[var(--border-subtle)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          Events
        </span>
        <span className="text-[10px] text-[var(--text-secondary)] bg-[var(--bg-base)] px-1.5 py-0.5 rounded font-mono">
          {filtered.length}
        </span>

        <select
          className="ml-auto text-[10px] bg-[var(--bg-base)] text-[var(--text-secondary)] border border-[var(--border-subtle)] rounded px-1.5 py-1 outline-none"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All types</option>
          {eventTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <button
          className="p-1 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
          onClick={() => setPaused(!paused)}
          title={paused ? "Resume auto-scroll" : "Pause auto-scroll"}
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
        </button>
      </div>

      {/* Event list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-[var(--text-secondary)]">
            No events yet
          </div>
        ) : (
          filtered.map((e) => (
            <EventCard
              key={e.id}
              event={e}
              agentRole={agentRoleMap.get(e.agent_id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
