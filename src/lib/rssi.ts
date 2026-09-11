export type Reading = {
  id: string;
  t: number;
  lat: number;
  lon: number;
  rssi: number | null;
  la: string | null;
  nei: number | null;
  accuracy: number | null;
  speedKmh: number | null;
  source: "auto" | "manual";
};

export type Band = {
  label: string;
  min: number;
  token: string;
  kml: string; // aabbggrr
  hex: string;
};

// Padrão TETRA
export const BANDS: Band[] = [
  { label: "Excelente", min: -75, token: "signal-1", kml: "ff00c000", hex: "#22c55e" },
  { label: "Bom", min: -90, token: "signal-2", kml: "ff00d7ff", hex: "#eab308" },
  { label: "Fraco", min: -100, token: "signal-3", kml: "ff0080ff", hex: "#f97316" },
  { label: "Crítico", min: -999, token: "signal-4", kml: "ff2222dd", hex: "#ef4444" },
];

export function bandFor(rssi: number | null): Band {
  if (rssi === null) return { label: "Sem leitura", min: -999, token: "muted", kml: "ff9e9e9e", hex: "#9e9e9e" };
  return BANDS.find((b) => rssi >= b.min) ?? BANDS[BANDS.length - 1]!;
}

export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

export function buildKml(readings: Reading[], name = "Levantamento TETRA"): string {
  const styles = BANDS.map(
    (b, i) => `  <Style id="b${i}">
    <IconStyle><scale>0.9</scale><color>${b.kml}</color>
      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
    </IconStyle>
    <LineStyle><color>${b.kml}</color><width>6</width></LineStyle>
  </Style>`,
  ).join("\n");

  const styleIdx = (r: Reading) => {
    if (r.rssi === null) return 3;
    const i = BANDS.findIndex((b) => r.rssi! >= b.min);
    return i < 0 ? 3 : i;
  };

  const points = readings
    .map((r, i) => {
      const b = bandFor(r.rssi);
      return `    <Placemark>
      <name>${i + 1}: ${r.rssi === null ? "s/ leitura" : `${r.rssi} dBm`}${r.la ? ` (LA ${esc(r.la)})` : ""}</name>
      <description><![CDATA[RSSI: ${r.rssi ?? "-"} dBm<br/>ERB de serviço (LA): ${r.la ?? "-"}<br/>Qualidade: ${b.label}<br/>Hora: ${new Date(r.t).toLocaleString("pt-BR")}<br/>Lat/Lon: ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}<br/>Precisão GPS: ${r.accuracy?.toFixed(0) ?? "-"} m]]></description>
      <styleUrl>#b${styleIdx(r)}</styleUrl>
      <Point><coordinates>${r.lon},${r.lat},0</coordinates></Point>
    </Placemark>`;
    })
    .join("\n");

  const segments = readings
    .slice(1)
    .map((r, i) => {
      const p = readings[i]!;
      return `    <Placemark>
      <name>Trecho ${i + 1}</name>
      <styleUrl>#b${styleIdx(r)}</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>${p.lon},${p.lat},0 ${r.lon},${r.lat},0</coordinates></LineString>
    </Placemark>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(name)}</name>
${styles}
  <Folder><name>Trajeto</name>
${segments}
  </Folder>
  <Folder><name>Pontos de medição</name>
${points}
  </Folder>
</Document>
</kml>`;
}

export function buildCsv(readings: Reading[]): string {
  const head =
    "indice,data_hora,latitude,longitude,rssi_dbm,la_erb,qualidade,precisao_m,velocidade_kmh,origem";
  const rows = readings.map((r, i) =>
    [
      i + 1,
      new Date(r.t).toISOString(),
      r.lat.toFixed(6),
      r.lon.toFixed(6),
      r.rssi ?? "",
      r.la ? `"${r.la.replace(/"/g, '""')}"` : "",
      bandFor(r.rssi).label,
      r.accuracy?.toFixed(0) ?? "",
      r.speedKmh?.toFixed(1) ?? "",
      r.source === "auto" ? "camera" : "manual",
    ].join(","),
  );
  return [head, ...rows].join("\n");
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
