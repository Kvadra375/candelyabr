import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Kline } from "../services/binance";

export interface CandlesCanvasProps {
  data: Kline[];
  width?: number;
  height?: number;
  followLive?: boolean;
  onUserPan?: () => void;
}

export interface CandlesCanvasHandle {
  setRangeByTime: (startMs: number, endMs: number) => void;
  scrollToEnd: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  resetY: () => void;
}

function computeColorFromTrades(
  numberOfTrades: number,
  minTrades: number,
  maxTrades: number,
  isUp: boolean
): string {
  if (maxTrades <= minTrades) return "#000000";
  const ratio = Math.min(
    1,
    Math.max(0, (numberOfTrades - minTrades) / (maxTrades - minTrades))
  );
  const hue = isUp ? 130 : 0; // green for up, red for down
  const saturation = 10 + Math.floor(90 * ratio); // 10%..100%
  const lightness = 45 + Math.floor((isUp ? 10 : -10) * (1 - ratio)); // slightly brighter for up
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function CandlesCanvasImpl(
  {
    data,
    width = 900,
    height = 480,
    followLive = true,
    onUserPan,
  }: CandlesCanvasProps,
  ref: React.Ref<CandlesCanvasHandle>
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startIndexRef = useRef<number>(0);
  const visibleCountRef = useRef<number>(
    Math.min(120, Math.max(20, data.length))
  );
  const isDraggingRef = useRef<boolean>(false);
  const lastXRef = useRef<number>(0);
  const drawRef = useRef<() => void>(() => {});
  const lastMouseXRef = useRef<number>(0);
  const lastMouseYRef = useRef<number>(0);
  const yMinRef = useRef<number | null>(null);
  const yMaxRef = useRef<number | null>(null);
  const autoYRef = useRef<boolean>(true);
  const isResizingYRef = useRef<boolean>(false);
  const resizeAnchorYRef = useRef<number>(0);
  const resizeAnchorPriceRef = useRef<number>(0);
  const resizeInitialRangeRef = useRef<number>(0);
  const resizeStartMouseYRef = useRef<number>(0);
  const resizeAnchorTopRatioRef = useRef<number>(0.5);

  // Helpers available to imperative handlers and effects
  const PADDING_LEFT = 10;
  const PADDING_RIGHT = 60;
  const PADDING_TOP = 10;
  const PADDING_BOTTOM = 24;

  function clampViewportLocal() {
    const visible = Math.max(
      10,
      Math.min(data.length, visibleCountRef.current)
    );
    visibleCountRef.current = visible;
    startIndexRef.current = Math.max(
      0,
      Math.min(data.length - visible, startIndexRef.current)
    );
  }

  function performZoomGlobal(scale: number, anchorX?: number) {
    const plotWidth = width - PADDING_LEFT - PADDING_RIGHT;
    const oldVisible = visibleCountRef.current;
    const candleGap = 2;
    const oldCandleWidth = Math.max(
      1,
      Math.floor((width - PADDING_LEFT - PADDING_RIGHT) / oldVisible) -
        candleGap
    );
    const oldCandleSpan = oldCandleWidth + candleGap;
    const leftPad = PADDING_LEFT;
    const anchor = Math.max(
      leftPad,
      Math.min(
        width - PADDING_RIGHT,
        anchorX ?? leftPad + Math.floor(plotWidth / 2)
      )
    );
    const idxAtAnchor =
      startIndexRef.current + Math.round((anchor - leftPad) / oldCandleSpan);

    const targetVisible = Math.round(oldVisible * scale);
    visibleCountRef.current = Math.max(10, Math.min(5000, targetVisible));

    const newCandleWidth = Math.max(
      1,
      Math.floor(
        (width - PADDING_LEFT - PADDING_RIGHT) / visibleCountRef.current
      ) - candleGap
    );
    const newCandleSpan = newCandleWidth + candleGap;
    const newStart = Math.round(
      idxAtAnchor - (anchor - leftPad) / newCandleSpan
    );
    startIndexRef.current = newStart;
    clampViewportLocal();
    drawRef.current();
  }

  useEffect(() => {
    // Snap viewport to the latest only if following or already at end
    const visibleCount = visibleCountRef.current;
    const atEnd =
      startIndexRef.current + visibleCount >=
      Math.max(visibleCount, data.length - 1);
    if (followLive || atEnd) {
      startIndexRef.current = Math.max(0, data.length - visibleCount);
    }
  }, [data.length, followLive]);

  useImperativeHandle(ref, () => ({
    setRangeByTime(startMs: number, endMs: number) {
      if (!data || data.length === 0) return;
      if (endMs <= startMs) return;
      let startIdx = 0;
      let endIdx = data.length - 1;
      // start index (first openTime >= startMs)
      let lo = 0,
        hi = data.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (data[mid].openTime < startMs) lo = mid + 1;
        else hi = mid - 1;
      }
      startIdx = Math.min(Math.max(0, lo), data.length - 1);
      // end index (last openTime <= endMs)
      lo = 0;
      hi = data.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (data[mid].openTime <= endMs) lo = mid + 1;
        else hi = mid - 1;
      }
      endIdx = Math.min(Math.max(0, lo - 1), data.length - 1);
      const count = Math.max(10, endIdx - startIdx + 1);
      visibleCountRef.current = count;
      startIndexRef.current = Math.max(
        0,
        Math.min(startIdx, Math.max(0, data.length - count))
      );
      drawRef.current();
    },
    scrollToEnd() {
      const visibleCount = visibleCountRef.current;
      startIndexRef.current = Math.max(0, data.length - visibleCount);
      drawRef.current();
    },
    zoomIn() {
      performZoomGlobal(0.85, undefined);
    },
    zoomOut() {
      performZoomGlobal(1.15, undefined);
    },
    resetView() {
      visibleCountRef.current = Math.min(120, Math.max(20, data.length));
      startIndexRef.current = Math.max(
        0,
        data.length - visibleCountRef.current
      );
      autoYRef.current = true;
      yMinRef.current = null;
      yMaxRef.current = null;
      drawRef.current();
    },
    resetY() {
      autoYRef.current = true;
      yMinRef.current = null;
      yMaxRef.current = null;
      drawRef.current();
    },
  }));

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const ctxRaw = canvasEl.getContext("2d");
    if (!ctxRaw) return;
    const ctx = ctxRaw as CanvasRenderingContext2D;

    const paddingLeft = PADDING_LEFT;
    const paddingRight = PADDING_RIGHT;
    const paddingTop = PADDING_TOP;
    const paddingBottom = PADDING_BOTTOM;

    function draw() {
      const plotWidth = width - paddingLeft - paddingRight;
      const plotHeight = height - paddingTop - paddingBottom;

      ctx.clearRect(0, 0, canvasEl!.width, canvasEl!.height);
      if (!data || data.length === 0) return;

      const startIndex = startIndexRef.current;
      const visibleCount = Math.max(
        10,
        Math.min(data.length, visibleCountRef.current)
      );
      const endIndex = Math.min(data.length, startIndex + visibleCount);
      const viewData = data.slice(startIndex, endIndex);

      const highs = viewData.map((d) => d.high);
      const lows = viewData.map((d) => d.low);
      const dataMax = Math.max(...highs);
      const dataMin = Math.min(...lows);
      let minPrice = dataMin;
      let maxPrice = dataMax;
      if (
        !autoYRef.current &&
        yMinRef.current != null &&
        yMaxRef.current != null
      ) {
        minPrice = yMinRef.current;
        maxPrice = yMaxRef.current;
        if (maxPrice <= minPrice) {
          maxPrice = minPrice + 1e-9;
        }
      } else {
        // small padding
        const pad = (dataMax - dataMin) * 0.05 || 1;
        minPrice = dataMin - pad;
        maxPrice = dataMax + pad;
      }

      const maxTrades = Math.max(...viewData.map((d) => d.numberOfTrades));
      const minTrades = Math.min(...viewData.map((d) => d.numberOfTrades));

      const toY = (price: number) =>
        paddingTop +
        (maxPrice - price) * (plotHeight / (maxPrice - minPrice || 1));

      // Grid
      ctx.strokeStyle = "#e5e5e5";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) {
        const y = paddingTop + (i * plotHeight) / 4;
        ctx.moveTo(paddingLeft, y);
        ctx.lineTo(width - paddingRight, y);
      }
      ctx.stroke();

      // Right price scale background
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(
        width - paddingRight,
        paddingTop,
        paddingRight - 1,
        plotHeight
      );
      ctx.strokeStyle = "#e5e5e5";
      ctx.beginPath();
      ctx.moveTo(width - paddingRight + 0.5, paddingTop);
      ctx.lineTo(width - paddingRight + 0.5, height - paddingBottom);
      ctx.stroke();

      // Left price scale background
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(0, paddingTop, paddingLeft - 1, plotHeight);
      ctx.strokeStyle = "#e5e5e5";
      ctx.beginPath();
      ctx.moveTo(paddingLeft - 0.5, paddingTop);
      ctx.lineTo(paddingLeft - 0.5, height - paddingBottom);
      ctx.stroke();

      // Y axis labels (right)
      ctx.fillStyle = "#666";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      for (let i = 0; i <= 4; i++) {
        const price = maxPrice - (i * (maxPrice - minPrice)) / 4;
        const y = paddingTop + (i * plotHeight) / 4;
        ctx.fillText(price.toFixed(2), width - paddingRight + 6, y + 4);
      }
      // Y axis labels (left)
      ctx.textAlign = "right";
      for (let i = 0; i <= 4; i++) {
        const price = maxPrice - (i * (maxPrice - minPrice)) / 4;
        const y = paddingTop + (i * plotHeight) / 4;
        ctx.fillText(price.toFixed(2), paddingLeft - 6, y + 4);
      }

      // Candles
      const candleGap = 2;
      const candleWidth = Math.max(
        1,
        Math.floor((width - paddingLeft - paddingRight) / visibleCount) -
          candleGap
      );
      const leftPad = paddingLeft;

      // X axis baseline
      ctx.strokeStyle = "#ddd";
      ctx.beginPath();
      ctx.moveTo(paddingLeft, height - paddingBottom + 0.5);
      ctx.lineTo(width - paddingRight, height - paddingBottom + 0.5);
      ctx.stroke();

      viewData.forEach((k, idx) => {
        const x = leftPad + idx * (candleWidth + candleGap);
        const yOpen = toY(k.open);
        const yClose = toY(k.close);
        const yHigh = toY(k.high);
        const yLow = toY(k.low);
        const isUp = k.close >= k.open;
        const color = computeColorFromTrades(
          k.numberOfTrades,
          minTrades,
          maxTrades,
          isUp
        );

        // Wick
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x + Math.floor(candleWidth / 2), yHigh);
        ctx.lineTo(x + Math.floor(candleWidth / 2), yLow);
        ctx.stroke();

        // Body
        ctx.fillStyle = color;
        const top = Math.min(yOpen, yClose);
        const bottom = Math.max(yOpen, yClose);
        const h = Math.max(1, bottom - top);
        ctx.fillRect(x, top, candleWidth, h);
        ctx.strokeStyle = color;
        ctx.strokeRect(x, top, candleWidth, h);
      });

      // Time ticks and labels
      if (viewData.length > 0) {
        const firstTs = viewData[0].openTime;
        const lastTs = viewData[viewData.length - 1].openTime;
        const spanMs = Math.max(1, lastTs - firstTs);
        const pixelsPerCandle = candleWidth + candleGap;
        const desiredPx = 80;
        const stepCandles = Math.max(
          1,
          Math.round(desiredPx / Math.max(1, pixelsPerCandle))
        );

        const format = (ts: number) => {
          const d = new Date(ts);
          if (spanMs <= 2 * 60 * 60 * 1000) {
            return d.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
          }
          if (spanMs <= 2 * 24 * 60 * 60 * 1000) {
            return d.toLocaleString(undefined, {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
          }
          return d.toLocaleDateString();
        };

        ctx.fillStyle = "#555";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        for (let i = 0; i < viewData.length; i += stepCandles) {
          const k = viewData[i];
          const xCenter =
            leftPad +
            i * (candleWidth + candleGap) +
            Math.floor(candleWidth / 2);
          ctx.strokeStyle = "#e5e5e5";
          ctx.beginPath();
          ctx.moveTo(xCenter + 0.5, height - paddingBottom + 1);
          ctx.lineTo(xCenter + 0.5, height - paddingBottom + 6);
          ctx.stroke();
          ctx.fillText(format(k.openTime), xCenter, height - paddingBottom + 8);
        }
      }
    }
    drawRef.current = draw;

    function clampViewport() {
      clampViewportLocal();
    }

    // Zoom handled by global helper

    function handleWheel(ev: WheelEvent) {
      ev.preventDefault();
      const offsetX = (ev as any).offsetX ?? 0;
      const offsetY = (ev as any).offsetY ?? 0;
      lastMouseXRef.current = offsetX;
      lastMouseYRef.current = offsetY;
      const zoomOut = ev.deltaY > 0;
      if (ev.altKey) {
        // Vertical zoom around mouse Y
        autoYRef.current = false;
        const plotHeight = height - paddingTop - paddingBottom;
        const yRel = Math.max(0, Math.min(plotHeight, offsetY - paddingTop));
        // Convert y to price with current scale
        const currentMin = yMinRef.current ?? null;
        const currentMax = yMaxRef.current ?? null;
        // Derive current price bounds used in last draw by recomputing from viewData
        const startIndex = startIndexRef.current;
        const visibleCount = Math.max(
          10,
          Math.min(data.length, visibleCountRef.current)
        );
        const endIndex = Math.min(data.length, startIndex + visibleCount);
        const viewData = data.slice(startIndex, endIndex);
        const highs = viewData.map((d) => d.high);
        const lows = viewData.map((d) => d.low);
        const dataMax = Math.max(...highs);
        const dataMin = Math.min(...lows);
        let minPrice = currentMin ?? dataMin;
        let maxPrice = currentMax ?? dataMax;
        if (maxPrice <= minPrice) maxPrice = minPrice + 1e-9;
        const priceAtCursor =
          maxPrice - (yRel / (plotHeight || 1)) * (maxPrice - minPrice);
        const vScale = zoomOut ? 1.15 : 0.85;
        const newRange = (maxPrice - minPrice) * vScale;
        const ratioTop =
          (maxPrice - priceAtCursor) / (maxPrice - minPrice || 1);
        const ratioBottom = 1 - ratioTop;
        const newMax = priceAtCursor + newRange * ratioTop;
        const newMin = priceAtCursor - newRange * ratioBottom;
        yMinRef.current = newMin;
        yMaxRef.current = newMax;
        draw();
      } else {
        // Horizontal zoom
        const scale = zoomOut ? 1.15 : 0.85;
        const modifier = ev.shiftKey ? 1.35 : ev.ctrlKey ? 0.9 : 1.0;
        performZoomGlobal(scale * modifier, lastMouseXRef.current);
      }
    }

    function handleMouseDown(ev: MouseEvent) {
      isDraggingRef.current = true;
      lastXRef.current = ev.clientX;
      lastMouseYRef.current = ev.clientY;
      // Start Y resize if within RIGHT axis area
      const rect = canvasEl!.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (x >= width - paddingRight) {
        const plotHeight = height - paddingTop - paddingBottom;
        const startIndex = startIndexRef.current;
        const visibleCount = Math.max(
          10,
          Math.min(data.length, visibleCountRef.current)
        );
        const endIndex = Math.min(data.length, startIndex + visibleCount);
        const viewData = data.slice(startIndex, endIndex);
        if (viewData.length > 0) {
          const highs = viewData.map((d) => d.high);
          const lows = viewData.map((d) => d.low);
          const dataMax = Math.max(...highs);
          const dataMin = Math.min(...lows);
          let minPrice = yMinRef.current ?? dataMin;
          let maxPrice = yMaxRef.current ?? dataMax;
          if (maxPrice <= minPrice) maxPrice = minPrice + 1e-9;
          autoYRef.current = false;
          isResizingYRef.current = true;
          resizeStartMouseYRef.current = ev.clientY;
          resizeAnchorYRef.current = Math.max(
            0,
            Math.min(plotHeight, y - paddingTop)
          );
          resizeInitialRangeRef.current = maxPrice - minPrice;
          const priceAtCursor =
            maxPrice -
            (resizeAnchorYRef.current / (plotHeight || 1)) *
              (maxPrice - minPrice);
          resizeAnchorPriceRef.current = priceAtCursor;
          const range = maxPrice - minPrice || 1;
          resizeAnchorTopRatioRef.current = (maxPrice - priceAtCursor) / range;
          // visual cursor
          if (canvasRef.current) canvasRef.current.style.cursor = "ns-resize";
        }
      }
      onUserPan?.();
    }

    function handleMouseMove(ev: MouseEvent) {
      if (!isDraggingRef.current) return;
      const dx = ev.clientX - lastXRef.current;
      const dy = ev.clientY - (lastMouseYRef.current || ev.clientY);
      lastXRef.current = ev.clientX;
      lastMouseYRef.current = ev.clientY;
      // If resizing Y via left axis drag
      if (isResizingYRef.current) {
        const dyTotal = ev.clientY - resizeStartMouseYRef.current;
        const k = Math.exp(dyTotal * 0.002); // smoother scale factor based on total drag
        const newRange = Math.max(1e-9, resizeInitialRangeRef.current * k);
        const ratioTop = resizeAnchorTopRatioRef.current;
        const ratioBottom = 1 - ratioTop;
        const newMax = resizeAnchorPriceRef.current + newRange * ratioTop;
        const newMin = resizeAnchorPriceRef.current - newRange * ratioBottom;
        yMinRef.current = newMin;
        yMaxRef.current = newMax;
        draw();
        return;
      }
      // When not resizing: skip hover cursor update
      // Vertical pan always enabled on drag
      if (dy !== 0) {
        autoYRef.current = false;
        const startIndex = startIndexRef.current;
        const visibleCount = Math.max(
          10,
          Math.min(data.length, visibleCountRef.current)
        );
        const endIndex = Math.min(data.length, startIndex + visibleCount);
        const viewData = data.slice(startIndex, endIndex);
        const highs = viewData.map((d) => d.high);
        const lows = viewData.map((d) => d.low);
        const dataMax = Math.max(...highs);
        const dataMin = Math.min(...lows);
        let minPrice = yMinRef.current ?? dataMin;
        let maxPrice = yMaxRef.current ?? dataMax;
        if (maxPrice <= minPrice) maxPrice = minPrice + 1e-9;
        const plotHeight = height - paddingTop - paddingBottom;
        const pricePerPx = (maxPrice - minPrice) / (plotHeight || 1);
        const deltaPrice = dy * pricePerPx;
        yMinRef.current = (yMinRef.current ?? minPrice) + deltaPrice;
        yMaxRef.current = (yMaxRef.current ?? maxPrice) + deltaPrice;
      }
      const candleGap = 2;
      const candleWidth = Math.max(
        1,
        Math.floor(
          (width - paddingLeft - paddingRight) / visibleCountRef.current
        ) - candleGap
      );
      const perCandle = Math.max(1, candleWidth + candleGap);
      const deltaCandles = Math.round(-dx / perCandle);
      if (deltaCandles !== 0) {
        startIndexRef.current += deltaCandles;
        clampViewport();
      }
      draw();
    }

    function handleMouseUp() {
      isDraggingRef.current = false;
      isResizingYRef.current = false;
      // stop any X resize mode (future use)
      // isResizingXRef not used; reserved for time axis resize implementation
      if (canvasRef.current) canvasRef.current.style.cursor = "grab";
    }

    // Initial clamp and draw
    clampViewport();
    draw();

    // Events
    canvasEl!.addEventListener("wheel", handleWheel, { passive: false });
    canvasEl!.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    canvasEl!.addEventListener("mouseleave", handleMouseUp);

    return () => {
      canvasEl!.removeEventListener("wheel", handleWheel as EventListener);
      canvasEl!.removeEventListener(
        "mousedown",
        handleMouseDown as EventListener
      );
      window.removeEventListener("mousemove", handleMouseMove as EventListener);
      window.removeEventListener("mouseup", handleMouseUp as EventListener);
      canvasEl!.removeEventListener(
        "mouseleave",
        handleMouseUp as EventListener
      );
    };
  }, [data, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        border: "1px solid #ddd",
        background: "#fff",
        cursor: "grab",
      }}
      onMouseDown={() => {
        // Visual cursor feedback
        if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
      }}
      onMouseUp={() => {
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      }}
      onMouseLeave={() => {
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      }}
    />
  );
}

const CandlesCanvas = forwardRef<CandlesCanvasHandle, CandlesCanvasProps>(
  CandlesCanvasImpl
);
export default CandlesCanvas;
