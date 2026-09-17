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
  Share2,
  ScanLine,
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
  shareFiles,
  summaryText,
  whatsappTextUrl,
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const posRef = useRef<GeolocationPosition | null>(null);


  const [readings, setReadings] = useState<Reading[]>([]);
  const [tracking, setTracking] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [stepM, setStepM] = useState(50);
  const [mode, setMode] = useState<"distance" | "time">("distance");
  const [stepS, setStepS] = useState(3);
  const [manualRssi, setManualRssi] = useState("");
  const [manualLa, setManualLa] = useState("");
  const [manualNei, setManualNei] = useState("");
  const [pos, setPos] = useState<GeolocationPosition | null>(null);
  const [distance, setDistance] = useState(0);
  const [status, setStatus] = useState("Pronto");
  
  const [capturing, setCapturing] = useState(false);

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
      let nei: number | null =
        manualNei.trim() !== "" && Number.isFinite(Number(manualNei)) ? Number(manualNei) : null;
      try {
        const attempts = camOn ? 3 : 0;
        for (let i = 0; i < attempts && rssi === null; i++) {
          const frame = grabFrame();
          if (!frame) break;
          setStatus(`Lendo visor do rádio (tentativa ${i + 1}/${attempts})...`);
          const out = await ocr({ data: { image: frame } });
          if (out.rssi !== null) {
            rssi = out.rssi;
            if (out.la) la = out.la;
            if (out.nei !== null) nei = out.nei;
          } else if (i < attempts - 1) {
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        if (rssi === null && manualRssi.trim() !== "") {
          const m = Number(manualRssi);
          rssi = Number.isFinite(m) ? m : null;
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
        nei,
        accuracy: p.coords.accuracy ?? null,
        speedKmh: p.coords.speed != null ? p.coords.speed * 3.6 : null,
        source,
      };
      setReadings((prev) => [...prev, reading]);
      lastFixRef.current = { lat: reading.lat, lon: reading.lon };
      setStatus(
        rssi === null
          ? "Não consegui ler o visor. Pare o carro e use 'Capturar tela do rádio'."
          : `Ponto salvo: ${rssi} dBm${la ? ` · LA ${la}` : ""}${nei !== null ? ` · NEI ${nei}` : ""}`,
      );
      if (rssi === null) toast.warning("Ponto sem nível. Corrija com a captura manual.");
    },
    [camOn, grabFrame, manualRssi, manualLa, manualNei, ocr],
  );


  const captureScreen = useCallback(async () => {
    if (!camOn) {
      toast.error("Ligue a câmera antes de capturar.");
      return;
    }
    if (busyRef.current) return;
    const frame = grabFrame();
    if (!frame) {
      toast.error("Não foi possível capturar a imagem.");
      return;
    }
    busyRef.current = true;
    setCapturing(true);
    setStatus("Lendo visor do rádio...");
    try {
      const out = await ocr({ data: { image: frame } });
      if (out.rssi !== null) setManualRssi(String(out.rssi));
      if (out.la) setManualLa(out.la);
      if (out.nei !== null) setManualNei(String(out.nei));
      setStatus(
        out.rssi === null
          ? "Visor ilegível, tente novamente com o carro parado"
          : `Capturado: ${out.rssi} dBm${out.la ? ` · LA ${out.la}` : ""}${out.nei !== null ? ` · NEI ${out.nei}` : ""}`,
      );
      if (out.rssi === null) toast.error("Não consegui ler o visor. Tente de novo.");
      else toast.success("Leitura capturada. Confira e use 'Marcar agora'.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao ler o visor");
    } finally {
      busyRef.current = false;
      setCapturing(false);
    }
  }, [camOn, grabFrame, ocr]);

  const fixLastPending = useCallback(() => {
    const r = Number(manualRssi);
    if (manualRssi.trim() === "" || !Number.isFinite(r)) {
      toast.error("Informe ou capture o nível antes de corrigir.");
      return;
    }
    let fixed = false;
    setReadings((prev) => {
      const idx = [...prev].map((x) => x.rssi).lastIndexOf(null);
      if (idx === -1) return prev;
      fixed = true;
      const copy = [...prev];
      const target = copy[idx]!;
      copy[idx] = {
        ...target,
        rssi: r,
        la: manualLa.trim() || target.la,
        nei:
          manualNei.trim() !== "" && Number.isFinite(Number(manualNei))
            ? Number(manualNei)
            : target.nei,
        source: "manual",
      };
      return copy;

    });
    setTimeout(() => {
      if (fixed) {
        toast.success("Ponto corrigido com os dados capturados.");
        setStatus("Último ponto sem leitura foi corrigido.");
      } else toast.info("Não há pontos sem leitura.");
    }, 0);
  }, [manualRssi, manualLa, manualNei]);


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
        posRef.current = p;
        if (mode === "time") return;
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
    if (mode === "time") {
      timerRef.current = setInterval(
        () => {
          const p = posRef.current;
          if (!p) return;
          const last = lastFixRef.current;
          if (last) {
            setDistance(
              (x) => x + haversine(last.lat, last.lon, p.coords.latitude, p.coords.longitude),
            );
          }
          void record(p, "auto");
        },
        Math.max(1, stepS) * 1000,
      );
    }
  }, [record, stepM, stepS, mode]);

  const stop = useCallback(() => {
    if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = null;
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = null;
    setTracking(false);
    setStatus("Parado");
  }, []);

  useEffect(() => {
    return () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      if (timerRef.current !== null) clearInterval(timerRef.current);
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
  const pendingCount = readings.length - valid.length;

  const avg = valid.length
    ? Math.round(valid.reduce((s, r) => s + (r.rssi ?? 0), 0) / valid.length)
    : null;

  const shareAll = useCallback(async () => {
    if (!readings.length) return;
    const text = summaryText(readings);
    const ok = await shareFiles(
      [
        {
          filename: `tetra-${stamp}.kml`,
          content: buildKml(readings),
          mime: "application/vnd.google-earth.kml+xml",
        },
        { filename: `tetra-${stamp}.csv`, content: buildCsv(readings), mime: "text/csv" },
      ],
      text,
    );
    if (!ok) {
      download(`tetra-${stamp}.kml`, buildKml(readings), "application/vnd.google-earth.kml+xml");
      download(`tetra-${stamp}.csv`, buildCsv(readings), "text/csv");
      toast.info("Arquivos baixados. Anexe-os na conversa do WhatsApp.");
      window.open(whatsappTextUrl(text), "_blank", "noopener");
    }
  }, [readings, stamp]);

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
                {" · "}
                NEI <span className="font-mono text-accent">{last?.nei ?? "--"}</span>
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
          <div className="space-y-2 p-3">
            <div className="flex gap-2">
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
            <Button
              className="w-full"
              disabled={!camOn || capturing}
              onClick={() => void captureScreen()}
            >
              <ScanLine /> {capturing ? "Lendo visor..." : "Capturar tela do rádio"}
            </Button>
            {pendingCount > 0 && (
              <Button variant="secondary" className="w-full" onClick={fixLastPending}>
                Corrigir último ponto sem leitura ({pendingCount} pendente
                {pendingCount > 1 ? "s" : ""})
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              A leitura é automática a cada ponto (3 tentativas). Se falhar, pare o carro,
              toque em "Capturar tela do rádio" e depois em "Corrigir último ponto".
            </p>

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
            <div className="space-y-1">
              <Label htmlFor="nei" className="text-xs">
                NEI (ERBs vizinhas)
              </Label>
              <Input
                id="nei"
                type="number"
                inputMode="numeric"
                placeholder="4"
                value={manualNei}
                onChange={(e) => setManualNei(e.target.value)}
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

        <Button
          variant="default"
          className="w-full"
          disabled={!readings.length}
          onClick={() => void shareAll()}
        >
          <Share2 /> Compartilhar no WhatsApp
        </Button>

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
                    <th className="px-3 py-2">NEI</th>
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
                        <td className="px-3 py-2 text-accent">{r.nei ?? "--"}</td>
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
