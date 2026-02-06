import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { TriggerTable } from "@/components/triggers/TriggerTable";
import { useTriggerStream } from "@/hooks/useTriggerStream";

function App() {
  const {
    events,
    connected,
    error: streamError,
    reconnect,
  } = useTriggerStream();

  return (
    <div className="min-h-screen flex flex-col bg-[hsl(var(--background))]">
      <Header connected={connected} />

      <main className="flex-1 container mx-auto p-4">
        <TriggerTable
          events={events}
          connected={connected}
          error={streamError}
          onReconnect={reconnect}
        />
      </main>

      <Footer />
    </div>
  );
}

export default App;
