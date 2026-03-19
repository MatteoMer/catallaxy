interface HeaderProps {
  connected: boolean;
}

export default function Header({ connected }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Catallaxy</h1>
        <span className="text-xs text-[var(--text-secondary)] font-mono">
          operator dashboard
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <div
          className={`w-2 h-2 rounded-full ${
            connected ? "bg-emerald-400" : "bg-red-400"
          }`}
        />
        <span className="text-[var(--text-secondary)]">
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>
    </header>
  );
}
