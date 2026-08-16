import { useCallback, useEffect, useRef, useState } from "react";
import {
  Aperture,
  Camera,
  Circle,
  Copy,
  Download,
  FlipHorizontal2,
  Lightbulb,
  NotebookText,
  ScanSearch,
  Share2,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type ActivityEntry,
  formatEntryLine,
  formatLogTime,
  formatSpots,
  loadActivityLog,
  regionLabel,
  saveActivityLog,
} from "@/lib/activity-log";
import { cn } from "@/lib/utils";

type Facing = "user" | "environment";
type Phase = "idle" | "requesting" | "live" | "denied" | "missing";
type Clip = { id: string; url: string; at: number; duration: number; ext: string; blob: Blob };
type Spot = { x: number; y: number; r: number; score: number };

const SAMPLE_W = 160;
const SAMPLE_H = 90;
const LOG_GAP_MS = 1800;
const LOG_HOLD_MS = 320;
const EDGE = 0.05;

function isIOS() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function irTint(r: number, g: number, b: number) {
  return Math.max(0, (r + b) / 2 - g);
}

function scorePixel(r: number, g: number, b: number) {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mag = irTint(r, g, b);
  const warm = (r + g) / 2 - b;
  if (luma < 70) return 0;
  // IR LEDs on phone CMOS: bright + magenta / G-drop. Lamps are warm yellow.
  let s = luma * 0.45 + mag * 2.2;
  if (mag < 12) s *= 0.12;
  else if (mag < 20) s *= 0.45;
  if (warm > 24 && mag < 22) s *= 0.18;
  if (b + 18 < r && b + 18 < g) s *= 0.2;
  return s;
}

function findSpots(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number,
): Spot[] {
  const visited = new Uint8Array(w * h);
  const spots: Spot[] = [];
  const idx = (x: number, y: number) => (y * w + x) * 4;

  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      const i = y * w + x;
      if (visited[i]) continue;
      const p = idx(x, y);
      const r0 = data[p];
      const g0 = data[p + 1];
      const b0 = data[p + 2];
      if (irTint(r0, g0, b0) < 12) continue;
      const s = scorePixel(r0, g0, b0);
      if (s < threshold) continue;

      let sumX = 0;
      let sumY = 0;
      let count = 0;
      let magSum = 0;
      let maxS = s;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack = [i];
      visited[i] = 1;

      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % w;
        const cy = (cur / w) | 0;
        const cp = idx(cx, cy);
        const cr = data[cp];
        const cg = data[cp + 1];
        const cb = data[cp + 2];
        const cs = scorePixel(cr, cg, cb);
        if (cs < threshold * 0.9 || irTint(cr, cg, cb) < 10) continue;
        sumX += cx;
        sumY += cy;
        magSum += irTint(cr, cg, cb);
        count++;
        if (cs > maxS) maxS = cs;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
          const ni = ny * w + nx;
          if (visited[ni]) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }

      if (count < 2 || count > 28) continue;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw > 8 || bh > 8) continue;
      const nx = sumX / count / w;
      const ny = sumY / count / h;
      if (nx < EDGE || nx > 1 - EDGE || ny < EDGE || ny > 1 - EDGE) continue;
      if (magSum / count < 14) continue;

      spots.push({
        x: nx,
        y: ny,
        r: Math.min(16, 3 + Math.sqrt(count) * 1.2),
        score: maxS,
      });
    }
  }

  spots.sort((a, b) => b.score - a.score);
  return spots.slice(0, 4);
}

