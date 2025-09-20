export type MarketType = "spot" | "futures";

export type Interval =
  | "1s"
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteAssetVolume: number;
  numberOfTrades: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
  isClosed?: boolean;
}

export interface AggTrade {
  aggId: number;
  price: number;
  quantity: number;
  timestamp: number; // trade time in ms
  isBuyerMaker: boolean;
}

const REST_BASE = {
  spot: "https://api.binance.com",
  futures: "https://fapi.binance.com",
} as const;

const WS_BASE = {
  spot: "wss://stream.binance.com:9443/ws",
  futures: "wss://fstream.binance.com/ws",
} as const;

export async function fetchKlines(
  market: MarketType,
  symbol: string,
  interval: Interval,
  limit: number = 500
): Promise<Kline[]> {
  if (interval === "1s") {
    throw new Error(
      "fetchKlines does not support 1s. Use fetchAggTradesRange + aggregateToOneSecondKlines."
    );
  }
  const url = new URL(
    market === "spot" ? "/api/v3/klines" : "/fapi/v1/klines",
    REST_BASE[market]
  );
  url.searchParams.set("symbol", symbol.toUpperCase());
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Failed to fetch klines: ${res.status}`);
  const data: any[] = await res.json();
  return data.map((d) => mapArrayToKline(d));
}

export async function fetchKlinesByTime(
  market: MarketType,
  symbol: string,
  interval: Exclude<Interval, "1s">,
  startTimeMs: number,
  endTimeMs: number
): Promise<Kline[]> {
  const basePath = market === "spot" ? "/api/v3/klines" : "/fapi/v1/klines";
  const all: Kline[] = [];
  let cursor = startTimeMs;
  while (cursor < endTimeMs) {
    const url = new URL(basePath, REST_BASE[market]);
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endTimeMs));
    url.searchParams.set("limit", "1000");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Failed to fetch klines: ${res.status}`);
    const chunk: any[] = await res.json();
    if (chunk.length === 0) break;
    const mapped = chunk.map(mapArrayToKline);
    all.push(...mapped);
    const last = mapped[mapped.length - 1];
    cursor = Math.max(cursor + 1, last.closeTime + 1);
    if (mapped.length < 1000) break;
  }
  return all;
}

function mapArrayToKline(d: any[]): Kline {
  return {
    openTime: d[0],
    open: Number(d[1]),
    high: Number(d[2]),
    low: Number(d[3]),
    close: Number(d[4]),
    volume: Number(d[5]),
    closeTime: d[6],
    quoteAssetVolume: Number(d[7]),
    numberOfTrades: Number(d[8]),
    takerBuyBaseVolume: Number(d[9]),
    takerBuyQuoteVolume: Number(d[10]),
    isClosed: true,
  };
}

export type KlineUpdateHandler = (kline: Kline) => void;

export class KlineWebSocket {
  private ws?: WebSocket;
  private readonly url: string;
  private reconnectTimer?: number;
  private stopped: boolean = false;
  constructor(
    private market: MarketType,
    private symbol: string,
    private interval: Interval,
    private onUpdate: KlineUpdateHandler
  ) {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    this.url = `${WS_BASE[market]}/${stream}`;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = undefined;
    }
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {};
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg && msg.k) {
          const k = msg.k;
          const mapped: Kline = {
            openTime: k.t,
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
            closeTime: k.T,
            quoteAssetVolume: Number(k.q),
            numberOfTrades: Number(k.n),
            takerBuyBaseVolume: Number(k.V),
            takerBuyQuoteVolume: Number(k.Q),
            isClosed: Boolean(k.x),
          };
          this.onUpdate(mapped);
        }
      } catch (e) {
        // ignore parse errors
      }
    };
    this.ws.onclose = () => {
      if (this.stopped) return;
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {}
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.connect();
    }, 1500);
  }
}

// ---- 1s aggregation via aggTrades ----

