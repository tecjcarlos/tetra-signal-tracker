import { createServerFn } from "@tanstack/react-start";

type OcrResult = { rssi: number | null; la: string | null; nei: number | null; raw: string };

/**
 * Reads a photo/frame of a TETRA radio display and extracts the RSSI value in dBm.
 */
export const readRssiFromImage = createServerFn({ method: "POST" })
  .inputValidator((input: { image: string }) => {
    if (!input?.image || typeof input.image !== "string") {
      throw new Error("Imagem inválida");
    }
    return input;
  })
  .handler(async ({ data }): Promise<OcrResult> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("Serviço de leitura indisponível (chave ausente).");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-3.8-flash",
        messages: [
          {
            role: "system",
            content:
              "Você lê o visor de um rádio TETRA em uma foto. Responda APENAS com JSON " +
              '{"rssi": <número em dBm negativo ou null>, "la": <apenas o número após LA, como string, ou null>, "nei": <número inteiro após NEI ou null>}. ' +
              "O RSSI aparece como algo como -85 dBm, RSSI -85, ou uma escala/barras. " +
              "Se houver apenas barras de sinal, estime: 5 barras=-70, 4=-80, 3=-90, 2=-100, 1=-110. " +
              'A ERB de serviço aparece como "LA XX" (location area). Em "la" devolva somente o número/código após LA. ' +
              'O campo "NEI XX" indica o número de ERBs vizinhas; em "nei" devolva somente o número inteiro. ' +
              "Se não conseguir determinar algum campo, use null. Nada de texto extra.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Qual o RSSI, a LA (ERB de serviço) e o NEI (ERBs vizinhas) mostrados neste visor?" },
              { type: "image_url", image_url: { url: data.image } },
            ],
          },
        ],
      }),
    });

    if (res.status === 429) throw new Error("Muitas leituras seguidas. Aguarde alguns segundos.");
    if (res.status === 402) throw new Error("Créditos de IA esgotados no workspace.");
    if (!res.ok) throw new Error(`Falha na leitura (${res.status}).`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.replace(/```json|```/g, "").trim();

    let rssi: number | null = null;
    let la: string | null = null;
    let nei: number | null = null;
    try {
      const parsed = JSON.parse(cleaned) as {
        rssi?: number | null;
        la?: string | number | null;
        nei?: number | string | null;
      };
      rssi = typeof parsed.rssi === "number" ? parsed.rssi : null;
      if (parsed.la !== null && parsed.la !== undefined && `${parsed.la}`.trim() !== "") {
        la = `${parsed.la}`.replace(/^\s*LA\s*/i, "").trim();
      }
      if (parsed.nei !== null && parsed.nei !== undefined && `${parsed.nei}`.trim() !== "") {
        const n = Number(`${parsed.nei}`.replace(/[^0-9]/g, ""));
        nei = Number.isFinite(n) ? n : null;
      }
    } catch {
      const m = cleaned.match(/-?\d{2,3}/);
      rssi = m ? Number(m[0]) : null;
      const l = cleaned.match(/LA\s*([A-Za-z0-9-]+)/i);
      la = l ? l[1]! : null;
      const n = cleaned.match(/NEI\s*:?\s*(\d+)/i);
      nei = n ? Number(n[1]) : null;
    }
    if (rssi !== null && rssi > 0) rssi = -rssi;
    if (rssi !== null && (rssi < -140 || rssi > -20)) rssi = null;

    if (nei !== null && (nei < 0 || nei > 99)) nei = null;

    return { rssi, la, nei, raw: cleaned };
  });
