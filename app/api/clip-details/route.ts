import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeId } from "../../../lib/youtube";
import type { Chunk, Sentence } from "../../../lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWindow(
  value: unknown,
  windowStart: number,
  windowEnd: number
): { sentences: Sentence[]; chunks: Chunk[] } {
  if (!value || typeof value !== "object") {
    throw new Error("Resposta vazia.");
  }

  const data = value as Record<string, unknown>;
  const rawSentences = Array.isArray(data.sentences) ? data.sentences : [];
  const rawChunks = Array.isArray(data.chunks) ? data.chunks : [];
  const windowDuration = windowEnd - windowStart;

  const sentences = rawSentences
    .map((raw) => {
      const s = raw as Record<string, unknown>;
      let startSec = Number(s.startSec);
      let endSec = Number(s.endSec);

      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        return null;
      }

      if (
        startSec >= -0.5 &&
        endSec <= windowDuration + 1.5 &&
        windowStart > 2
      ) {
        startSec += windowStart;
        endSec += windowStart;
      }

      startSec = Math.max(windowStart, Math.min(startSec, windowEnd));
      endSec = Math.max(startSec + 0.08, Math.min(endSec, windowEnd));

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
    .filter(Boolean) as Chunk[];

  if (!sentences.length) {
    throw new Error("Janela sem transcrição utilizável.");
  }

  return { sentences, chunks };
}

function mergeSentences(items: Sentence[], clipStart: number, clipEnd: number) {
  const sorted = items
    .filter((item) => item.endSec > clipStart && item.startSec < clipEnd)
    .sort((a, b) => a.startSec - b.startSec);

  const merged: Sentence[] = [];

  for (const item of sorted) {
    const current = {
      ...item,
      startSec: Math.max(clipStart, item.startSec),
      endSec: Math.min(clipEnd, item.endSec)
    };

    const normalized = normalizeText(current.en);
    if (!normalized) continue;

    const duplicateIndex = merged.findIndex((existing) => {
      const other = normalizeText(existing.en);
      const closeInTime = Math.abs(existing.startSec - current.startSec) <= 4;
      const sameText =
        other === normalized ||
        (other.length > 20 &&
          normalized.length > 20 &&
          (other.includes(normalized) || normalized.includes(other)));

      return closeInTime && sameText;
    });

    if (duplicateIndex >= 0) {
      const existing = merged[duplicateIndex];
      merged[duplicateIndex] = {
        ...existing,
        startSec: Math.min(existing.startSec, current.startSec),
        endSec: Math.max(existing.endSec, current.endSec),
        pt: existing.pt || current.pt
      };
      continue;
    }

    merged.push(current);
  }

  return merged.sort((a, b) => a.startSec - b.startSec);
}

function mergeChunks(items: Chunk[]) {
  const seen = new Set<string>();
  const result: Chunk[] = [];

  for (const item of items) {
    const key = normalizeText(item.en);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= 8) break;
  }

  return result;
}

