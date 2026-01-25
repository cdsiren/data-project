import { memo } from "react";
import { Activity, Wifi, WifiOff } from "lucide-react";

interface HeaderProps {
  connected: boolean;
}

export const Header = memo<HeaderProps>(function Header({ connected }) {
  return (
    <header className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Activity className="h-6 w-6 text-white" aria-hidden="true" />
          <h1 className="text-xl font-bold">Indication</h1>
        </div>
        <div
          className="flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          {connected ? (
            <>
              <Wifi className="h-4 w-4 text-green-500" aria-hidden="true" />
              <span className="text-sm text-green-500">Live</span>
            </>
          ) : (
            <>
              <WifiOff className="h-4 w-4 text-red-500" aria-hidden="true" />
              <span className="text-sm text-red-500">Disconnected</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
});
