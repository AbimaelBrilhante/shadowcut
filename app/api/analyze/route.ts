import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeId } from "../../../lib/youtube";
import type { AnalysisResult } from "../../../lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

function cleanJson(text: string) {
  return text.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/i, "").trim();
}

function normalize(value: unknown, videoId: string, sourceUrl: string): AnalysisResult {
  if (!value || typeof value !== "object") throw new Error("Resposta vazia da IA.");

  const data = value as Record<string, unknown>;
  const rawClips = Array.isArray(data.clips) ? data.clips : [];

  const clips = rawClips.map((raw, index) => {
    const c = raw as Record<string, unknown>;
    const startSec = Number(c.startSec);
    const endSec = Number(c.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;

    const rawSentences = Array.isArray(c.sentences) ? c.sentences : [];
    const sentences = rawSentences.map((rawSentence) => {
      const s = rawSentence as Record<string, unknown>;
      const start = Number(s.startSec);
      const end = Number(s.endSec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

      return {
        startSec: start,
        endSec: end,
        en: String(s.en ?? "").trim(),
        pt: String(s.pt ?? "").trim()
      };
    }).filter(Boolean) as AnalysisResult["clips"][number]["sentences"];

    return {
      id: String(c.id ?? `clip-${index + 1}`),
      title: String(c.title ?? `Trecho ${index + 1}`).trim(),
      startSec,
      endSec,
      why: String(c.why ?? "Bom trecho para shadowing.").trim(),
      difficulty: String(c.difficulty ?? "B1-B2").trim(),
      sentences
    };
  }).filter(Boolean) as AnalysisResult["clips"];

  if (!clips.length) throw new Error("A IA não encontrou cortes utilizáveis neste vídeo.");

  return {
    videoTitle: String(data.videoTitle ?? "Vídeo do YouTube"),
    videoId,
    sourceUrl,
    clips
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sourceUrl = String(body?.url ?? "").trim();
    const videoId = extractYouTubeId(sourceUrl);

    if (!videoId) {
      return NextResponse.json({ error: "Cole um link válido do YouTube." }, { status: 400 });
    }

    const canonicalYouTubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const rawApiKey = process.env.GEMINI_API_KEY ?? "";
    const apiKey = rawApiKey.trim().replace(/^["\']|["\']$/g, "");
    const preferredModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const models = Array.from(
      new Set([preferredModel, "gemini-3.5-flash-lite", "gemini-3.5-flash"])
    );

    if (!apiKey) {
      return NextResponse.json(
        { error: "A chave gratuita do Gemini ainda não foi configurada no servidor." },
        { status: 500 }
      );
    }

    const prompt = `
Você é o motor do ShadowCut, um aplicativo pessoal para treino de shadowing em inglês.

Analise este vídeo público do YouTube e escolha automaticamente até 5 dos MELHORES trechos para um estudante de inglês intermediário praticar shadowing.

REGRAS DOS CORTES:
- preferência por 60 a 120 segundos;
- excepcionalmente 45 a 120 segundos se isso preservar uma ideia completa;
- começar no início natural de uma frase ou ideia;
- terminar no fim natural de uma frase ou ideia;
- ser compreensível sem depender muito do trecho anterior;
- priorizar fala clara, natural e útil;
- evitar música, propaganda, silêncio longo, fala simultânea e ruído;
- não escolher um trecho só porque parece viral: o objetivo é APRENDER INGLÊS.

PARA CADA CORTE:
- dê um título curto em português;
- informe timestamps absolutos em segundos;
- estime dificuldade: B1, B1-B2 ou B2;
- explique em uma frase por que o trecho é bom para shadowing.

IMPORTANTE:
- nesta etapa NÃO transcreva as falas; uma segunda etapa fará a transcrição detalhada apenas do corte estudado;
- respeite a ordem cronológica;
- retorne SOMENTE JSON válido, sem markdown.

FORMATO:
{
  "videoTitle": "título",
  "clips": [
    {
      "id": "clip-1",
      "title": "título curto",
      "startSec": 123.0,
      "endSec": 205.0,
      "why": "motivo curto",
      "difficulty": "B1-B2"
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
                      fileUri: canonicalYouTubeUrl
                    }
                  },
                  {
                    text: prompt
                  }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2
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
          const finishReason = String(payload?.candidates?.[0]?.finishReason ?? "");
          lastDiagnostic = finishReason
            ? `${model}: resposta sem texto (motivo: ${finishReason})`
            : `${model}: resposta sem texto utilizável`;
          continue;
        }

        try {
          return NextResponse.json(
            normalize(JSON.parse(cleanJson(outputText)), videoId, canonicalYouTubeUrl)
          );
        } catch (parseError) {
          lastDiagnostic = `${model}: respondeu, mas o JSON veio inválido`;
          console.error("Gemini invalid JSON", model, outputText.slice(0, 1200), parseError);
          continue;
        }
      }

      const detail = await response.text();
      console.error("Gemini generateContent", model, response.status, detail);

      let apiMessage = "";
      let apiCode = "";
      try {
        const parsed = JSON.parse(detail);
        apiMessage = String(parsed?.error?.message ?? "").trim();
        apiCode = String(parsed?.error?.status ?? parsed?.error?.code ?? "").trim();
      } catch {}

      const diagnostic = [apiCode, apiMessage].filter(Boolean).join(" — ");
      lastDiagnostic = diagnostic
        ? `${model}: ${diagnostic}`
        : `${model}: erro ${response.status}`;
      lastStatus = response.status;

      const retryable =
        [429, 500, 502, 503, 504].includes(response.status) ||
        ["UNAVAILABLE", "RESOURCE_EXHAUSTED", "INTERNAL"].includes(apiCode);

      if (!retryable) break;
    }

    if (lastStatus === 429) {
      return NextResponse.json(
        { error: "A cota gratuita dos modelos disponíveis foi atingida. Tente novamente depois." },
        { status: 429 }
      );
    }

    return NextResponse.json(
      {
        error: lastDiagnostic
          ? `Gemini: ${lastDiagnostic}`
          : "Não consegui analisar o vídeo com os modelos gratuitos disponíveis."
      },
      { status: 502 }
    );
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