async function requestWindow(params: {
  apiKey: string;
  model: string;
  youtubeUrl: string;
  startSec: number;
  endSec: number;
}) {
  const { apiKey, model, youtubeUrl, startSec, endSec } = params;
  const duration = endSec - startSec;

  const prompt = `
Você está transcrevendo uma janela CURTA de áudio de um vídeo para um exercício de shadowing.

JANELA EXATA:
- início no vídeo original: ${startSec.toFixed(1)}s
- fim no vídeo original: ${endSec.toFixed(1)}s
- duração: ${duration.toFixed(1)}s

TAREFA:
1. Ouça cuidadosamente TODO o áudio desta janela.
2. Transcreva TODO o inglês falado, sem resumir e sem pular frases.
3. Divida em cues curtos e naturais, geralmente de 2 a 6 segundos.
4. Traduza cada cue para português brasileiro.
5. NÃO extraia chunks nesta etapa. Priorize apenas a legenda.

TIMESTAMPS:
- startSec e endSec devem ser ABSOLUTOS no vídeo original.
- Se usar tempo relativo à janela, some ${startSec.toFixed(1)}s.
- Durante fala contínua, mantenha os cues consecutivos, sem lacunas artificiais.
- Não invente fala.
- Não use conhecimento externo para completar o que não ouviu.

Retorne SOMENTE JSON válido:
{
  "sentences": [
    {
      "startSec": 123.0,
      "endSec": 126.5,
      "en": "Exact English speech.",
      "pt": "Tradução natural."
    }
  ],
  "chunks": []
}
`.trim();

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
                  fileUri: youtubeUrl,
                  mimeType: "video/*"
                },
                videoMetadata: {
                  startOffset: `${startSec}s`,
                  endOffset: `${endSec}s`
                }
              },
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "minimal" }
        }
      })
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    let code = "";
    let message = "";

    try {
      const parsed = JSON.parse(detail);
      code = String(parsed?.error?.status ?? parsed?.error?.code ?? "").trim();
      message = String(parsed?.error?.message ?? "").trim();
    } catch {}

    const error = new Error(
      [model, code, message || `HTTP ${response.status}`]
        .filter(Boolean)
        .join(" — ")
    ) as Error & { status?: number; apiCode?: string };

    error.status = response.status;
    error.apiCode = code;
    throw error;
  }

  const payload = await response.json() as Record<string, any>;
  const outputText = String(
    payload?.candidates?.[0]?.content?.parts
      ?.map((part: Record<string, unknown>) => String(part?.text ?? ""))
      .join("") ?? ""
  ).trim();

  if (!outputText) {
    throw new Error(`${model}: resposta sem texto`);
  }

  return normalizeWindow(JSON.parse(cleanJson(outputText)), startSec, endSec);
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

    // Subtitle work favors the low-latency free-tier models. Do not fall back
    // to 3.8 Flash: capacity spikes there should never break a study session.
    const models = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
    const canonicalYouTubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const WINDOW_SECONDS = 30;
    const OVERLAP_SECONDS = 2;
    const windows: Array<{ startSec: number; endSec: number }> = [];

    let cursor = clipStart;
    while (cursor < clipEnd - 0.05) {
      const end = Math.min(clipEnd, cursor + WINDOW_SECONDS);
      windows.push({ startSec: cursor, endSec: end });
      if (end >= clipEnd) break;
      cursor = Math.max(cursor + 1, end - OVERLAP_SECONDS);
    }

    async function tryModel(
      window: { startSec: number; endSec: number },
      model: string
    ) {
      let lastError: unknown;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await requestWindow({
            apiKey,
            model,
            youtubeUrl: canonicalYouTubeUrl,
            startSec: window.startSec,
            endSec: window.endSec
          });
        } catch (error) {
          lastError = error;
          const typed = error as Error & { status?: number; apiCode?: string };
          const transient =
            [429, 500, 502, 503, 504].includes(typed.status ?? 0) ||
            ["UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL"].includes(
              typed.apiCode ?? ""
            );

          if (!transient || attempt === 1) break;
          await sleep(attempt === 0 ? 900 : 1800);
        }
      }

      throw lastError instanceof Error ? lastError : new Error("Falha na transcrição.");
    }

    async function processWindow(
      window: { startSec: number; endSec: number },
      allowSplit = true
    ): Promise<{ sentences: Sentence[]; chunks: Chunk[] }> {
      const diagnostics: string[] = [];

      for (const model of models) {
        try {
          return await tryModel(window, model);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Erro desconhecido";
          diagnostics.push(message);
          console.error("Subtitle window failed", { window, model, error: message });
        }
      }

      if (allowSplit && window.endSec - window.startSec > 18) {
        const midpoint = (window.startSec + window.endSec) / 2;
        const left = { startSec: window.startSec, endSec: Math.min(window.endSec, midpoint + 0.75) };
        const right = { startSec: Math.max(window.startSec, midpoint - 0.75), endSec: window.endSec };

        const settled = await Promise.allSettled([
          processWindow(left, false),
          processWindow(right, false)
        ]);

        const fulfilled = settled
          .filter((item): item is PromiseFulfilledResult<{ sentences: Sentence[]; chunks: Chunk[] }> => item.status === "fulfilled")
          .map((item) => item.value);

        if (fulfilled.length) {
          return {
            sentences: fulfilled.flatMap((item) => item.sentences),
            chunks: fulfilled.flatMap((item) => item.chunks)
          };
        }
      }

      throw new Error(diagnostics.at(-1) || "Janela indisponível temporariamente.");
    }

    const allSentences: Sentence[] = [];
    const allChunks: Chunk[] = [];
    const missingRanges: Array<{ startSec: number; endSec: number }> = [];
    const CONCURRENCY = 2;

    for (let i = 0; i < windows.length; i += CONCURRENCY) {
      const batch = windows.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((window) => processWindow(window)));

      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          allSentences.push(...result.value.sentences);
          allChunks.push(...result.value.chunks);
        } else {
          missingRanges.push(batch[index]);
          console.error("Subtitle range left unavailable", {
            window: batch[index],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          });
        }
      });
    }

    const sentences = mergeSentences(allSentences, clipStart, clipEnd);
    const chunks = mergeChunks(allChunks);

    if (!sentences.length) {
      return NextResponse.json(
        { error: "Os modelos de legenda estão temporariamente indisponíveis. Tente novamente em alguns minutos." },
        { status: 503 }
      );
    }

    return NextResponse.json({
      sentences,
      chunks,
      missingRanges,
      partial: missingRanges.length > 0,
      detailsVersion: 5
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro inesperado." },
      { status: 500 }
    );
  }
}
