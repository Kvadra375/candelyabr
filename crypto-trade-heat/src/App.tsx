import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import CandlesCanvas, {
  type CandlesCanvasHandle,
} from "./components/CandlesCanvas";
import {
  KlineWebSocket,
  fetchKlines,
  type Interval,
  type Kline,
  type MarketType,
  AggTradeWebSocket,
  fetchAggTradesRange,
  aggregateToOneSecondKlines,
  fetchKlinesByTime,
} from "./services/binance";

const DEFAULT_SYMBOL = "BTCUSDT";
const INTERVALS: Interval[] = ["1s", "1m", "5m", "15m", "1h", "4h", "1d"];

type RangeKey = "1h" | "24h" | "7d";
const RANGE_TO_MS: Record<RangeKey, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function App() {
  const [market, setMarket] = useState<MarketType>("spot");
  const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [interval, setInterval] = useState<Interval>("1m");
  const [range, setRange] = useState<RangeKey>("7d");
  const [data, setData] = useState<Kline[]>([]);
  const [follow, setFollow] = useState<boolean>(true);
  const [fromISO, setFromISO] = useState<string>("");
  const [toISO, setToISO] = useState<string>("");
  const wsRef = useRef<KlineWebSocket | null>(null);
  const aggWsRef = useRef<AggTradeWebSocket | null>(null);
  const canvasRef = useRef<CandlesCanvasHandle | null>(null);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load history
  useEffect(() => {
    let isCancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        if (interval === "1s") {
          const now = Date.now();
          const start = now - RANGE_TO_MS[range];
          const trades = await fetchAggTradesRange(market, symbol, start, now);
          const kl = aggregateToOneSecondKlines(trades);
          if (!isCancelled) setData(kl);
        } else {
          const kl = await fetchKlines(market, symbol, interval, 1000);
          if (!isCancelled) setData(kl);
        }
      } catch (e) {
        if (!isCancelled) setError(String(e));
      } finally {
        if (!isCancelled) setLoading(false);
      }
    }

    load();
    return () => {
      isCancelled = true;
    };
  }, [market, symbol, interval, range]);

  // Live updates
  useEffect(() => {
    // Stop previous
    wsRef.current?.stop();
    aggWsRef.current?.stop();

    if (interval === "1s") {
      // aggTrade stream -> aggregate into current second
      const ws = new AggTradeWebSocket(market, symbol, (t) => {
        const sec = Math.floor(t.timestamp / 1000) * 1000;
        setData((prev) => {
          if (prev.length === 0) {
            return [
              {
                openTime: sec,
                open: t.price,
                high: t.price,
                low: t.price,
                close: t.price,
                volume: t.quantity,
                closeTime: sec + 999,
                quoteAssetVolume: 0,
                numberOfTrades: 1,
                takerBuyBaseVolume: 0,
                takerBuyQuoteVolume: 0,
                isClosed: false,
              },
            ];
          }
          const last = prev[prev.length - 1];
          if (last.openTime === sec) {
            // Update current second
            const updated: Kline = {
              ...last,
              high: Math.max(last.high, t.price),
              low: Math.min(last.low, t.price),
              close: t.price,
              volume: last.volume + t.quantity,
              numberOfTrades: last.numberOfTrades + 1,
              isClosed: false,
            };
            const copy = prev.slice(0, prev.length - 1);
            copy.push(updated);
            return copy;
          } else if (sec > last.openTime) {
            // Close previous second and start a new one
            const newCandle: Kline = {
              openTime: sec,
              open: last.close,
              high: t.price,
              low: t.price,
              close: t.price,
              volume: t.quantity,
              closeTime: sec + 999,
              quoteAssetVolume: 0,
              numberOfTrades: 1,
              takerBuyBaseVolume: 0,
              takerBuyQuoteVolume: 0,
              isClosed: false,
            };
            return [...prev, newCandle];
          }
          return prev;
        });
      });
      ws.start();
      aggWsRef.current = ws;
      return () => ws.stop();
    } else {
      const ws = new KlineWebSocket(market, symbol, interval, (k) => {
        setData((prev) => {
          if (prev.length === 0) return [k];
          const last = prev[prev.length - 1];
          if (k.openTime === last.openTime) {
            const copy = prev.slice(0, prev.length - 1);
            copy.push(k);
            return copy;
          }
          const next = [...prev, k];
          if (next.length > 2000) next.shift();
          return next;
        });
      });
      ws.start();
      wsRef.current = ws;
      return () => ws.stop();
    }
  }, [market, symbol, interval]);

  const title = useMemo(
    () => `${market.toUpperCase()} ${symbol} ${interval}`,
    [market, symbol, interval]
  );

  return (
    <div className="app-root">
      <div className="toolbar">
        <strong>Crypto Trade Heat</strong>
        <label>
          Market:
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value as MarketType)}
            style={{ marginLeft: 8 }}
          >
            <option value="spot">Spot</option>
            <option value="futures">Futures (USDT-M)</option>
          </select>
        </label>
        <label>
          Symbol:
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            style={{ marginLeft: 8 }}
            placeholder="e.g. BTCUSDT"
          />
        </label>
        <label>
          Interval:
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value as Interval)}
            style={{ marginLeft: 8 }}
          >
            {INTERVALS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        {interval === "1s" && (
          <label>
            Range:
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as RangeKey)}
              style={{ marginLeft: 8 }}
            >
              <option value="1h">1h</option>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
            </select>
          </label>
        )}
        <label>
          Follow live:
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            style={{ marginLeft: 8 }}
          />
        </label>
        <button onClick={() => canvasRef.current?.scrollToEnd()}>
          Jump to latest
        </button>
        <span style={{ color: "#888" }}>{title}</span>
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <span>Jump to range:</span>
        <input
          type="datetime-local"
          value={fromISO}
          onChange={(e) => setFromISO(e.target.value)}
        />
        <input
          type="datetime-local"
          value={toISO}
          onChange={(e) => setToISO(e.target.value)}
        />
        <button
          onClick={async () => {
            const from = fromISO ? Date.parse(fromISO) : NaN;
            const to = toISO ? Date.parse(toISO) : NaN;
            if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
              return;
            if (interval === "1s") {
              setLoading(true);
              setError(null);
              try {
                const trades = await fetchAggTradesRange(
                  market,
                  symbol,
                  from,
                  to
                );
                const kl = aggregateToOneSecondKlines(trades);
                setData(kl);
              } catch (e) {
                setError(String(e));
              } finally {
                setLoading(false);
              }
            } else {
              setLoading(true);
              setError(null);
              try {
                const kl = await fetchKlinesByTime(
                  market,
                  symbol,
                  interval === "1s" ? ("1m" as any) : interval,
                  from,
                  to
                );
                setData(kl);
              } catch (e) {
                setError(String(e));
              } finally {
                setLoading(false);
              }
            }
            setFollow(false);
            wsRef.current?.stop();
            aggWsRef.current?.stop();
          }}
        >
          Go
        </button>
      </div>
      {error && (
        <div style={{ color: "#b00020", marginBottom: 8 }}>Error: {error}</div>
      )}
      {loading && (
        <div style={{ color: "#666", marginBottom: 8 }}>Loading...</div>
      )}
      {interval === "1s" && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            padding: "0 16px",
          }}
        >
          <button
            disabled={loadingOlder}
            onClick={async () => {
              if (data.length === 0) return;
              setLoadingOlder(true);
              setError(null);
              try {
                const first = data[0].openTime;
                const minutes = 30; // load 30 minutes per click
                const end = first - 1;
                const start = end - minutes * 60 * 1000 + 1;
                const trades = await fetchAggTradesRange(
                  market,
                  symbol,
                  start,
                  end
                );
                const older = aggregateToOneSecondKlines(trades);
                setData((prev) => older.concat(prev));
              } catch (e) {
                setError(String(e));
              } finally {
                setLoadingOlder(false);
              }
            }}
          >
            {loadingOlder ? "Loading older..." : "Load older 30m (1s)"}
          </button>
        </div>
      )}
      <div className="chart-wrap">
        <CandlesCanvas
          ref={canvasRef}
          data={data}
          width={window.innerWidth}
          height={Math.max(300, window.innerHeight - 160)}
          followLive={follow}
          onUserPan={() => setFollow(false)}
        />
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button onClick={() => canvasRef.current?.zoomIn()}>Zoom In</button>
        <button onClick={() => canvasRef.current?.zoomOut()}>Zoom Out</button>
        <button onClick={() => canvasRef.current?.resetView()}>Reset</button>
        <button onClick={() => canvasRef.current?.resetY()}>Reset Y</button>
      </div>
      <div style={{ marginTop: 8, color: "#666" }}>
        1s режим строится из aggTrades; можно смотреть до 7 дней истории.
      </div>
    </div>
  );
}

export default App;
