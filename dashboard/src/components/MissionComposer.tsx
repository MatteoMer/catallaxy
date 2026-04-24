import { useState, useCallback } from "react";
import { Send, Loader2, CheckCircle, XCircle, Ban } from "lucide-react";
import type { TopologyAgent, Mission } from "../lib/types";
import { getRoleColor } from "../lib/types";
import { sendMessage, fetchTaskStatus } from "../lib/api";

interface MissionComposerProps {
  agents: TopologyAgent[];
}

export default function MissionComposer({ agents }: MissionComposerProps) {
  const [selectedAgent, setSelectedAgent] = useState("");
  const [content, setContent] = useState("");
  const [reward, setReward] = useState("0.10");
  const [sending, setSending] = useState(false);
  const [missions, setMissions] = useState<Mission[]>([]);

  const agent = agents.find((a) => a.id === selectedAgent);

  const handleSend = useCallback(async () => {
    if (!agent || !content.trim()) return;

    const rewardNum = parseFloat(reward) || 0;
    setSending(true);
    try {
      const { task_id } = await sendMessage(agent.port, content.trim(), rewardNum);
      const mission: Mission = {
        agentId: agent.id,
        content: content.trim(),
        reward: rewardNum,
        taskId: task_id,
        status: "queued",
        sentAt: new Date().toISOString(),
      };
      setMissions((prev) => [mission, ...prev]);
      setContent("");

      // Poll for status
      const poll = setInterval(async () => {
        try {
          const task = await fetchTaskStatus(agent.port, task_id);
          const taskStatus = task.status as string;
          const taskResult = task.result as string | undefined;
          setMissions((prev) =>
            prev.map((m) =>
              m.taskId === task_id ? { ...m, status: taskStatus, result: taskResult } : m
            )
          );
          if (["completed", "failed", "rejected"].includes(taskStatus)) {
            clearInterval(poll);
          }
        } catch {
          clearInterval(poll);
        }
      }, 2000);
    } catch {
      // Error handling
    } finally {
      setSending(false);
    }
  }, [agent, content, reward]);

  // Group agents by role for the dropdown
  const grouped = agents.reduce<Record<string, TopologyAgent[]>>((acc, a) => {
    (acc[a.role] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] border-l border-[var(--border-subtle)]">
      <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
        <h2 className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
          Mission Composer
        </h2>
      </div>

      <div className="flex-1 flex flex-col p-4 gap-3 overflow-y-auto">
        {/* Agent selector */}
        <select
          className="w-full text-sm bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 outline-none focus:border-[var(--role-research)]"
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
        >
          <option value="">Select agent...</option>
          {Object.entries(grouped).map(([role, roleAgents]) => (
            <optgroup key={role} label={role.toUpperCase()}>
              {roleAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} ({a.tools.join(", ")})
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* Reward */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
            Reward (pathUSD)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            className="flex-1 text-sm bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 outline-none focus:border-[var(--role-research)]"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
          />
        </div>

        {/* Mission content */}
        <textarea
          className="w-full h-32 text-sm bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 outline-none resize-none focus:border-[var(--role-research)]"
          placeholder="Describe the mission..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) handleSend();
          }}
        />

        {/* Send button */}
        <button
          className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
          style={{
            background: agent ? getRoleColor(agent.role) : "var(--border-subtle)",
            color: "#0a0a0f",
          }}
          disabled={!agent || !content.trim() || sending}
          onClick={handleSend}
        >
          {sending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Send size={14} />
          )}
          {sending ? "Sending..." : "Send Mission"}
        </button>

        {/* Recent missions */}
        {missions.length > 0 && (
          <div className="mt-4">
            <h3 className="text-[10px] font-medium text-[var(--text-secondary)] uppercase tracking-wider mb-2">
              Recent Missions
            </h3>
            <div className="space-y-2">
              {missions.map((m, i) => (
                <div
                  key={i}
                  className="p-2 rounded-lg bg-[var(--bg-base)] border border-[var(--border-subtle)] text-xs"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{
                        background: `${getRoleColor(
                          agents.find((a) => a.id === m.agentId)?.role ?? ""
                        )}22`,
                        color: getRoleColor(
                          agents.find((a) => a.id === m.agentId)?.role ?? ""
                        ),
                      }}
                    >
                      {m.agentId}
                    </span>
                    <span className="flex items-center gap-1 text-[var(--text-secondary)]">
                      {m.status === "completed" ? (
                        <CheckCircle size={10} className="text-emerald-400" />
                      ) : m.status === "failed" ? (
                        <XCircle size={10} className="text-red-400" />
                      ) : m.status === "rejected" ? (
                        <Ban size={10} className="text-amber-400" />
                      ) : (
                        <Loader2 size={10} className="animate-spin" />
                      )}
                      {m.status}
                    </span>
                  </div>
                  <p className="text-[var(--text-secondary)] truncate">
                    {m.content}
                  </p>
                  {m.result && (
                    <p className="text-[var(--text-primary)] mt-1 whitespace-pre-wrap break-words">
                      {m.result}
                    </p>
                  )}
                  {m.taskId && (
                    <p className="text-[var(--text-secondary)] font-mono mt-1 text-[10px]">
                      {m.taskId}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