export async function fetchAggTradesRange(
  market: MarketType,
  symbol: string,
  startTimeMs: number,
  endTimeMs: number
): Promise<AggTrade[]> {
  // Binance aggTrades max 1000 per request; we need to paginate by fromId or startTime.
  // We'll use startTime/endTime with limit=1000 and iterate windowed.
  const basePath =
    market === "spot" ? "/api/v3/aggTrades" : "/fapi/v1/aggTrades";
  let cursor = startTimeMs;
  const all: AggTrade[] = [];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const windowMs = 60_000; // 1-minute slices to reduce server load
  while (cursor < endTimeMs) {
    const url = new URL(basePath, REST_BASE[market]);
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set(
      "endTime",
      String(Math.min(cursor + windowMs, endTimeMs))
    );
    url.searchParams.set("limit", "1000");

    // Retry with exponential backoff on 429/5xx
    let attempt = 0;
    let chunk: any[] = [];
    for (;;) {
      const res = await fetch(url.toString());
      if (res.ok) {
        chunk = await res.json();
        break;
      }
      if (res.status === 429 || res.status >= 500) {
        attempt += 1;
        const backoffMs = Math.min(5000, 300 * Math.pow(2, attempt));
        await sleep(backoffMs);
        continue;
      }
      throw new Error(`Failed to fetch aggTrades: ${res.status}`);
    }
    if (chunk.length === 0) {
      cursor += windowMs; // advance window even if empty
      // small pacing delay to be nice to API
      await sleep(120);
      continue;
    }
    for (const t of chunk) {
      all.push({
        aggId: t.a,
        price: Number(t.p),
        quantity: Number(t.q),
        timestamp: t.T,
        isBuyerMaker: Boolean(t.m),
      });
    }
    // Advance cursor to last trade time + 1ms to avoid duplicates
    cursor = Math.max(cursor + 1, all[all.length - 1].timestamp + 1);
    // pace subsequent requests slightly
    await sleep(120);
  }
  return all;
}

export function aggregateToOneSecondKlines(trades: AggTrade[]): Kline[] {
  if (trades.length === 0) return [];
  const bySecond = new Map<number, AggTrade[]>();
  for (const t of trades) {
    const sec = Math.floor(t.timestamp / 1000) * 1000;
    const arr = bySecond.get(sec) ?? [];
    arr.push(t);
    bySecond.set(sec, arr);
  }
  const seconds = Array.from(bySecond.keys()).sort((a, b) => a - b);
  const klines: Kline[] = [];
  let prevClose: number | undefined;
  for (const s of seconds) {
    const arr = bySecond.get(s)!;
    arr.sort((a, b) => a.timestamp - b.timestamp);
    const open = arr[0].price;
    const close = arr[arr.length - 1].price;
    const high = Math.max(...arr.map((x) => x.price));
    const low = Math.min(...arr.map((x) => x.price));
    const volume = arr.reduce((sum, x) => sum + x.quantity, 0);
    const numTrades = arr.length;
    klines.push({
      openTime: s,
      open: prevClose ?? open,
      high,
      low,
      close,
      volume,
      closeTime: s + 999,
      quoteAssetVolume: 0,
      numberOfTrades: numTrades,
      takerBuyBaseVolume: 0,
      takerBuyQuoteVolume: 0,
      isClosed: true,
    });
    prevClose = close;
  }
  return klines;
}

export type AggTradeHandler = (trade: AggTrade) => void;

export class AggTradeWebSocket {
  private ws?: WebSocket;
  private readonly url: string;
  private reconnectTimer?: number;
  private stopped = false;
  constructor(
    private market: MarketType,
    private symbol: string,
    private onTrade: AggTradeHandler
  ) {
    const stream = `${symbol.toLowerCase()}@aggTrade`;
    this.url = `${WS_BASE[market]}/${stream}`;
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {}
    this.ws = undefined;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
  private connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        // Spot: { e: 'aggTrade', ... } Futures: similar shape
        const t: AggTrade = {
          aggId: msg.a,
          price: Number(msg.p),
          quantity: Number(msg.q),
          timestamp: msg.T,
          isBuyerMaker: Boolean(msg.m),
        };
        this.onTrade(t);
      } catch {}
    };
    this.ws.onclose = () => {
      if (!this.stopped) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {}
    };
  }
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.connect();
    }, 1500);
  }
}
