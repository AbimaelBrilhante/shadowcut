import { NextRequest, NextResponse } from "next/server";
import type { Chunk, Sentence } from "../../../lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sentences = Array.isArray(body?.sentences)
      ? (body.sentences as Sentence[])
      : [];

    if (!sentences.length) {
      return NextResponse.json({ chunks: [] });
    }

    const rawApiKey = process.env.GEMINI_API_KEY ?? "";
    const apiKey = rawApiKey.trim().replace(/^["\']|["\']$/g, "");
    if (!apiKey) {
      return NextResponse.json({ chunks: [] });
    }

    const transcript = sentences
      .map((item) => item.en)
      .filter(Boolean)
      .join("\n");

    const prompt = `
A partir desta transcrição curta em inglês, escolha de 3 a 6 CHUNKS realmente úteis para um aluno B1/B2 praticar e reutilizar em conversas.

REGRAS:
- prefira expressões naturais de 2 ou mais palavras;
- evite palavras isoladas;
- evite frases específicas demais ao contexto;
- não invente expressões que não apareçam na transcrição;
- traduza naturalmente para PT-BR;
- a nota deve explicar rapidamente como/onde usar.

TRANSCRIÇÃO:
${transcript}

Retorne SOMENTE JSON válido:
{
  "chunks": [
    {
      "en": "ended up doing",
      "pt": "acabou fazendo",
      "note": "Usado para falar de um resultado final, muitas vezes não planejado."
    }
  ]
}
`.trim();

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: "minimal" }
          }
        })
      }
    );

    if (!response.ok) {
      console.error("Chunk generation failed", response.status, await response.text());
      return NextResponse.json({ chunks: [] });
    }

    const payload = await response.json() as Record<string, any>;
    const outputText = String(
      payload?.candidates?.[0]?.content?.parts
        ?.map((part: Record<string, unknown>) => String(part?.text ?? ""))
        .join("") ?? ""
    ).trim();

    if (!outputText) return NextResponse.json({ chunks: [] });

    const parsed = JSON.parse(cleanJson(outputText));
    const rawChunks = Array.isArray(parsed?.chunks) ? parsed.chunks : [];

    const chunks = rawChunks
      .map((raw: Record<string, unknown>) => ({
        en: String(raw?.en ?? "").trim(),
        pt: String(raw?.pt ?? "").trim(),
        note: String(raw?.note ?? "").trim()
      }))
      .filter((item: Chunk) => item.en && item.pt)
      .slice(0, 6);

    return NextResponse.json({ chunks });
  } catch (error) {
    console.error("Chunk generation", error);
    return NextResponse.json({ chunks: [] });
  }
}
