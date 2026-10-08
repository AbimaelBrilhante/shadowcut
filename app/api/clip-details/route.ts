import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeId } from "../../../lib/youtube";
import type { Sentence } from "../../../lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function normalizeWindow(value: unknown, windowStart: number, windowEnd: number): Sentence[] {
  if (!value || typeof value !== "object") return [];
  const data = value as Record<string, unknown>;
  const raw = Array.isArray(data.sentences) ? data.sentences : [];
  const duration = windowEnd - windowStart;

  return raw
    .map((item) => {
      const row = item as Record<string, unknown>;
      let startSec = Number(row.startSec);
      let endSec = Number(row.endSec);
      const en = String(row.en ?? "").trim();
      const pt = String(row.pt ?? "").trim();

      if (!en || !pt || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        return null;
      }

      if (startSec >= -0.5 && endSec <= duration + 1.5 && windowStart > 1) {
        startSec += windowStart;
        endSec += windowStart;
      }

      startSec = Math.max(windowStart, Math.min(startSec, windowEnd));
      endSec = Math.max(startSec + 0.08, Math.min(endSec, windowEnd));
      return { startSec, endSec, en, pt };
    })
    .filter(Boolean)
    .sort((a, b) => (a as Sentence).startSec - (b as Sentence).startSec) as Sentence[];
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
}

function mergeSentences(items: Sentence[], clipStart: number, clipEnd: number) {
  const sorted = items
    .filter((item) => item.endSec > clipStart && item.startSec < clipEnd)
    .sort((a, b) => a.startSec - b.startSec);

  const merged: Sentence[] = [];
  for (const item of sorted) {
    const key = normalizeText(item.en);
    const duplicate = merged.findIndex((existing) => {
      const other = normalizeText(existing.en);
      return Math.abs(existing.startSec - item.startSec) <= 3 && (other === key || (other.length > 18 && key.length > 18 && (other.includes(key) || key.includes(other))));
    });

    if (duplicate >= 0) {
      merged[duplicate] = {
        ...merged[duplicate],
        startSec: Math.min(merged[duplicate].startSec, item.startSec),
        endSec: Math.max(merged[duplicate].endSec, item.endSec),
        pt: merged[duplicate].pt || item.pt
      };
    } else {
      merged.push(item);
    }
  }

  if (merged.length) {
    merged[0] = { ...merged[0], startSec: clipStart };
  }

  return merged;
}

async function transcribeWindow(params: {
  apiKey: string;
  model: string;
  youtubeUrl: string;
  startSec: number;
  endSec: number;
}) {
  const { apiKey, model, youtubeUrl, startSec, endSec } = params;
  const prompt = `
Analise somente esta janela curta do vídeo, de ${startSec.toFixed(1)}s a ${endSec.toFixed(1)}s.

Objetivo: criar material de estudo de inglês.
- transcreva TODO o inglês falado;
- divida em frases/cues curtos e naturais;
- traduza cada cue para português brasileiro;
- use timestamps ABSOLUTOS do vídeo original;
- não resuma e não invente falas.

Retorne SOMENTE JSON válido:
{
  "sentences": [
    {"startSec": 10.0, "endSec": 13.2, "en": "English sentence.", "pt": "Tradução em português."}
  ]
}`.trim();

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
                fileData: { fileUri: youtubeUrl, mimeType: "video/*" },
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
    throw new Error(`${model}: ${response.status} ${detail.slice(0, 180)}`);
  }

  const payload = await response.json() as Record<string, any>;
  const outputText = String(
    payload?.candidates?.[0]?.content?.parts
      ?.map((part: Record<string, unknown>) => String(part?.text ?? ""))
      .join("") ?? ""
  ).trim();

  if (!outputText) throw new Error(`${model}: resposta sem texto`);
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
    if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || clipEnd <= clipStart || clipEnd - clipStart > 180) {
      return NextResponse.json({ error: "Intervalo do corte inválido." }, { status: 400 });
    }

    const apiKey = String(process.env.GEMINI_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY não configurada." }, { status: 500 });
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const models = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
    const windows: Array<{ startSec: number; endSec: number }> = [];
    const windowSize = 35;
    const overlap = 2;

    let cursor = clipStart;
    while (cursor < clipEnd - 0.05) {
      const end = Math.min(clipEnd, cursor + windowSize);
      windows.push({ startSec: cursor, endSec: end });
      if (end >= clipEnd) break;
      cursor = end - overlap;
    }

    async function processWindow(window: { startSec: number; endSec: number }) {
      let lastError: Error | null = null;
      for (const model of models) {
        try {
          return await transcribeWindow({
            apiKey,
            model,
            youtubeUrl,
            startSec: window.startSec,
            endSec: window.endSec
          });
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("Falha desconhecida");
          console.error("Study aid window failed", window, model, lastError.message);
        }
      }
      throw lastError ?? new Error("Não consegui processar a janela.");
    }

    const settled = await Promise.allSettled(windows.map(processWindow));
    const sentences: Sentence[] = [];
    let failedWindows = 0;

    for (const result of settled) {
      if (result.status === "fulfilled") {
        sentences.push(...result.value);
      } else {
        failedWindows += 1;
      }
    }

    const merged = mergeSentences(sentences, clipStart, clipEnd);
    if (!merged.length) {
      return NextResponse.json(
        { error: "Não consegui preparar a tradução deste corte agora. Tente novamente em alguns minutos." },
        { status: 503 }
      );
    }

    return NextResponse.json({
      sentences: merged,
      chunks: [],
      partial: failedWindows > 0,
      nativeCaptions: true,
      detailsVersion: 7
    });
  } catch (error) {
    console.error("Study aid error", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro inesperado." },
      { status: 500 }
    );
  }
}
