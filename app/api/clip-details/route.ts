import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeId } from "../../../lib/youtube";

export const runtime = "nodejs";

/**
 * English captions now come from the official YouTube player.
 *
 * This endpoint intentionally returns immediately instead of calling Gemini.
 * The previous automatic AI transcription path was slow and could fail during
 * model-capacity spikes, which blocked otherwise usable study sessions.
 * Translation/chunks can be generated separately on demand later without
 * affecting playback or native YouTube captions.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sourceUrl = String(body?.url ?? "").trim();
    const videoId = extractYouTubeId(sourceUrl);
    const startSec = Number(body?.startSec);
    const endSec = Number(body?.endSec);

    if (!videoId) {
      return NextResponse.json({ error: "Link do YouTube inválido." }, { status: 400 });
    }

    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      endSec <= startSec
    ) {
      return NextResponse.json({ error: "Intervalo do corte inválido." }, { status: 400 });
    }

    return NextResponse.json({
      sentences: [],
      chunks: [],
      partial: false,
      nativeCaptions: true,
      detailsVersion: 6
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro inesperado." },
      { status: 500 }
    );
  }
}
