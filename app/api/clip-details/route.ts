import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeId } from "../../../lib/youtube";
import type { Chunk, Sentence } from "../../../lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function normalizeDetails(
  value: unknown,
  clipStart: number,
  clipEnd: number
): { sentences: Sentence[]; chunks: Chunk[] } {
  if (!value || typeof value !== "object") {
    throw new Error("Resposta vazia na transcrição do corte.");
  }

  const data = value as Record<string, unknown>;
  const rawSentences = Array.isArray(data.sentences) ? data.sentences : [];
  const rawChunks = Array.isArray(data.chunks) ? data.chunks : [];

  const sentences = rawSentences
    .map((raw) => {
      const s = raw as Record<string, unknown>;
      let startSec = Number(s.startSec);
      let endSec = Number(s.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        return null;
      }

      // If the model accidentally returned clip-relative timestamps, convert them.
      const clipDuration = clipEnd - clipStart;
      if (startSec >= 0 && endSec <= clipDuration + 2 && clipStart > 3) {
        startSec += clipStart;
        endSec += clipStart;
      }

      startSec = Math.max(clipStart, Math.min(startSec, clipEnd));
      endSec = Math.max(startSec + 0.05, Math.min(endSec, clipEnd));

      const en = String(s.en ?? "").trim();
      const pt = String(s.pt ?? "").trim();
      if (!en) return null;

      return { startSec, endSec, en, pt };
    })
    .filter(Boolean)
    .sort((a, b) => (a as Sentence).startSec - (b as Sentence).startSec) as Sentence[];

  const chunks = rawChunks
    .map((raw) => {
      const c = raw as Record<string, unknown>;
      const en = String(c.en ?? "").trim();
      const pt = String(c.pt ?? "").trim();
      const note = String(c.note ?? "").trim();
      if (!en || !pt) return null;
      return { en, pt, note };
    })
    .filter(Boolean)
    .slice(0, 8) as Chunk[];

  if (!sentences.length) {
    throw new Error("Não consegui obter a transcrição completa deste corte.");
  }

  return { sentences, chunks };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sourceUrl = String(body?.url ?? "").trim();
    const videoId = extractYouTubeId(sourceUrl);
    const clipStart = Number(body?.startSec);
    const clipEnd = Number(body?.endSec);

    if (!videoId) {
      return NextResponse.json({ error: "Link do YouTube inválido." }, { status: 400 });
    }

    if (
      !Number.isFinite(clipStart) ||
      !Number.isFinite(clipEnd) ||
      clipEnd <= clipStart ||
      clipEnd - clipStart > 180
    ) {
      return NextResponse.json({ error: "Intervalo do corte inválido." }, { status: 400 });
    }

    const rawApiKey = process.env.GEMINI_API_KEY ?? "";
    const apiKey = rawApiKey.trim().replace(/^["\']|["\']$/g, "");
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY não configurada." }, { status: 500 });
    }

    const preferredModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const models = Array.from(
      new Set([preferredModel, "gemini-3.5-flash", "gemini-3.5-flash-lite"])
    );

    const canonicalYouTubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const clipDuration = clipEnd - clipStart;

    const prompt = `
Você está preparando um exercício de shadowing em inglês.

Analise SOMENTE o intervalo do vídeo que vai de ${clipStart.toFixed(1)}s a ${clipEnd.toFixed(1)}s no vídeo original.

OBJETIVO:
1. Transcrever TODO o inglês falado nesse intervalo, sem resumir nem pular trechos.
2. Dividir a fala em CUES CURTOS de legenda, normalmente entre 2 e 6 segundos cada.
3. Traduzir cada cue naturalmente para português brasileiro.
4. Extrair de 3 a 6 chunks realmente úteis e reutilizáveis do trecho.

TIMESTAMPS:
- startSec e endSec devem ser ABSOLUTOS no vídeo original.
- O corte começa em ${clipStart.toFixed(1)}s e dura ${clipDuration.toFixed(1)}s.
- Se você raciocinar em tempo relativo ao corte, some ${clipStart.toFixed(1)} a cada timestamp.
- Use precisão aproximada de 0,5 a 1 segundo; não invente precisão falsa.
- Durante fala contínua, não deixe buracos grandes entre um cue e outro.
- Cada trecho falado deve aparecer em exatamente um cue.
- Não deixe a transcrição parar antes da última fala do intervalo.
- Preserve rigorosamente a ordem cronológica.
- Não resuma, não parafraseie e não invente conteúdo.

CHUNKS:
- escolha expressões naturais que um aluno B1/B2 realmente poderia reutilizar;
- evite palavras isoladas;
- "note" deve explicar rapidamente uso/nuance em português.

Retorne SOMENTE JSON válido:
{
  "sentences": [
    {
      "startSec": 123.0,
      "endSec": 127.4,
      "en": "English sentence.",
      "pt": "Tradução natural."
    }
  ],
  "chunks": [
    {
      "en": "ended up doing",
      "pt": "acabou fazendo",
      "note": "Usado para um resultado final, muitas vezes não planejado."
    }
  ]
}
`.trim();

    let lastDiagnostic = "";
    let lastStatus = 502;

    for (const model of models) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    fileData: {
                      fileUri: canonicalYouTubeUrl,
                      mimeType: "video/*"
                    },
                    videoMetadata: {
                      startOffset: `${clipStart}s`,
                      endOffset: `${clipEnd}s`
                    }
                  },
                  { text: prompt }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.1
            }
          })
        }
      );

      if (response.ok) {
        const payload = await response.json() as Record<string, any>;
        const outputText = String(
          payload?.candidates?.[0]?.content?.parts
            ?.map((part: Record<string, unknown>) => String(part?.text ?? ""))
            .join("") ?? ""
        ).trim();

        if (!outputText) {
          lastDiagnostic = `${model}: resposta sem texto`;
          continue;
        }

        try {
          const normalized = normalizeDetails(
            JSON.parse(cleanJson(outputText)),
            clipStart,
            clipEnd
          );

          const coveredSeconds = normalized.sentences.reduce(
            (sum, item) => sum + Math.max(0, item.endSec - item.startSec),
            0
          );
          const coverageRatio = coveredSeconds / Math.max(1, clipEnd - clipStart);

          let largestGap = 0;
          for (let i = 1; i < normalized.sentences.length; i += 1) {
            largestGap = Math.max(
              largestGap,
              normalized.sentences[i].startSec - normalized.sentences[i - 1].endSec
            );
          }

          // Selected ShadowCut clips are intentionally speech-heavy. Very sparse
          // cue coverage usually means the model skipped spoken material.
          if (coverageRatio < 0.5 || largestGap > 5.5) {
            lastDiagnostic = `${model}: legenda muito esparsa (cobertura ${Math.round(
              coverageRatio * 100
            )}%, maior intervalo ${largestGap.toFixed(1)}s)`;
            console.error("Clip subtitle coverage rejected", {
              model,
              coverageRatio,
              largestGap,
              sentenceCount: normalized.sentences.length
            });
            continue;
          }

          return NextResponse.json({
            ...normalized,
            detailsVersion: 2
          });
        } catch (error) {
          lastDiagnostic = `${model}: resposta incompleta ou inválida`;
          console.error("Clip details parse", model, outputText.slice(0, 1500), error);
          continue;
        }
      }

      const detail = await response.text();
      console.error("Clip details Gemini", model, response.status, detail);

      let apiMessage = "";
      let apiCode = "";
      try {
        const parsed = JSON.parse(detail);
        apiMessage = String(parsed?.error?.message ?? "").trim();
        apiCode = String(parsed?.error?.status ?? parsed?.error?.code ?? "").trim();
      } catch {}

      lastDiagnostic = [model, apiCode, apiMessage].filter(Boolean).join(": ");
      lastStatus = response.status;

      const retryable =
        [429, 500, 502, 503, 504].includes(response.status) ||
        ["UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL"].includes(apiCode);

      if (!retryable) break;
    }

    return NextResponse.json(
      {
        error: lastDiagnostic
          ? `Gemini: ${lastDiagnostic}`
          : "Não consegui transcrever este corte."
      },
      { status: lastStatus === 429 ? 429 : 502 }
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro inesperado." },
      { status: 500 }
    );
  }
}
