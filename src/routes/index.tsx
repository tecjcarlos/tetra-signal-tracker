import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Download,
  MapPin,
  Play,
  Radio,
  Square,
  Trash2,
  Crosshair,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readRssiFromImage } from "@/lib/rssi-ocr.functions";
import {
  BANDS,
  bandFor,
  buildCsv,
  buildKml,
  download,
  haversine,
  type Reading,
} from "@/lib/rssi";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TETRA Drive Test - Registro de RSSI com GPS e KML" },
      {
        name: "description",
        content:
          "Registre o nível de sinal RSSI do rádio TETRA a cada 50 metros com posição GPS e exporte o trajeto colorido em KML para o Google Earth.",
      },
      { property: "og:title", content: "TETRA Drive Test - Registro de RSSI com GPS e KML" },
      {
        property: "og:description",
        content:
          "Leitura automática do visor do rádio TETRA por câmera, registro a cada 50 m com latitude/longitude e exportação KML.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DriveTest,
});

const STORAGE_KEY = "tetra-drive-test-readings";

function DriveTest() {
  const ocr = useServerFn(readRssiFromImage);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const watchRef = useRef<number | null>(null);
  const lastFixRef = useRef<{ lat: number; lon: number } | null>(null);
  const busyRef = useRef(false);

  const [readings, setReadings] = useState<Reading[]>([]);
  const [tracking, setTracking] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [stepM, setStepM] = useState(50);
  const [manualRssi, setManualRssi] = useState("");
  const [manualLa, setManualLa] = useState("");
  const [pos, setPos] = useState<GeolocationPosition | null>(null);
  const [distance, setDistance] = useState(0);
  const [status, setStatus] = useState("Pronto");

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        setReadings(JSON.parse(raw) as Reading[]);
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readings));
  }, [readings]);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamOn(true);
    } catch {
      toast.error("Não foi possível abrir a câmera. Use a leitura manual.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamOn(false);
  }, []);

  const grabFrame = useCallback((): string | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const canvas = document.createElement("canvas");
    const w = Math.min(1024, v.videoWidth);
    canvas.width = w;
    canvas.height = Math.round((v.videoHeight / v.videoWidth) * w);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  }, []);

  const record = useCallback(
    async (p: GeolocationPosition, source: "auto" | "manual") => {
      if (busyRef.current) return;
      busyRef.current = true;
      let rssi: number | null = null;
      let la: string | null = manualLa.trim() || null;
      try {
        const frame = camOn ? grabFrame() : null;
        if (frame) {
          setStatus("Lendo visor do rádio...");
          const out = await ocr({ data: { image: frame } });
          rssi = out.rssi;
          if (out.la) la = out.la;
          if (rssi === null) setStatus("Visor ilegível neste ponto");
        } else if (manualRssi.trim() !== "") {
          rssi = Number(manualRssi);
          if (!Number.isFinite(rssi)) rssi = null;
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Falha ao ler o visor");
      } finally {
        busyRef.current = false;
      }

      const reading: Reading = {
        id: `${p.timestamp}-${Math.random().toString(36).slice(2, 7)}`,
        t: p.timestamp,
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        rssi,
        la,
        accuracy: p.coords.accuracy ?? null,
        speedKmh: p.coords.speed != null ? p.coords.speed * 3.6 : null,
        source,
      };
      setReadings((prev) => [...prev, reading]);
      lastFixRef.current = { lat: reading.lat, lon: reading.lon };
      setStatus(
        rssi === null
          ? "Ponto salvo sem nível"
          : `Ponto salvo: ${rssi} dBm${la ? ` · LA ${la}` : ""}`,
      );
    },
    [camOn, grabFrame, manualRssi, manualLa, ocr],
  );

  const start = useCallback(() => {
    if (!("geolocation" in navigator)) {
      toast.error("Este aparelho não fornece localização.");
      return;
    }
    setTracking(true);
    setStatus("Aguardando GPS...");
    watchRef.current = navigator.geolocation.watchPosition(
      (p) => {
        setPos(p);
        const last = lastFixRef.current;
        if (!last) {
          void record(p, "auto");
          return;
        }
        const d = haversine(last.lat, last.lon, p.coords.latitude, p.coords.longitude);
        if (d >= stepM) {
          setDistance((x) => x + d);
          void record(p, "auto");
        }
      },
      () => {
        toast.error("Localização negada. Autorize o GPS no navegador.");
        setTracking(false);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }, [record, stepM]);

  const stop = useCallback(() => {
    if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = null;
    setTracking(false);
    setStatus("Parado");
  }, []);

  useEffect(() => {
    return () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const markNow = useCallback(() => {
    if (!pos) {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          setPos(p);
          void record(p, "manual");
        },
        () => toast.error("Sem posição GPS no momento."),
        { enableHighAccuracy: true },
      );
      return;
    }
    void record(pos, "manual");
  }, [pos, record]);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const last = readings[readings.length - 1];
  const lastBand = bandFor(last?.rssi ?? null);
  const valid = readings.filter((r) => r.rssi !== null);
  const avg = valid.length
    ? Math.round(valid.reduce((s, r) => s + (r.rssi ?? 0), 0) / valid.length)
    : null;

  return (
    <main className="min-h-screen bg-background pb-16 text-foreground">
      <Toaster position="top-center" />
      <header className="border-b border-border bg-surface px-4 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Radio className="size-6 text-primary" />
          <div>
            <h1 className="text-lg font-bold tracking-tight">TETRA Drive Test</h1>
            <p className="text-xs text-muted-foreground">
              Nível de sinal + posição a cada {stepM} m
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        {/* Leitura atual */}
        <Card className="border-border bg-card p-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Último nível
              </p>
              <p
                className="font-mono text-5xl font-bold leading-none"
                style={{ color: lastBand.hex }}
              >
                {last?.rssi ?? "--"}
                <span className="ml-1 text-lg font-medium">dBm</span>
              </p>
              <p className="mt-1 text-sm" style={{ color: lastBand.hex }}>
                {lastBand.label}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                ERB de serviço: <span className="font-mono text-accent">LA {last?.la ?? "--"}</span>
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>{readings.length} pontos</p>
              <p>{(distance / 1000).toFixed(2)} km</p>
              <p>Média {avg ?? "--"} dBm</p>
            </div>
          </div>
          <p className="mt-3 rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {status}
            {pos
              ? ` · ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)} · ±${Math.round(pos.coords.accuracy)} m`
              : " · sem GPS"}
          </p>
        </Card>

        {/* Câmera */}
        <Card className="overflow-hidden border-border bg-card">
          <div className="relative aspect-video w-full bg-black">
            <video
              ref={videoRef}
              playsInline
              muted
              className="size-full object-cover"
              aria-label="Visor do rádio TETRA"
            />
            {!camOn && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <Camera className="size-8" />
                <p className="px-6">
                  Aponte a câmera para o visor do rádio e ligue a leitura automática.
                </p>
              </div>
            )}
            {camOn && (
              <div className="pointer-events-none absolute inset-x-8 inset-y-10 rounded-lg border-2 border-dashed border-primary/70" />
            )}
          </div>
          <div className="flex gap-2 p-3">
            <Button
              variant={camOn ? "secondary" : "default"}
              className="flex-1"
              onClick={() => (camOn ? stopCamera() : void startCamera())}
            >
              <Camera /> {camOn ? "Desligar câmera" : "Ligar câmera"}
            </Button>
            <Button variant="outline" className="flex-1" onClick={markNow}>
              <Crosshair /> Marcar agora
            </Button>
          </div>
        </Card>

        {/* Controles */}
        <Card className="space-y-3 border-border bg-card p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="step" className="text-xs">
                Intervalo (metros)
              </Label>
              <Input
                id="step"
                type="number"
                inputMode="numeric"
                value={stepM}
                onChange={(e) => setStepM(Math.max(5, Number(e.target.value) || 50))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="manual" className="text-xs">
                Nível manual (dBm)
              </Label>
              <Input
                id="manual"
                type="number"
                inputMode="numeric"
                placeholder="-85"
                value={manualRssi}
                onChange={(e) => setManualRssi(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="la" className="text-xs">
                ERB de serviço (LA)
              </Label>
              <Input
                id="la"
                inputMode="text"
                placeholder="12"
                value={manualLa}
                onChange={(e) => setManualLa(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Com a câmera ligada o nível e a LA são lidos do visor automaticamente. Sem câmera,
            os valores manuais acima são usados em cada ponto.
          </p>
          <Button
            size="lg"
            className="w-full"
            variant={tracking ? "destructive" : "default"}
            onClick={() => (tracking ? stop() : start())}
          >
            {tracking ? <Square /> : <Play />}
            {tracking ? "Parar levantamento" : "Iniciar levantamento"}
          </Button>
        </Card>

        {/* Legenda */}
        <div className="flex flex-wrap gap-2">
          {BANDS.map((b) => (
            <span
              key={b.label}
              className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs"
            >
              <span className="size-2.5 rounded-full" style={{ backgroundColor: b.hex }} />
              {b.label} ({b.min === -999 ? "< -100" : `≥ ${b.min}`} dBm)
            </span>
          ))}
        </div>

        {/* Exportação */}
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="secondary"
            disabled={!readings.length}
            onClick={() =>
              download(
                `tetra-${stamp}.kml`,
                buildKml(readings),
                "application/vnd.google-earth.kml+xml",
              )
            }
          >
            <Download /> KML
          </Button>
          <Button
            variant="secondary"
            disabled={!readings.length}
            onClick={() => download(`tetra-${stamp}.csv`, buildCsv(readings), "text/csv")}
          >
            <Download /> CSV
          </Button>
          <Button
            variant="outline"
            disabled={!readings.length}
            onClick={() => {
              if (confirm("Apagar todos os pontos registrados?")) {
                setReadings([]);
                lastFixRef.current = null;
                setDistance(0);
              }
            }}
          >
            <Trash2 /> Limpar
          </Button>
        </div>

        {/* Tabela */}
        <Card className="border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <MapPin className="size-4 text-accent" />
            <h2 className="text-sm font-semibold">Registros</h2>
          </div>
          {readings.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nenhum ponto registrado ainda.
            </p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead className="sticky top-0 bg-surface text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Hora</th>
                    <th className="px-3 py-2">dBm</th>
                    <th className="px-3 py-2">LA</th>
                    <th className="px-3 py-2">Latitude</th>
                    <th className="px-3 py-2">Longitude</th>
                  </tr>
                </thead>
                <tbody>
                  {readings
                    .slice()
                    .reverse()
                    .map((r, i) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-3 py-2 text-muted-foreground">
                          {readings.length - i}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {new Date(r.t).toLocaleTimeString("pt-BR")}
                        </td>
                        <td
                          className="px-3 py-2 font-bold"
                          style={{ color: bandFor(r.rssi).hex }}
                        >
                          {r.rssi ?? "--"}
                        </td>
                        <td className="px-3 py-2 text-accent">{r.la ?? "--"}</td>
                        <td className="px-3 py-2">{r.lat.toFixed(6)}</td>
                        <td className="px-3 py-2">{r.lon.toFixed(6)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
