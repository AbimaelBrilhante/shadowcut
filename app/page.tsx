"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YouTubePlayer, { type PlayerHandle } from "../components/YouTubePlayer";
import type {
  AnalysisResult,
  Clip,
  SavedSession,
  Sentence,
  SentenceAdjustment
} from "../lib/types";
import { extractYouTubeId, formatTime } from "../lib/youtube";
import {
  deleteSession,
  exportSessions,
  getSession,
  importSessions,
  listSessions,
  saveNewSession,
  saveSession
} from "../lib/history";

type SubtitleMode = "en" | "pt" | "both" | "off";

export default function Home() {
  const [url, setUrl] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>("en");
  const [revealTranslation, setRevealTranslation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailsLoadingId, setDetailsLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<SavedSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [studiedClipIds, setStudiedClipIds] = useState<string[]>([]);
  const [sentenceAdjustments, setSentenceAdjustments] = useState<
    Record<string, SentenceAdjustment>
  >({});
  const [loadedFromHistory, setLoadedFromHistory] = useState(false);

  const [autoMode, setAutoMode] = useState(false);
  const [autoRepeats, setAutoRepeats] = useState(2);
  const [autoPauseSec, setAutoPauseSec] = useState(2);
  const [autoStatus, setAutoStatus] = useState("");

  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);

  const player = useRef<PlayerHandle>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const autoTimerRef = useRef<number | null>(null);
  const autoRef = useRef({ active: false, index: 0, iteration: 1 });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);

  const clip: Clip | null = analysis?.clips[selected] ?? null;

  useEffect(() => {
    void refreshHistory();

    return () => {
      if (autoTimerRef.current !== null) window.clearTimeout(autoTimerRef.current);
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    };
    // recordingUrl is intentionally not a dependency: cleanup runs on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshHistory() {
    try {
      setHistory(await listSessions());
    } catch {
      // IndexedDB can be unavailable in some private browsing contexts.
    }
  }

  function applySavedSession(
    session: SavedSession,
    message = "Sessão salva aberta — 0 chamadas à IA."
  ) {
    const index = Math.max(
      0,
      Math.min(session.lastClipIndex ?? 0, session.analysis.clips.length - 1)
    );

    stopAutoShadowing();
    setAnalysis(session.analysis);
    setUrl(session.analysis.sourceUrl);
    setSelected(index);
    setCurrentTime(session.analysis.clips[index]?.startSec ?? 0);
    setStudiedClipIds(session.studiedClipIds ?? []);
    setSentenceAdjustments(session.sentenceAdjustments ?? {});
    setLoadedFromHistory(true);
    setShowHistory(false);
    setRevealTranslation(false);
    setError("");
    setNotice(message);
  }

  async function openSavedSession(session: SavedSession) {
    applySavedSession(session);
    await ensureClipDetails(session.analysis, session.lastClipIndex ?? 0);
  }

  function adjustmentKey(clipId: string, sentenceIndex: number) {
    return `${clipId}:${sentenceIndex}`;
  }

  function adjustedSentenceAt(
    index: number,
    targetClip: Clip | null = clip
  ): Sentence | null {
    if (!targetClip?.sentences?.[index]) return null;

    const original = targetClip.sentences[index];
    const adjustment =
      sentenceAdjustments[adjustmentKey(targetClip.id, index)] ?? {
        startDelta: 0,
        endDelta: 0
      };

    const startSec = Math.max(
      targetClip.startSec,
      original.startSec + adjustment.startDelta
    );
    const endSec = Math.min(
      targetClip.endSec,
      original.endSec + adjustment.endDelta
    );

    return {
      ...original,
      startSec,
      endSec: Math.max(startSec + 0.08, endSec)
    };
  }

  const sentenceIndex = useMemo(() => {
    if (!clip?.sentences?.length) return -1;

    for (let i = 0; i < clip.sentences.length; i += 1) {
      const original = clip.sentences[i];
      const adjustment =
        sentenceAdjustments[adjustmentKey(clip.id, i)] ?? {
          startDelta: 0,
          endDelta: 0
        };

      const startSec = Math.max(
        clip.startSec,
        original.startSec + adjustment.startDelta
      );
      const endSec = Math.min(
        clip.endSec,
        original.endSec + adjustment.endDelta
      );

      if (currentTime >= startSec - 0.18 && currentTime <= endSec + 0.18) {
        return i;
      }
    }

    // Do not keep the previous subtitle on screen during a gap.
    return -1;
  }, [clip, currentTime, sentenceAdjustments]);

  const sentence: Sentence | null =
    sentenceIndex >= 0 ? adjustedSentenceAt(sentenceIndex) : null;

  const onTime = useCallback((time: number) => setCurrentTime(time), []);

  async function ensureClipDetails(
    baseAnalysis: AnalysisResult,
    index: number
  ): Promise<AnalysisResult> {
    const safeIndex = Math.max(0, Math.min(index, baseAnalysis.clips.length - 1));
    const target = baseAnalysis.clips[safeIndex];
    if (!target || target.detailsReady) return baseAnalysis;

    setDetailsLoadingId(target.id);
    setError("");

    try {
      const res = await fetch("/api/clip-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: baseAnalysis.sourceUrl,
          startSec: target.startSec,
          endSec: target.endSec,
          title: target.title
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Não consegui preparar a legenda deste corte.");
      }

      const nextAnalysis: AnalysisResult = {
        ...baseAnalysis,
        clips: baseAnalysis.clips.map((item, itemIndex) =>
          itemIndex === safeIndex
            ? {
                ...item,
                sentences: data.sentences ?? [],
                chunks: data.chunks ?? [],
                detailsReady: true
              }
            : item
        )
      };

      setAnalysis(nextAnalysis);

      const session = await getSession(baseAnalysis.videoId);
      if (session) {
        session.analysis = nextAnalysis;
        session.lastClipIndex = safeIndex;
        await saveSession(session);
      }

      await refreshHistory();
      return nextAnalysis;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Não consegui preparar a legenda deste corte."
      );
      return baseAnalysis;
    } finally {
      setDetailsLoadingId(null);
    }
  }

  async function analyze(force = false) {
    const input = url.trim();
    if (!input) return;

    const videoId = extractYouTubeId(input);
    if (!videoId) {
      setError("Cole um link válido do YouTube.");
      return;
    }

    setError("");
    setNotice("");

    if (!force) {
      try {
        const saved = await getSession(videoId);
        if (saved) {
          applySavedSession(saved);
          void ensureClipDetails(
            saved.analysis,
            Math.max(0, saved.lastClipIndex ?? 0)
          );
          return;
        }
      } catch {
        // If local history fails, analysis can still continue normally.
      }
    }

    setLoading(true);
    setAnalysis(null);
    setStudiedClipIds([]);
    setSentenceAdjustments({});
    setLoadedFromHistory(false);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: input })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Não foi possível analisar o vídeo.");

      const saved = await saveNewSession(data);
      setAnalysis(data);
      setSelected(0);
      setCurrentTime(data.clips[0]?.startSec ?? 0);
      setStudiedClipIds(saved.studiedClipIds);
      setSentenceAdjustments(saved.sentenceAdjustments ?? {});
      setNotice(
        "Cortes encontrados e salvos. A legenda detalhada é preparada só para o corte que você abrir."
      );
      await refreshHistory();
      void ensureClipDetails(data, 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setLoading(false);
    }
  }

  async function persistProgress(nextStudied: string[], nextIndex: number) {
    if (!analysis) return;

    try {
      const session = await getSession(analysis.videoId);
      if (!session) return;
      session.studiedClipIds = nextStudied;
      session.lastClipIndex = nextIndex;
      session.sentenceAdjustments = sentenceAdjustments;
      await saveSession(session);
      await refreshHistory();
    } catch {
      // Practice should not be blocked by a local persistence error.
    }
  }

  async function persistAdjustments(
    nextAdjustments: Record<string, SentenceAdjustment>
  ) {
    if (!analysis) return;

    try {
      const session = await getSession(analysis.videoId);
      if (!session) return;
      session.sentenceAdjustments = nextAdjustments;
      session.lastClipIndex = selected;
      await saveSession(session);
    } catch {
      // Local timing tweaks are best-effort.
    }
  }

  async function playClip() {
    if (!analysis || !clip) return;
    stopAutoShadowing();

    const hydrated = await ensureClipDetails(analysis, selected);
    const target = hydrated.clips[selected];
    if (!target) return;

    player.current?.playRange(target.startSec, target.endSec);
    player.current?.setRate(rate);
  }

  async function selectClip(index: number) {
    if (!analysis) return;
    const next = analysis.clips[index];
    if (!next) return;

    stopAutoShadowing();
    setSelected(index);
    setCurrentTime(next.startSec);
    setRevealTranslation(false);
    void persistProgress(studiedClipIds, index);

    const hydrated = await ensureClipDetails(analysis, index);
    const target = hydrated.clips[index];
    if (!target) return;

    player.current?.playRange(target.startSec, target.endSec);
    player.current?.setRate(rate);
  }

  function playSentenceAt(index: number) {
    const target = adjustedSentenceAt(index);
    if (!target) return;

    setCurrentTime(target.startSec);
    player.current?.playRange(target.startSec, target.endSec);
    player.current?.setRate(rate);
  }

  function repeatSentence() {
    if (!sentence) return;
    stopAutoShadowing();
    player.current?.playRange(sentence.startSec, sentence.endSec);
    player.current?.setRate(rate);
  }

  function goSentence(direction: -1 | 1) {
    if (!clip?.sentences?.length) return;

    const baseIndex = sentenceIndex >= 0 ? sentenceIndex : 0;
    const nextIndex = Math.max(
      0,
      Math.min(clip.sentences.length - 1, baseIndex + direction)
    );
    stopAutoShadowing();
    playSentenceAt(nextIndex);
  }

  function changeRate(next: number) {
    setRate(next);
    player.current?.setRate(next);
  }

  async function startAutoShadowing() {
    if (!analysis || !clip) return;

    const hydrated = await ensureClipDetails(analysis, selected);
    const targetClip = hydrated.clips[selected];

    if (!targetClip?.sentences?.length) {
      setError("Este corte ainda não tem frases suficientes para o modo automático.");
      return;
    }

    const initialIndex =
      sentenceIndex >= 0 &&
      sentenceIndex < targetClip.sentences.length
        ? sentenceIndex
        : 0;

    autoRef.current = { active: true, index: initialIndex, iteration: 1 };
    setAutoMode(true);
    setAutoStatus(
      `Frase ${initialIndex + 1}/${targetClip.sentences.length} · repetição 1/${autoRepeats}`
    );
    playSentenceAt(initialIndex);
  }

  function stopAutoShadowing() {
    autoRef.current.active = false;
    if (autoTimerRef.current !== null) {
      window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setAutoMode(false);
    setAutoStatus("");
    player.current?.pause();
  }

  function handleRangeEnd() {
    if (!autoRef.current.active || !clip?.sentences?.length) return;

    const state = autoRef.current;
    const repeatSame = state.iteration < autoRepeats;
    const nextIndex = repeatSame ? state.index : state.index + 1;
    const nextIteration = repeatSame ? state.iteration + 1 : 1;

    if (nextIndex >= clip.sentences.length) {
      stopAutoShadowing();
      setNotice("Sessão automática concluída. Você pode marcar o corte como estudado.");
      return;
    }

    setAutoStatus(
      repeatSame
        ? `Pausa para repetir… depois repetição ${nextIteration}/${autoRepeats}`
        : `Pausa para você falar… depois frase ${nextIndex + 1}/${clip.sentences.length}`
    );

    autoTimerRef.current = window.setTimeout(() => {
      if (!autoRef.current.active) return;
      autoRef.current = {
        active: true,
        index: nextIndex,
        iteration: nextIteration
      };
      setAutoStatus(
        `Frase ${nextIndex + 1}/${clip.sentences.length} · repetição ${nextIteration}/${autoRepeats}`
      );
      playSentenceAt(nextIndex);
    }, autoPauseSec * 1000);
  }

  function toggleStudied() {
    if (!clip) return;

    const isStudied = studiedClipIds.includes(clip.id);
    const next = isStudied
      ? studiedClipIds.filter((id) => id !== clip.id)
      : [...studiedClipIds, clip.id];

    setStudiedClipIds(next);
    void persistProgress(next, selected);
  }

  function adjustBoundary(
    boundary: "startDelta" | "endDelta",
    amount: number
  ) {
    if (!clip || sentenceIndex < 0 || !sentence) return;

    const key = adjustmentKey(clip.id, sentenceIndex);
    const current = sentenceAdjustments[key] ?? {
      startDelta: 0,
      endDelta: 0
    };

    const nextEntry = {
      ...current,
      [boundary]: Math.max(-3, Math.min(3, current[boundary] + amount))
    };

    const original = clip.sentences[sentenceIndex];
    const proposedStart = original.startSec + nextEntry.startDelta;
    const proposedEnd = original.endSec + nextEntry.endDelta;
    if (proposedEnd - proposedStart < 0.25) return;

    const next = {
      ...sentenceAdjustments,
      [key]: nextEntry
    };

    setSentenceAdjustments(next);
    void persistAdjustments(next);
  }

  function resetSentenceAdjustment() {
    if (!clip || sentenceIndex < 0) return;

    const key = adjustmentKey(clip.id, sentenceIndex);
    const next = { ...sentenceAdjustments };
    delete next[key];
    setSentenceAdjustments(next);
    void persistAdjustments(next);
  }

  async function startRecording() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("A gravação de áudio não está disponível neste navegador.");
      }

      stopAutoShadowing();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || "audio/webm"
        });

        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
        const nextUrl = URL.createObjectURL(blob);
        setRecordingUrl(nextUrl);

        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        setIsRecording(false);
      };

      recorder.start();
      setIsRecording(true);
      setNotice("Gravando sua voz. Fale a frase e depois toque em Parar.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não consegui acessar o microfone."
      );
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }

  function buildRecallPack() {
    if (!analysis || !clip) return "";

    const chunkLines = (clip.chunks ?? [])
      .map(
        (chunk, index) =>
          `${index + 1}. ${chunk.en}\n   PT: ${chunk.pt}\n   Nota: ${chunk.note}`
      )
      .join("\n\n");

    const transcript = (clip.sentences ?? [])
      .map((item) => `${item.en}\nPT: ${item.pt}`)
      .join("\n\n");

    return `SHADOWCUT → RECALL

Vídeo: ${analysis.videoTitle}
URL: ${analysis.sourceUrl}
Trecho: ${formatTime(clip.startSec)} → ${formatTime(clip.endSec)}

CHUNKS RECOMENDADOS
${chunkLines || "Nenhum chunk gerado."}

TRANSCRIÇÃO DO TRECHO
${transcript}

Pedido: revise os chunks, elimine os pouco úteis, evite duplicatas e adicione os melhores ao meu Recall.`;
  }

  async function copyRecallPack() {
    const text = buildRecallPack();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      setNotice("Pacote copiado. Cole no ChatGPT e peça para adicionar ao Recall.");
    } catch {
      setError("Não consegui copiar. Use o botão Compartilhar.");
    }
  }

  async function shareRecallPack() {
    const text = buildRecallPack();
    if (!text) return;

    if (navigator.share) {
      try {
        await navigator.share({
          title: "ShadowCut → Recall",
          text
        });
        return;
      } catch {
        // User may have cancelled the share sheet.
      }
    }

    await copyRecallPack();
  }

  async function removeSavedSession(videoId: string) {
    if (!window.confirm("Excluir esta sessão salva do aparelho?")) return;

    await deleteSession(videoId);
    if (analysis?.videoId === videoId) {
      stopAutoShadowing();
      setAnalysis(null);
      setStudiedClipIds([]);
      setSentenceAdjustments({});
      setNotice("");
    }
    await refreshHistory();
  }

  async function downloadBackup() {
    const json = await exportSessions();
    const blob = new Blob([json], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `shadowcut-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(href);
  }

  async function restoreBackup(file: File) {
    try {
      const count = await importSessions(await file.text());
      await refreshHistory();
      setNotice(`Backup importado: ${count} sessão(ões).`);
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não consegui importar o backup."
      );
    }
  }

  const progress = clip
    ? Math.max(
        0,
        Math.min(
          100,
          ((currentTime - clip.startSec) / (clip.endSec - clip.startSec)) * 100
        )
      )
    : 0;

  const studiedCurrent = clip ? studiedClipIds.includes(clip.id) : false;
  const detailsLoading = clip ? detailsLoadingId === clip.id : false;
  const latestSession = history[0] ?? null;

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>ShadowCut</span>
        </div>
        <div className="top-actions">
          <button
            className="history-toggle"
            onClick={() => setShowHistory((value) => !value)}
          >
            Histórico {history.length > 0 ? `(${history.length})` : ""}
          </button>
          <span className="pill">MVP 0.6 · pessoal</span>
        </div>
      </header>

      {showHistory && (
        <section className="history-panel">
          <div className="history-head">
            <div>
              <p className="eyebrow">SALVO NESTE APARELHO</p>
              <h2>Seu histórico</h2>
            </div>
            <div className="history-tools">
              <button
                className="secondary compact"
                onClick={downloadBackup}
                disabled={!history.length}
              >
                Exportar
              </button>
              <button
                className="secondary compact"
                onClick={() => importInput.current?.click()}
              >
                Importar
              </button>
              <input
                ref={importInput}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void restoreBackup(file);
                  e.currentTarget.value = "";
                }}
              />
            </div>
          </div>

          {!history.length ? (
            <p className="muted history-empty">Nenhuma sessão salva ainda.</p>
          ) : (
            <div className="history-list">
              {history.map((session) => {
                const done = session.studiedClipIds?.length ?? 0;
                const total = session.analysis.clips.length;
                return (
                  <article className="history-card" key={session.videoId}>
                    <div className="history-card-main">
                      <span className="history-progress">
                        {done}/{total} estudados
                      </span>
                      <h3>{session.analysis.videoTitle}</h3>
                      <p>
                        {total} cortes · atualizado em{" "}
                        {new Date(session.updatedAt).toLocaleDateString("pt-BR")}
                      </p>
                    </div>
                    <div className="history-card-actions">
                      <button
                        className="primary compact"
                        onClick={() => void openSavedSession(session)}
                      >
                        Continuar
                      </button>
                      <button
                        className="danger-button compact"
                        onClick={() => void removeSavedSession(session.videoId)}
                      >
                        Excluir
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <p className="history-footnote">
            O histórico fica no Safari deste aparelho. Use Exportar para ter um backup.
          </p>
        </section>
      )}

      <section className="hero">
        <p className="eyebrow">YOUTUBE → SHADOWING</p>
        <h1>
          Transforme vídeos longos em <span>treinos curtos de inglês.</span>
        </h1>
        <p className="hero-copy">
          Cole um vídeo público do YouTube. O ShadowCut escolhe os melhores trechos,
          guarda seu progresso e prepara a legenda completa apenas do corte que você estudar.
        </p>

        <div className="url-box">
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void analyze()}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-label="URL do YouTube"
          />
          <button onClick={() => void analyze()} disabled={loading || !url.trim()}>
            {loading ? "Analisando…" : "Criar sessão"}
          </button>
        </div>

        <p className="hint">
          Se o vídeo já estiver salvo, ele abre do histórico sem repetir a análise principal.
        </p>

        {notice && (
          <div className="notice">
            <span>{notice}</span>
            {loadedFromHistory && (
              <button onClick={() => void analyze(true)}>Analisar novamente</button>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </section>

      {!analysis && !loading && latestSession && (
        <section className="continue-card">
          <div>
            <p className="eyebrow">CONTINUE DE ONDE PAROU</p>
            <h2>{latestSession.analysis.videoTitle}</h2>
            <p>
              {latestSession.studiedClipIds?.length ?? 0}/
              {latestSession.analysis.clips.length} cortes estudados
            </p>
          </div>
          <button
            className="primary"
            onClick={() => void openSavedSession(latestSession)}
          >
            Continuar estudo
          </button>
        </section>
      )}

      {loading && (
        <section className="loading-card">
          <div className="spinner" />
          <div>
            <strong>Procurando os melhores trechos…</strong>
            <p>A primeira análise de um vídeo longo pode levar um pouco.</p>
          </div>
        </section>
      )}

      {analysis && clip && (
        <section className="workspace">
          <div className="player-column">
            <div className="card">
              <div className="card-head">
                <div>
                  <span className="clip-label">CORTE {selected + 1}</span>
                  <h2>{clip.title}</h2>
                </div>
                <span className="duration">
                  {formatTime(clip.endSec - clip.startSec)}
                </span>
              </div>

              <YouTubePlayer
                ref={player}
                videoId={analysis.videoId}
                onTime={onTime}
                onRangeEnd={handleRangeEnd}
              />

              {detailsLoading && (
                <div className="detail-loading">
                  <span className="mini-spinner" />
                  Preparando legenda completa, tradução e chunks deste corte…
                </div>
              )}

              <button
                className="play-clip"
                onClick={() => void playClip()}
                disabled={detailsLoading}
              >
                ▶ Tocar este corte
              </button>

              <div className="subtitle-stage">
                {detailsLoading && !clip.sentences?.length ? (
                  <span className="muted">Preparando a legenda deste corte…</span>
                ) : subtitleMode === "off" ? (
                  <span className="muted">Legendas ocultas</span>
                ) : sentence ? (
                  <>
                    {(subtitleMode === "en" || subtitleMode === "both") && (
                      <div className="subtitle-en">{sentence.en}</div>
                    )}
                    {(subtitleMode === "pt" ||
                      subtitleMode === "both" ||
                      (subtitleMode === "en" && revealTranslation)) && (
                      <div className="subtitle-pt">{sentence.pt}</div>
                    )}
                  </>
                ) : (
                  <span className="muted">
                    {clip.detailsReady
                      ? "Sem fala neste instante."
                      : "Toque o corte para preparar as frases."}
                  </span>
                )}
              </div>

              {subtitleMode === "en" && sentence && (
                <button
                  className="translation-toggle"
                  onClick={() => setRevealTranslation((value) => !value)}
                >
                  {revealTranslation ? "Ocultar tradução" : "Mostrar tradução"}
                </button>
              )}

              <div className="timeline-row">
                <span>{formatTime(Math.max(0, currentTime - clip.startSec))}</span>
                <div className="progress">
                  <i style={{ width: `${progress}%` }} />
                </div>
                <span>{formatTime(clip.endSec - clip.startSec)}</span>
              </div>

              <div className="controls">
                <button
                  className="secondary"
                  onClick={() => goSentence(-1)}
                  disabled={!clip.sentences?.length}
                >
                  ← frase
                </button>
                <button
                  className="primary"
                  onClick={repeatSentence}
                  disabled={!sentence}
                >
                  ↻ repetir
                </button>
                <button
                  className="secondary"
                  onClick={() => goSentence(1)}
                  disabled={!clip.sentences?.length}
                >
                  frase →
                </button>
              </div>

              <section className="practice-box">
                <div className="practice-head">
                  <div>
                    <span className="small-label">MODO SHADOWING</span>
                    <strong>Ouvir → pausa para falar → repetir</strong>
                  </div>
                  <button
                    className={autoMode ? "danger-button compact" : "primary compact"}
                    onClick={() =>
                      autoMode ? stopAutoShadowing() : void startAutoShadowing()
                    }
                    disabled={!clip.sentences?.length || detailsLoading}
                  >
                    {autoMode ? "Parar" : "Iniciar automático"}
                  </button>
                </div>

                {autoStatus && <p className="auto-status">{autoStatus}</p>}

                <div className="practice-settings">
                  <div>
                    <label>Repetições por frase</label>
                    <div className="segmented three">
                      {[1, 2, 3].map((value) => (
                        <button
                          key={value}
                          className={autoRepeats === value ? "active" : ""}
                          onClick={() => setAutoRepeats(value)}
                          disabled={autoMode}
                        >
                          {value}x
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label>Pausa para você falar</label>
                    <div className="segmented three">
                      {[2, 3, 4].map((value) => (
                        <button
                          key={value}
                          className={autoPauseSec === value ? "active" : ""}
                          onClick={() => setAutoPauseSec(value)}
                          disabled={autoMode}
                        >
                          {value}s
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <button
                className={studiedCurrent ? "studied-button active" : "studied-button"}
                onClick={toggleStudied}
              >
                {studiedCurrent ? "✓ Corte estudado" : "Marcar corte como estudado"}
              </button>

              {sentence && sentenceIndex >= 0 && (
                <section className="timing-box">
                  <div className="timing-head">
                    <div>
                      <span className="small-label">AJUSTE FINO DA FRASE</span>
                      <strong>
                        {formatTime(sentence.startSec)} → {formatTime(sentence.endSec)}
                      </strong>
                    </div>
                    <button className="link-button" onClick={resetSentenceAdjustment}>
                      Resetar
                    </button>
                  </div>

                  <div className="timing-controls">
                    <button onClick={() => adjustBoundary("startDelta", -0.5)}>
                      Início −0,5s
                    </button>
                    <button onClick={() => adjustBoundary("startDelta", 0.5)}>
                      Início +0,5s
                    </button>
                    <button onClick={() => adjustBoundary("endDelta", -0.5)}>
                      Fim −0,5s
                    </button>
                    <button onClick={() => adjustBoundary("endDelta", 0.5)}>
                      Fim +0,5s
                    </button>
                  </div>
                </section>
              )}

              <section className="recording-box">
                <div>
                  <span className="small-label">COMPARE SUA VOZ</span>
                  <strong>Grave sua repetição e ouça ao lado do original.</strong>
                </div>
                <div className="recording-actions">
                  {!isRecording ? (
                    <button
                      className="secondary"
                      onClick={() => void startRecording()}
                      disabled={!sentence}
                    >
                      ● Gravar minha voz
                    </button>
                  ) : (
                    <button className="danger-button" onClick={stopRecording}>
                      ■ Parar gravação
                    </button>
                  )}
                  {sentence && (
                    <button className="secondary" onClick={repeatSentence}>
                      ▶ Ouvir original
                    </button>
                  )}
                </div>
                {recordingUrl && (
                  <audio className="recording-player" src={recordingUrl} controls />
                )}
              </section>

              <div className="settings-grid">
                <div>
                  <label>Velocidade</label>
                  <div className="segmented">
                    {[0.5, 0.75, 1, 1.25].map((value) => (
                      <button
                        key={value}
                        className={rate === value ? "active" : ""}
                        onClick={() => changeRate(value)}
                      >
                        {value}x
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label>Legenda</label>
                  <div className="segmented">
                    {([
                      ["en", "EN"],
                      ["pt", "PT"],
                      ["both", "EN + PT"],
                      ["off", "Off"]
                    ] as [SubtitleMode, string][]).map(([value, label]) => (
                      <button
                        key={value}
                        className={subtitleMode === value ? "active" : ""}
                        onClick={() => {
                          setSubtitleMode(value);
                          setRevealTranslation(false);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {!!clip.chunks?.length && (
                <section className="chunks-box">
                  <div className="chunks-head">
                    <div>
                      <span className="small-label">CHUNKS DESTE CORTE</span>
                      <h3>Leve só o que vale revisar</h3>
                    </div>
                    <div className="chunk-actions">
                      <button
                        className="secondary compact"
                        onClick={() => void copyRecallPack()}
                      >
                        Copiar p/ Recall
                      </button>
                      <button
                        className="primary compact"
                        onClick={() => void shareRecallPack()}
                      >
                        Compartilhar
                      </button>
                    </div>
                  </div>

                  <div className="chunks-list">
                    {clip.chunks.map((chunk, index) => (
                      <article className="chunk-card" key={`${chunk.en}-${index}`}>
                        <strong>{chunk.en}</strong>
                        <span>{chunk.pt}</span>
                        <p>{chunk.note}</p>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>

          <aside className="clips-column">
            <div className="aside-head">
              <div>
                <p className="muted">{analysis.videoTitle}</p>
                <h3>Cortes escolhidos pela IA</h3>
              </div>
              <strong>
                {studiedClipIds.length}/{analysis.clips.length}
              </strong>
            </div>

            <div className="clip-list">
              {analysis.clips.map((item, index) => {
                const done = studiedClipIds.includes(item.id);
                const preparing = detailsLoadingId === item.id;

                return (
                  <button
                    key={item.id}
                    className={`clip-card ${index === selected ? "selected" : ""} ${done ? "done" : ""}`}
                    onClick={() => void selectClip(index)}
                    disabled={preparing}
                  >
                    <div className="clip-top">
                      <span>{done ? "✓" : `0${index + 1}`}</span>
                      <span>
                        {preparing
                          ? "preparando…"
                          : `${formatTime(item.endSec - item.startSec)} · ${item.difficulty}`}
                      </span>
                    </div>
                    <h4>{item.title}</h4>
                    <p>{item.why}</p>
                    <div className="clip-time">
                      {formatTime(item.startSec)} → {formatTime(item.endSec)}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        </section>
      )}

      {!analysis && !loading && (
        <section className="steps">
          <div>
            <b>01</b>
            <h3>Cole o vídeo</h3>
            <p>Vídeos já analisados abrem do histórico automaticamente.</p>
          </div>
          <div>
            <b>02</b>
            <h3>Abra um corte</h3>
            <p>A legenda detalhada e os chunks são gerados apenas uma vez.</p>
          </div>
          <div>
            <b>03</b>
            <h3>Faça shadowing</h3>
            <p>Ouça, repita, grave sua voz e leve os melhores chunks para o Recall.</p>
          </div>
        </section>
      )}
    </main>
  );
}
