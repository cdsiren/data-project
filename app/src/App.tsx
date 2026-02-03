import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CandlestickChart } from "@/components/charts/CandlestickChart";
import { TriggerTable } from "@/components/triggers/TriggerTable";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useTopMarket } from "@/hooks/useTopMarket";
import { useOHLC } from "@/hooks/useOHLC";
import { useTriggerStream } from "@/hooks/useTriggerStream";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Activity } from "lucide-react";

function App() {
  const {
    data: topMarketData,
    isLoading: topMarketLoading,
    error: topMarketError,
  } = useTopMarket();

  const topMarket = topMarketData?.data;

  const {
    data: ohlcData,
    isLoading: ohlcLoading,
    error: ohlcError,
    isFetching: ohlcFetching,
  } = useOHLC(topMarket?.asset_id ?? null, {
    enabled: !!topMarket?.asset_id,
  });

  const {
    events,
    connected,
    error: streamError,
    reconnect,
  } = useTriggerStream();

  const chartTitle = topMarket?.question
    ? `Most Active: ${topMarket.question}`
    : "Most Active Market";

  const chartSubtitle = topMarket
    ? `${topMarket.tick_count.toLocaleString()} ticks in last 10 min`
    : undefined;

  return (
    <div className="min-h-screen flex flex-col bg-[hsl(var(--background))]">
      <Header connected={connected} />

      <main className="flex-1 container mx-auto p-4 flex flex-col gap-4">
        <div className="flex-[3]">
          {topMarketLoading && !topMarket ? (
            <div className="space-y-4">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-[400px] w-full rounded-lg" />
            </div>
          ) : topMarketError ? (
            <Card>
              <CardContent className="flex h-[400px] items-center justify-center">
                <div className="text-center">
                  <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
                  <p className="text-red-500 mb-2 font-semibold">
                    Failed to load top market
                  </p>
                  <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md">
                    {topMarketError.message}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : !topMarket ? (
            <Card>
              <CardContent className="flex h-[400px] items-center justify-center">
                <div className="text-center">
                  <Activity className="h-12 w-12 text-[hsl(var(--muted-foreground))] mx-auto mb-4" />
                  <p className="text-[hsl(var(--muted-foreground))]">
                    No active markets found
                  </p>
                  <p className="text-sm text-[hsl(var(--muted-foreground))] mt-2">
                    Waiting for market activity...
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <ErrorBoundary>
              <CandlestickChart
                data={ohlcData?.data}
                loading={ohlcLoading || ohlcFetching}
                error={ohlcError}
                title={chartTitle}
                subtitle={chartSubtitle}
              />
            </ErrorBoundary>
          )}
        </div>

        <div className="flex-[2] min-h-[300px]">
          <TriggerTable
            events={events}
            connected={connected}
            error={streamError}
            onReconnect={reconnect}
          />
        </div>
      </main>

      <Footer />
    </div>
  );
}

export default App;
