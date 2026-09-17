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

// ---- Classificação profissional de drive test (usada apenas no KML) ----
type RssiClass = {
  id: string;
  label: string;
  color: string; // aabbggrr
  range: string;
  test: (rssi: number) => boolean;
};

const RSSI_CLASSES: RssiClass[] = [
  {
    id: "rssi-excellent",
    label: "EXCELENTE",
    color: "ff00ff00",
    range: ">= -65 dBm",
    test: (r) => r >= -65,
  },
  {
    id: "rssi-good",
    label: "BOM",
    color: "ff80ff80",
    range: "-66 a -75 dBm",
    test: (r) => r >= -75,
  },
  {
    id: "rssi-acceptable",
    label: "ACEITÁVEL",
    color: "ff00ffff",
    range: "-76 a -85 dBm",
    test: (r) => r >= -85,
  },
  {
    id: "rssi-weak",
    label: "FRACO",
    color: "ff0080ff",
    range: "-86 a -95 dBm",
    test: (r) => r >= -95,
  },
  {
    id: "rssi-critical",
    label: "CRÍTICO",
    color: "ff0000ff",
    range: "< -95 dBm",
    test: () => true,
  },
];

const NO_RSSI: RssiClass = {
  id: "sem-rssi",
  label: "SEM RSSI",
  color: "ff808080",
  range: "sem leitura",
  test: () => false,
};

function classify(rssi: number | null): RssiClass {
  if (rssi === null || !Number.isFinite(rssi)) return NO_RSSI;
  return RSSI_CLASSES.find((c) => c.test(rssi)) ?? RSSI_CLASSES[RSSI_CLASSES.length - 1]!;
}

const pad6 = (n: number) => String(n).padStart(6, "0");
const localIso = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function kmlFilename(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `TETRA_DriveTest_${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}.kml`;
}

