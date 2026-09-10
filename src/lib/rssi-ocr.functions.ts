import { createServerFn } from "@tanstack/react-start";

type OcrResult = { rssi: number | null; raw: string };

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
              '{"rssi": <número em dBm negativo ou null>}. ' +
              "O RSSI aparece como algo como -85 dBm, RSSI -85, ou uma escala/barras. " +
              "Se houver apenas barras de sinal, estime: 5 barras=-70, 4=-80, 3=-90, 2=-100, 1=-110. " +
              "Se não conseguir determinar, use null. Nada de texto extra.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Qual o RSSI mostrado neste visor?" },
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
    try {
      const parsed = JSON.parse(cleaned) as { rssi?: number | null };
      rssi = typeof parsed.rssi === "number" ? parsed.rssi : null;
    } catch {
      const m = cleaned.match(/-?\d{2,3}/);
      rssi = m ? Number(m[0]) : null;
    }
    if (rssi !== null && rssi > 0) rssi = -rssi;
    if (rssi !== null && (rssi < -140 || rssi > -20)) rssi = null;

    return { rssi, raw: cleaned };
  });