function pickRecorderMime() {
  const ios = isIOS();
  const types = ios
    ? ["video/mp4", "video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
}

function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function saveClipFile(clip: Clip) {
  const type = clip.blob.type || (clip.ext === "mp4" ? "video/mp4" : "video/webm");
  const file = new File([clip.blob], `ir-sight-${clip.id}.${clip.ext}`, { type });
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: "IR Sight clip" });
    return;
  }
  const url = URL.createObjectURL(clip.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function IrScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const composeRef = useRef<HTMLCanvasElement>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const enhanceRefCanvas = useRef<HTMLCanvasElement | null>(null);
  const thumbRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef(0);
  const recordStartedRef = useRef(0);
  const lastLogRef = useRef({
    at: 0,
    peak: 0,
    sources: 0,
    quiet: true,
    event: "e1",
    x: 0.5,
    y: 0.5,
    holdAt: 0,
  });
  const eventSeqRef = useRef(1);
  const facingRef = useRef<Facing>("user");
  const headingRef = useRef<number | null>(null);
  const recordingRef = useRef(false);
  const releasingRef = useRef(false);
  const lastUiRef = useRef(0);
  const thresholdRef = useRef(200);
  const enhanceOnRef = useRef(true);
  const clipsRef = useRef<Clip[]>([]);
  const logDiagRef = useRef<(kind: "boot" | "error" | "diag", note: string, extra?: string) => void>(
    () => {},
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [facing, setFacing] = useState<Facing>("user");
  const [threshold, setThreshold] = useState(200);
  const [enhance, setEnhance] = useState(true);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [peak, setPeak] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recTick, setRecTick] = useState(0);
  const [clips, setClips] = useState<Clip[]>([]);
  const [log, setLog] = useState<ActivityEntry[]>([]);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [lastDiag, setLastDiag] = useState<string | null>(null);
  const [saveHint, setSaveHint] = useState<string | null>(null);

  thresholdRef.current = threshold;
  enhanceOnRef.current = enhance;
  facingRef.current = facing;
  clipsRef.current = clips;
  recordingRef.current = recording;

  const postLog = useCallback((payload: Record<string, unknown>) => {
    try {
      const root = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
      void fetch(`${root}api/ir-log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          at: Date.now(),
          peak: 0,
          sources: 0,
          facing: facingRef.current,
          ...payload,
        }),
        keepalive: true,
      });
    } catch {
      /* still kept locally */
    }
  }, []);

  const logDiag = useCallback(
    (kind: "boot" | "error" | "diag", note: string, extra = "") => {
      setLastDiag(`${note}${extra ? ` · ${extra}` : ""}`);
      postLog({ kind, note, extra, event: lastLogRef.current.event });
    },
    [postLog],
  );
  logDiagRef.current = logDiag;

  useEffect(() => {
    setLog(loadActivityLog());
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const extra = [
      `ua=${ua.replace(/,/g, " ")}`,
      `view=${typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "-"}`,
      `secure=${typeof window !== "undefined" && window.isSecureContext ? 1 : 0}`,
    ].join(" ");
    logDiagRef.current("boot", "app-open", extra);
    const onErr = (ev: ErrorEvent) => {
      logDiagRef.current("error", "window-error", `${ev.message} @${ev.filename}:${ev.lineno}`);
    };
    const onRej = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
      logDiagRef.current("error", "unhandled-rejection", reason.slice(0, 180));
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  useEffect(() => {
    const onOrient = (e: DeviceOrientationEvent) => {
      if (typeof e.alpha === "number") headingRef.current = e.alpha;
    };
    window.addEventListener("deviceorientation", onOrient);
    return () => window.removeEventListener("deviceorientation", onOrient);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setRecTick(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [recording]);

  const appendLog = useCallback(
    (entry: ActivityEntry) => {
      setLog((prev) => {
        const next = [entry, ...prev].slice(0, 80);
        saveActivityLog(next);
        return next;
      });
      postLog({
        at: entry.at,
        kind: "hit",
        event: entry.event,
        peak: entry.peak,
        sources: entry.sources,
        facing: entry.facing,
        threshold: entry.threshold,
        spots: entry.spots,
        note: entry.note,
        extra: entry.extra,
      });
    },
    [postLog],
  );

  const captureThumb = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return "";
    if (!thumbRef.current) thumbRef.current = document.createElement("canvas");
    const c = thumbRef.current;
    const w = 320;
    const h = Math.max(1, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * w));
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    if (facingRef.current === "user") {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    const overlay = overlayRef.current;
    if (overlay) ctx.drawImage(overlay, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.72);
  }, []);

  const maybeLogActivity = useCallback(
    (
      found: Spot[],
      maxScore: number,
      stats: { luma: number; ir: number; room: number; vw: number; vh: number },
    ) => {
      const now = Date.now();
      const irOk = stats.ir >= 22;
      const active = found.length > 0 && irOk && maxScore >= thresholdRef.current * 0.88;
      if (!active) {
        lastLogRef.current.quiet = true;
        lastLogRef.current.holdAt = 0;
        return;
      }
      const cx = found.reduce((s, p) => s + p.x, 0) / found.length;
      const cy = found.reduce((s, p) => s + p.y, 0) / found.length;
      const last = lastLogRef.current;
      const samePlace = Math.hypot(cx - last.x, cy - last.y) < 0.1;
      if (!samePlace || last.quiet) {
        last.holdAt = now;
        last.x = cx;
        last.y = cy;
        last.quiet = false;
        return;
      }
      if (now - last.holdAt < LOG_HOLD_MS) return;
      if (now - last.at < LOG_GAP_MS) return;

      if (now - last.at > 4000) {
        eventSeqRef.current += 1;
      }
      const event = `e${eventSeqRef.current}`;
      const note = regionLabel(found);
      const dt = last.at ? now - last.at : 0;
      const hd = headingRef.current;
      const extra = [
        `luma=${Math.round(stats.luma)}`,
        `ir=${Math.round(stats.ir)}`,
        `room=${Math.round(stats.room)}`,
        `rec=${recordingRef.current ? 1 : 0}`,
        `dt=${dt}`,
        `hd=${hd == null ? "-" : Math.round(hd)}`,
        `frame=${stats.vw}x${stats.vh}`,
      ].join(" ");
      lastLogRef.current = {
        at: now,
        peak: maxScore,
        sources: found.length,
        quiet: false,
        event,
        x: cx,
        y: cy,
        holdAt: last.holdAt,
      };
      appendLog({
        id: `${now}-${Math.round(maxScore)}`,
        at: now,
        peak: Math.round(maxScore),
        sources: found.length,
        facing: facingRef.current,
        thumb: captureThumb(),
        event,
        threshold: thresholdRef.current,
        spots: formatSpots(found),
        note,
        extra,
      });
    },
    [appendLog, captureThumb],
  );

  const releaseCapture = () => {
    captureStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    captureStreamRef.current = null;
  };

  const stopRecorder = useCallback(() => {
    const rec = recorderRef.current;
    const wasRecording = Boolean(rec && rec.state !== "inactive");
    if (rec && rec.state !== "inactive") {
      try {
        rec.requestData();
      } catch {
        /* not all browsers */
      }
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    setRecording(false);
    if (wasRecording) {
      postLog({
        at: Date.now(),
        kind: "record",
        event: lastLogRef.current.event,
        peak: 0,
        sources: 0,
        facing: facingRef.current,
        threshold: thresholdRef.current,
        spots: "",
        note: "record-stop",
      });
    }
  }, [postLog]);

  const stopStream = useCallback(() => {
    stopRecorder();
    cancelAnimationFrame(rafRef.current);
    const video = videoRef.current;
    const stream = streamRef.current;
    streamRef.current = null;
    if (video) video.srcObject = null;
    stream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
  }, [stopRecorder]);

  const loop = useCallback(() => {
    try {
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (!video || !overlay || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      if (!sampleRef.current) {
        sampleRef.current = document.createElement("canvas");
        sampleRef.current.width = SAMPLE_W;
        sampleRef.current.height = SAMPLE_H;
      }
      if (!enhanceRefCanvas.current) {
        enhanceRefCanvas.current = document.createElement("canvas");
        enhanceRefCanvas.current.width = SAMPLE_W;
        enhanceRefCanvas.current.height = SAMPLE_H;
      }

      const sample = sampleRef.current;
      const sctx = sample.getContext("2d", { willReadFrequently: true });
      const octx = overlay.getContext("2d");
      if (!sctx || !octx) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (overlay.width !== vw || overlay.height !== vh) {
        overlay.width = vw;
        overlay.height = vh;
      }

      sctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      const image = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
      let maxScore = 0;
      let maxLuma = 0;
      let maxIr = 0;
      let lumaSum = 0;
      let lumaN = 0;
      let found: Spot[] = [];
      try {
        for (let i = 0; i < image.data.length; i += 16) {
          const r = image.data[i];
          const g = image.data[i + 1];
          const b = image.data[i + 2];
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const ir = irTint(r, g, b);
          const sc = scorePixel(r, g, b);
          if (sc > maxScore) maxScore = sc;
          if (luma > maxLuma) maxLuma = luma;
          if (ir > maxIr) maxIr = ir;
          lumaSum += luma;
          lumaN += 1;
        }
        const room = lumaN ? lumaSum / lumaN : 0;
        const lift = room > 70 ? Math.min(55, (room - 70) * 0.45) : 0;
        const effThr = thresholdRef.current + lift;
        found = findSpots(image.data, SAMPLE_W, SAMPLE_H, effThr);
        const nowUi = Date.now();
        if (nowUi - lastUiRef.current > 250) {
          lastUiRef.current = nowUi;
          setPeak(Math.round(maxScore));
          setSpots(found);
        }
        maybeLogActivity(found, maxScore, {
          luma: maxLuma,
          ir: maxIr,
          room,
          vw,
          vh,
        });
      } catch {
        /* keep camera live */
      }

      octx.clearRect(0, 0, overlay.width, overlay.height);

      if (enhanceOnRef.current) {
        octx.fillStyle = "rgba(10,11,12,0.18)";
        octx.fillRect(0, 0, overlay.width, overlay.height);
        const tmp = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
        const room = lumaN ? lumaSum / lumaN : 0;
        const lift = room > 70 ? Math.min(55, (room - 70) * 0.45) : 0;
        const thr = thresholdRef.current + lift;
        for (let i = 0; i < tmp.data.length; i += 4) {
          const mag = irTint(tmp.data[i], tmp.data[i + 1], tmp.data[i + 2]);
          const sc = scorePixel(tmp.data[i], tmp.data[i + 1], tmp.data[i + 2]);
          const v = mag >= 16 && sc > thr * 0.92 ? Math.min(255, (sc / 255) * 240) : 0;
          tmp.data[i] = v * 0.35;
          tmp.data[i + 1] = v;
          tmp.data[i + 2] = v * 0.55;
          tmp.data[i + 3] = v > 0 ? 170 : 0;
        }
        const enh = enhanceRefCanvas.current;
        const ectx = enh.getContext("2d");
        if (ectx) {
          ectx.putImageData(tmp, 0, 0);
          octx.globalAlpha = 0.7;
          octx.imageSmoothingEnabled = false;
          octx.drawImage(enh, 0, 0, overlay.width, overlay.height);
          octx.globalAlpha = 1;
        }
      }

      for (const spot of found) {
        const x = spot.x * overlay.width;
        const y = spot.y * overlay.height;
        const r = (spot.r / SAMPLE_W) * overlay.width;
        octx.beginPath();
        octx.arc(x, y, r, 0, Math.PI * 2);
        octx.strokeStyle = "rgba(125, 206, 160, 0.95)";
        octx.lineWidth = Math.max(2, overlay.width * 0.004);
        octx.stroke();
        octx.beginPath();
        octx.arc(x, y, 3, 0, Math.PI * 2);
        octx.fillStyle = "rgba(238, 240, 242, 0.95)";
        octx.fill();
      }

      const compose = composeRef.current;
      if (compose) {
        if (compose.width !== vw || compose.height !== vh) {
          compose.width = vw;
          compose.height = vh;
        }
        const cctx = compose.getContext("2d");
        if (cctx) {
          if (facingRef.current === "user") {
            cctx.save();
            cctx.translate(vw, 0);
            cctx.scale(-1, 1);
            cctx.drawImage(video, 0, 0, vw, vh);
            cctx.drawImage(overlay, 0, 0, vw, vh);
            cctx.restore();
          } else {
            cctx.drawImage(video, 0, 0, vw, vh);
            cctx.drawImage(overlay, 0, 0, vw, vh);
          }
        }
      }
    } catch {
      /* keep camera live */
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [maybeLogActivity]);

  const start = useCallback(
    async (nextFacing: Facing) => {
      setError(null);
      setRecordError(null);
      setPhase("requesting");
      releasingRef.current = true;
      stopStream();
      await new Promise((r) => window.setTimeout(r, 220));
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setPhase("missing");
          logDiag("error", "no-getUserMedia", nextFacing);
          return;
        }
        logDiag("diag", "camera-request", nextFacing);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: nextFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        stream.getVideoTracks().forEach((track) => {
          try {
            const caps = track.getCapabilities?.();
            if (caps && "torch" in caps) {
              void track.applyConstraints({
                advanced: [{ torch: false } as unknown as MediaTrackConstraintSet],
              });
            }
          } catch {
            /* torch not supported */
          }
          track.onended = () => {
            if (releasingRef.current) return;
            logDiag("error", "track-ended", `${nextFacing} ${track.label || "cam"}`);
            setPhase("missing");
            setError("Camera stopped. Tap Start camera.");
          };
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.onerror = () => {
            logDiag("error", "video-element-error", nextFacing);
          };
          await video.play();
        }
        releasingRef.current = false;
        setPhase("live");
        logDiag("diag", "camera-live", `${nextFacing} ${stream.getVideoTracks()[0]?.label || ""}`);
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(loop);
        eventSeqRef.current += 1;
        postLog({
          at: Date.now(),
          kind: "session",
          event: `e${eventSeqRef.current}`,
          peak: 0,
          sources: 0,
          facing: nextFacing,
          threshold: thresholdRef.current,
          spots: "",
          note: "camera-start",
        });
      } catch (err) {
        releasingRef.current = false;
        const name = err instanceof DOMException ? err.name : "Error";
        const msg = err instanceof Error ? err.message : "Camera failed to start.";
        logDiag("error", "camera-fail", `${name} ${msg} ${nextFacing}`);
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setPhase("denied");
        } else {
          setPhase("missing");
          setError(`${name}: ${msg}`);
        }
      }
    },
    [loop, stopStream, postLog, logDiag],
  );

  const startRecording = useCallback(() => {
    setRecordError(null);
    setSaveHint(null);
    const compose = composeRef.current;
    const live = streamRef.current;
    if (typeof MediaRecorder === "undefined") {
      setRecordError("Recording is not supported in this browser.");
      return;
    }
    releaseCapture();
    const mime = pickRecorderMime();
    const preferLive = isIOS();
    let rec: MediaRecorder | null = null;
    const makeRec = (stream: MediaStream) =>
      mime
        ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 })
        : new MediaRecorder(stream);
    try {
      if (preferLive && live) {
        rec = makeRec(live);
      } else if (compose && compose.width >= 2 && compose.height >= 2) {
        const drawn = compose.captureStream(24);
        captureStreamRef.current = drawn;
        rec = makeRec(drawn);
      } else if (live) {
        rec = makeRec(live);
      }
    } catch {
      rec = null;
    }
    if (!rec && live) {
      try {
        rec = mime
          ? new MediaRecorder(live, { mimeType: mime, videoBitsPerSecond: 2_000_000 })
          : new MediaRecorder(live);
      } catch {
        rec = null;
      }
    }
    if (!rec) {
      setRecordError("Wait for the camera picture, then try again.");
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    rec.onerror = () => {
      setRecordError("Recorder failed. Try again.");
      logDiag("error", "recorder-error", mime || "default");
    };
    rec.onstop = () => {
      const type = rec?.mimeType || (isIOS() ? "video/mp4" : "video/webm");
      const blob = new Blob(chunksRef.current, { type });
      recorderRef.current = null;
      releaseCapture();
      if (!blob.size) {
        setRecordError("That clip was empty. Hold Record for 2+ seconds, then Stop.");
        logDiag("error", "empty-clip", `${type} chunks=${chunksRef.current.length}`);
        return;
      }
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const url = URL.createObjectURL(blob);
      const duration = Date.now() - recordStartedRef.current;
      setClips((prev) => {
        const next: Clip[] = [{ id: String(Date.now()), url, at: Date.now(), duration, ext, blob }, ...prev];
        next.slice(8).forEach((c) => URL.revokeObjectURL(c.url));
        return next.slice(0, 8);
      });
      setSaveHint("Clip ready — tap Save to put it in Photos.");
      logDiag("diag", "clip-ready", `${ext} ${blob.size} chunks=${chunksRef.current.length}`);
    };
    try {
      rec.start(1000);
    } catch {
      try {
        rec.start();
      } catch {
        setRecordError("Could not start the recorder on this device.");
        return;
      }
    }
    recorderRef.current = rec;
    recordStartedRef.current = Date.now();
    setRecording(true);
    setRecTick(Date.now());
    postLog({
      at: Date.now(),
      kind: "record",
      event: lastLogRef.current.event,
      peak: 0,
      sources: 0,
      facing: facingRef.current,
      threshold: thresholdRef.current,
      spots: "",
      note: "record-start",
    });
  }, [postLog, logDiag]);

  useEffect(
    () => () => {
      stopStream();
      clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url));
    },
    [stopStream],
  );

  const flip = () => {
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    if (phase === "live" || phase === "requesting") void start(next);
  };

  const notebookText = () => {
    const lines = [
      "# IR Sight activity log v3",
      "# iso\tkind\tevent\tpeak\tsources\tfacing\tthr\tspots\tnote\textra",
      ...log.slice().reverse().map(formatEntryLine),
    ];
    return `${lines.join("\n")}\n`;
  };

  const downloadTxt = async () => {
    const text = notebookText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ir-activity.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyTxt = async () => {
    const text = notebookText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const saveClip = async (clip: Clip) => {
    try {
      await saveClipFile(clip);
      setSaveHint("Share sheet opened — pick Save Video.");
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") return;
      setSaveHint("Long-press the clip and choose Save Video.");
    }
  };

  const clearLog = () => {
    setLog([]);
    saveActivityLog([]);
  };

  const hit = spots.length > 0;
  const recMs = recording ? recTick - recordStartedRef.current : 0;

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-subtle">Personal IR tester</p>
          <h1 className="truncate text-xl font-semibold tracking-tight">IR Sight</h1>
          {lastDiag && (
            <p className="truncate font-mono text-xs text-subtle" title={lastDiag}>
              {lastDiag}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-xs tabular-nums text-muted">peak {peak}</p>
          <p className={cn("text-xs", hit ? "text-hit" : "text-subtle")}>
            {hit ? `${spots.length} source${spots.length === 1 ? "" : "s"}` : "quiet"}
          </p>
        </div>
      </header>

      <section className="relative mx-4 overflow-hidden rounded-lg border border-border bg-elevated">
        <div className="relative aspect-[3/4] max-h-[58dvh] w-full bg-black sm:aspect-video sm:max-h-[52dvh]">
          <video
            ref={videoRef}
            className={cn(
              "absolute inset-0 size-full object-cover",
              facing === "user" && "scale-x-[-1]",
            )}
            playsInline
            muted
            autoPlay
          />
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full" />
          <canvas ref={composeRef} className="pointer-events-none absolute -left-[9999px] size-px opacity-0" />
          {phase !== "live" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg/80 px-6 text-center">
              {phase === "denied" && (
                <>
                  <ShieldAlert className="size-8 text-warn" />
                  <p className="text-sm">Camera permission is off. Enable it for this page and try again.</p>
                </>
              )}
              {phase === "missing" && (
                <>
                  <Camera className="size-8 text-muted" />
                  <p className="text-sm">{error || "Camera is not available."}</p>
                </>
              )}
              {phase === "requesting" && <p className="text-sm text-muted">Starting camera…</p>}
              {phase === "idle" && (
                <p className="max-w-xs text-sm text-muted">
                  Point at a TV remote button in a dim room. A real IR LED shows as a small bright pinpoint.
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="flex flex-1 flex-col gap-4 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
        <div className="grid grid-cols-2 gap-2">
          {phase === "live" ? (
            <Button type="button" variant="secondary" onClick={stopStream}>
              <Square />
              Stop camera
            </Button>
          ) : (
            <Button type="button" onClick={() => void start(facing)}>
              <Aperture />
              Start camera
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={flip} disabled={phase === "requesting"}>
            <FlipHorizontal2 />
            {facing === "user" ? "Front camera" : "Rear camera"}
          </Button>
          {recording ? (
            <Button type="button" variant="rec" onClick={stopRecorder}>
              <Circle className="fill-current" />
              Stop · {formatDuration(recMs)}
            </Button>
          ) : (
            <Button type="button" variant="secondary" onClick={startRecording} disabled={phase !== "live"}>
              <ScanSearch />
              Record
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => setEnhance((v) => !v)}>
            <Lightbulb />
            {enhance ? "IR overlay on" : "IR overlay off"}
          </Button>
        </div>
        {recordError && <p className="text-sm text-warn">{recordError}</p>}
        {saveHint && <p className="text-sm text-muted">{saveHint}</p>}

        <label className="block">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-muted">Sensitivity</span>
            <span className="font-mono text-xs tabular-nums text-subtle">{threshold}</span>
          </div>
          <input
            type="range"
            min={160}
            max={250}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="h-11 w-full accent-accent"
          />
          <p className="mt-1 text-xs text-subtle">
            Only compact magenta/IR pinpoints count now. Point at a TV remote in the dark to confirm.
            Raise this if lamps still mark.
          </p>
        </label>

        {clips.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Recordings</p>
            <ul className="space-y-2">
              {clips.map((clip) => (
                <li
                  key={clip.id}
                  className="flex items-center gap-3 rounded-md border border-border bg-surface p-2"
                >
                  <video
                    src={clip.url}
                    className="h-14 w-20 shrink-0 rounded-xs object-cover"
                    muted
                    playsInline
                    controls={false}
                    onClick={(e) => {
                      const el = e.currentTarget;
                      if (el.paused) void el.play();
                      else el.pause();
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs tabular-nums text-muted">{formatDuration(clip.duration)}</p>
                    <p className="truncate text-xs text-subtle">{formatLogTime(clip.at)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void saveClip(clip)}
                    className="inline-flex h-11 items-center gap-1.5 rounded-md bg-accent px-3 text-sm text-accent-fg"
                  >
                    <Share2 className="size-4" />
                    Save
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <NotebookText className="size-4 text-muted" />
              Activity notebook
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void copyTxt()}
                className="inline-flex h-11 items-center gap-1.5 px-2 text-sm text-muted"
              >
                <Copy className="size-4" />
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => void downloadTxt()}
                className="inline-flex h-11 items-center gap-1.5 px-2 text-sm text-muted"
              >
                <Download className="size-4" />
                txt
              </button>
              {log.length > 0 && (
                <button
                  type="button"
                  onClick={clearLog}
                  className="inline-flex h-11 items-center gap-1.5 px-2 text-sm text-muted"
                >
                  <Trash2 className="size-4" />
                  Clear
                </button>
              )}
            </div>
          </div>
          {log.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm leading-normal text-muted">
              When a tiny bright IR-like pinpoint shows up, a still is saved here and a line is written to
              ir-activity.txt so it can be analyzed later. Lamps and windows are ignored.
            </p>
          ) : (
            <ul className="space-y-2">
              {log.map((entry) => (
                <li
                  key={entry.id}
                  className="flex gap-3 overflow-hidden rounded-md border border-border bg-surface"
                >
                  {entry.thumb ? (
                    <img src={entry.thumb} alt="" className="h-20 w-24 shrink-0 object-cover" />
                  ) : (
                    <div className="h-20 w-24 shrink-0 bg-elevated" />
                  )}
                  <div className="min-w-0 flex-1 py-2 pr-3">
                    <p className="font-mono text-xs tabular-nums text-muted">{formatLogTime(entry.at)}</p>
                    <p className="mt-1 text-sm">
                      {entry.sources} source{entry.sources === 1 ? "" : "s"}
                      <span className="text-subtle"> · peak {entry.peak}</span>
                      {entry.note ? <span className="text-subtle"> · {entry.note}</span> : null}
                    </p>
                    <p className="text-xs text-subtle">
                      {entry.facing === "user" ? "Front camera" : "Rear camera"}
                      {entry.event ? ` · ${entry.event}` : ""}
                    </p>
                    {entry.extra ? (
                      <p className="mt-0.5 truncate font-mono text-xs text-subtle">{entry.extra}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