export function buildKml(readings: Reading[], name = "TETRA DRIVE TEST"): string {
  const pts = readings
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .slice()
    .sort((a, b) => a.t - b.t);

  const styles = [...RSSI_CLASSES, NO_RSSI]
    .map(
      (c) => `  <Style id="${c.id}">
    <IconStyle><scale>0.9</scale><color>${c.color}</color>
      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
    </IconStyle>
    <LabelStyle><scale>0.8</scale><color>${c.color}</color></LabelStyle>
  </Style>`,
    )
    .join("\n");

  const routeStyle = `  <Style id="route-line">
    <LineStyle><color>ffcfcfcf</color><width>3</width></LineStyle>
  </Style>`;

  const route = `  <Folder><name>ROTA DO TESTE</name>
    <Placemark>
      <name>Rota do drive test</name>
      <styleUrl>#route-line</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>
        <coordinates>${pts.map((r) => `${r.lon.toFixed(6)},${r.lat.toFixed(6)},0`).join(" ")}</coordinates>
      </LineString>
    </Placemark>
  </Folder>`;

  const placemark = (r: Reading, idx: number) => {
    const c = classify(r.rssi);
    const when = new Date(r.t);
    const rows: string[] = [];
    if (r.rssi !== null) rows.push(`<tr><td><b>RSSI</b></td><td>${r.rssi} dBm</td></tr>`);
    rows.push(`<tr><td><b>CLASSIFICAÇÃO</b></td><td>${c.label}</td></tr>`);
    if (r.la) rows.push(`<tr><td><b>LA</b></td><td>${esc(r.la)}</td></tr>`);
    if (r.nei !== null && r.nei !== undefined)
      rows.push(`<tr><td><b>NEI</b></td><td>${r.nei}</td></tr>`);
    rows.push(`<tr><td><b>HORÁRIO</b></td><td>${when.toLocaleString("pt-BR")}</td></tr>`);
    rows.push(`<tr><td><b>LATITUDE</b></td><td>${r.lat.toFixed(6)}</td></tr>`);
    rows.push(`<tr><td><b>LONGITUDE</b></td><td>${r.lon.toFixed(6)}</td></tr>`);

    const data: string[] = [];
    if (r.rssi !== null) data.push(`<Data name="RSSI"><value>${r.rssi}</value></Data>`);
    if (r.la) data.push(`<Data name="LA"><value>${esc(r.la)}</value></Data>`);
    if (r.nei !== null && r.nei !== undefined)
      data.push(`<Data name="NEI"><value>${r.nei}</value></Data>`);
    data.push(`<Data name="Latitude"><value>${r.lat.toFixed(6)}</value></Data>`);
    data.push(`<Data name="Longitude"><value>${r.lon.toFixed(6)}</value></Data>`);
    data.push(`<Data name="Timestamp"><value>${localIso(r.t)}</value></Data>`);
    data.push(`<Data name="RSSI_Class"><value>${c.label}</value></Data>`);

    return `      <Placemark>
        <name>${r.rssi !== null ? `${r.rssi} dBm` : "s/ RSSI"}</name>
        <description><![CDATA[<h3>MEDIÇÃO ${pad6(idx)}</h3><table>${rows.join("")}</table>]]></description>
        <styleUrl>#${c.id}</styleUrl>
        <TimeStamp><when>${localIso(r.t)}</when></TimeStamp>
        <ExtendedData>${data.join("")}</ExtendedData>
        <Point><coordinates>${r.lon.toFixed(6)},${r.lat.toFixed(6)},0</coordinates></Point>
      </Placemark>`;
  };

  const groups = new Map<string, string[]>();
  pts.forEach((r, i) => {
    const c = classify(r.rssi);
    const list = groups.get(c.id) ?? [];
    list.push(placemark(r, i + 1));
    groups.set(c.id, list);
  });

  const folders = [...RSSI_CLASSES, NO_RSSI]
    .filter((c) => (groups.get(c.id)?.length ?? 0) > 0)
    .map(
      (c) => `    <Folder><name>${c.label}</name>
${groups.get(c.id)!.join("\n")}
    </Folder>`,
    )
    .join("\n");

  // Resumo
  const valid = pts.filter((r) => r.rssi !== null) as (Reading & { rssi: number })[];
  const neis = pts.map((r) => r.nei).filter((n): n is number => typeof n === "number");
  const first = pts[0];
  const lastPt = pts[pts.length - 1];
  const avg = valid.length ? Math.round(valid.reduce((s, r) => s + r.rssi, 0) / valid.length) : null;
  const min = valid.length ? Math.min(...valid.map((r) => r.rssi)) : null;
  const max = valid.length ? Math.max(...valid.map((r) => r.rssi)) : null;
  const neiAvg = neis.length ? (neis.reduce((s, n) => s + n, 0) / neis.length).toFixed(1) : null;

  const counts = [...RSSI_CLASSES, NO_RSSI]
    .map((c) => `<tr><td><b>${c.label}</b></td><td>${groups.get(c.id)?.length ?? 0}</td></tr>`)
    .join("");

  const legend = [...RSSI_CLASSES, NO_RSSI]
    .map(
      (c) =>
        `<tr><td><b>${c.label}</b></td><td>${c.range}</td><td style="background:#${c.color.slice(6, 8)}${c.color.slice(4, 6)}${c.color.slice(2, 4)}">&nbsp;&nbsp;&nbsp;</td></tr>`,
    )
    .join("");

  const info = `  <Folder><name>INFORMAÇÕES DO TESTE</name>
    <Placemark>
      <name>Resumo do teste</name>
      <description><![CDATA[<h3>${esc(name)}</h3><table>
<tr><td><b>Data inicial</b></td><td>${first ? new Date(first.t).toLocaleDateString("pt-BR") : "-"}</td></tr>
<tr><td><b>Horário inicial</b></td><td>${first ? new Date(first.t).toLocaleTimeString("pt-BR") : "-"}</td></tr>
<tr><td><b>Horário final</b></td><td>${lastPt ? new Date(lastPt.t).toLocaleTimeString("pt-BR") : "-"}</td></tr>
<tr><td><b>Total de medições</b></td><td>${pts.length}</td></tr>
<tr><td><b>RSSI médio</b></td><td>${avg !== null ? `${avg} dBm` : "-"}</td></tr>
<tr><td><b>RSSI mínimo</b></td><td>${min !== null ? `${min} dBm` : "-"}</td></tr>
<tr><td><b>RSSI máximo</b></td><td>${max !== null ? `${max} dBm` : "-"}</td></tr>
<tr><td><b>NEI médio</b></td><td>${neiAvg ?? "-"}</td></tr>
</table><h4>Pontos por classificação</h4><table>${counts}</table>
<h4>Legenda RSSI</h4><table>${legend}</table>]]></description>
      ${first ? `<Point><coordinates>${first.lon.toFixed(6)},${first.lat.toFixed(6)},0</coordinates></Point>` : ""}
    </Placemark>
  </Folder>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(name)}</name>
  <open>1</open>
${styles}
${routeStyle}
${info}
${route}
  <Folder><name>MEDIÇÕES</name><open>1</open>
${folders}
  </Folder>
</Document>
</kml>`;
}

export function buildCsv(readings: Reading[]): string {
  const head =
    "indice,data_hora,latitude,longitude,rssi_dbm,la_erb,nei_vizinhas,qualidade,precisao_m,velocidade_kmh,origem";
  const rows = readings.map((r, i) =>
    [
      i + 1,
      new Date(r.t).toISOString(),
      r.lat.toFixed(6),
      r.lon.toFixed(6),
      r.rssi ?? "",
      r.la ? `"${r.la.replace(/"/g, '""')}"` : "",
      r.nei ?? "",
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

/**
 * Tenta compartilhar os arquivos (WhatsApp aparece na folha de compartilhamento
 * do aparelho). Retorna false quando o aparelho não suporta envio de arquivos.
 */
export async function shareFiles(
  files: { filename: string; content: string; mime: string }[],
  text: string,
): Promise<boolean> {
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
    share?: (d: ShareData) => Promise<void>;
  };
  if (typeof File === "undefined" || !nav.share || !nav.canShare) return false;
  const list = files.map((f) => new File([f.content], f.filename, { type: f.mime }));
  const payload: ShareData & { files: File[] } = { files: list, title: "TETRA Drive Test", text };
  if (!nav.canShare(payload)) return false;
  try {
    await nav.share(payload);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return true;
    return false;
  }
}

export function whatsappTextUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function summaryText(readings: Reading[]): string {
  const valid = readings.filter((r) => r.rssi !== null);
  const avg = valid.length
    ? Math.round(valid.reduce((s, r) => s + (r.rssi ?? 0), 0) / valid.length)
    : null;
  return `Levantamento TETRA: ${readings.length} pontos registrados${avg !== null ? `, média ${avg} dBm` : ""}.`;
}
