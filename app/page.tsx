"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YouTubePlayer, { type PlayerHandle } from "../components/YouTubePlayer";
import type { AnalysisResult, Clip, SavedSession, Sentence, SentenceAdjustment } from "../lib/types";
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

type StudySubtitleMode = "pt" | "both" | "off";

export default function Home() {
  const [url, setUrl] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [studySubtitleMode, setStudySubtitleMode] = useState<StudySubtitleMode>("pt");
  const [loading, setLoading] = useState(false);
  const [detailsLoadingId, setDetailsLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<SavedSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [studiedClipIds, setStudiedClipIds] = useState<string[]>([]);
  const [sentenceAdjustments, setSentenceAdjustments] = useState<Record<string, SentenceAdjustment>>({});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!analysis || videoDuration <= 0) return;

    const valid = analysis.clips
      .filter((item) => item.startSec >= 0 && item.startSec < videoDuration - 0.25)
      .map((item) => ({
        ...item,
        endSec: Math.min(item.endSec, videoDuration)
      }))
      .filter((item) => item.endSec > item.startSec + 1);

    const changed =
      valid.length !== analysis.clips.length ||
      valid.some((item, index) => item.endSec !== analysis.clips[index]?.endSec);

    if (!changed) return;

    if (!valid.length) {
      setError(
        `A IA gerou cortes fora da duração real do vídeo (${formatTime(videoDuration)}). Analise novamente.`
      );
      return;
    }

    const validIds = new Set(valid.map((item) => item.id));
    const nextStudied = studiedClipIds.filter((id) => validIds.has(id));
    const removed = analysis.clips.length - valid.length;
    const nextAnalysis = { ...analysis, clips: valid };

    setAnalysis(nextAnalysis);
    setStudiedClipIds(nextStudied);
    setSelected((current) => Math.min(current, valid.length - 1));
    setNotice(
      removed > 0
        ? `${removed} corte inválido foi removido porque estava fora da duração real do vídeo (${formatTime(videoDuration)}).`
        : "O fim de um corte foi ajustado à duração real do vídeo."
    );

    void (async () => {
      const session = await getSession(analysis.videoId);
      if (!session) return;
      session.analysis = nextAnalysis;
      session.studiedClipIds = nextStudied;
      session.lastClipIndex = Math.min(session.lastClipIndex ?? 0, valid.length - 1);
      await saveSession(session);
      await refreshHistory();
    })();
  }, [analysis, videoDuration, studiedClipIds]);

  async function refreshHistory() {
    try {
      setHistory(await listSessions());
    } catch {
      // Local history is optional; the player still works without it.
    }
  }

  function applySavedSession(
    session: SavedSession,
    message = "Sessão salva aberta — 0 chamadas à IA."
  ) {
    const index = Math.max(0, Math.min(session.lastClipIndex ?? 0, session.analysis.clips.length - 1));
    stopAutoShadowing();
    setAnalysis(session.analysis);
    setUrl(session.analysis.sourceUrl);
    setSelected(index);
    setCurrentTime(session.analysis.clips[index]?.startSec ?? 0);
    setVideoDuration(0);
    setStudiedClipIds(session.studiedClipIds ?? []);
    setSentenceAdjustments(session.sentenceAdjustments ?? {});
    setLoadedFromHistory(true);
    setShowHistory(false);
    setError("");
    setNotice(message);
  }

  function openSavedSession(session: SavedSession) {
    applySavedSession(session);
  }

  function adjustmentKey(clipId: string, sentenceIndex: number) {
    return `${clipId}:${sentenceIndex}`;
  }

  function adjustedSentenceAt(index: number, targetClip: Clip | null = clip): Sentence | null {
    if (!targetClip?.sentences?.[index]) return null;
    const original = targetClip.sentences[index];
    const adjustment = sentenceAdjustments[adjustmentKey(targetClip.id, index)] ?? {
      startDelta: 0,
      endDelta: 0
    };

    const startSec = Math.max(targetClip.startSec, original.startSec + adjustment.startDelta);
    const endSec = Math.min(targetClip.endSec, original.endSec + adjustment.endDelta);

    return {
      ...original,
      startSec,
      endSec: Math.max(startSec + 0.08, endSec)
    };
  }

  const sentenceIndex = useMemo(() => {
    if (!clip?.sentences?.length) return -1;

    for (let i = 0; i < clip.sentences.length; i += 1) {
      const item = adjustedSentenceAt(i, clip);
      if (!item) continue;
      if (currentTime >= item.startSec - 0.2 && currentTime <= item.endSec + 0.2) return i;
    }

    for (let i = 0; i < clip.sentences.length - 1; i += 1) {
      const currentCue = adjustedSentenceAt(i, clip);
      const nextCue = adjustedSentenceAt(i + 1, clip);
      if (!currentCue || !nextCue) continue;
      const gap = nextCue.startSec - currentCue.endSec;
      if (gap > 0 && gap <= 2.5 && currentTime > currentCue.endSec && currentTime < nextCue.startSec) {
        return currentTime < currentCue.endSec + gap / 2 ? i : i + 1;
      }
    }

    return -1;
  }, [clip, currentTime, sentenceAdjustments]);

  const sentence = sentenceIndex >= 0 ? adjustedSentenceAt(sentenceIndex) : null;
  const onTime = useCallback((time: number) => setCurrentTime(time), []);

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
          return;
        }
      } catch {}
    }

    setLoading(true);
    setAnalysis(null);
    setStudiedClipIds([]);
    setSentenceAdjustments({});
    setLoadedFromHistory(false);
    setVideoDuration(0);

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
      setNotice("Cortes encontrados e salvos. O player validará os tempos pela duração real do YouTube.");
      await refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setLoading(false);
    }
  }

  async function generateChunks(videoId: string, clipIndex: number, sentences: Sentence[]) {
    try {
      const res = await fetch("/api/chunks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentences })
      });
      const data = await res.json();
      const chunks = Array.isArray(data?.chunks) ? data.chunks : [];
      if (!chunks.length) return;

      setAnalysis((current) => {
        if (!current || current.videoId !== videoId) return current;
        return {
          ...current,
          clips: current.clips.map((item, index) =>
            index === clipIndex ? { ...item, chunks } : item
          )
        };
      });

      const session = await getSession(videoId);
      if (session?.analysis?.clips?.[clipIndex]) {
        session.analysis = {
          ...session.analysis,
          clips: session.analysis.clips.map((item, index) =>
            index === clipIndex ? { ...item, chunks } : item
          )
        };
        await saveSession(session);
      }
    } catch {
      // Chunks are optional.
    }
  }

  async function prepareStudyAid() {
    if (!analysis || !clip) return;
    if (clip.sentences?.length && clip.detailsReady) {
      if (!clip.chunks?.length) void generateChunks(analysis.videoId, selected, clip.sentences);
      return;
    }

    if (videoDuration > 0 && clip.startSec >= videoDuration - 0.25) {
      setError("Este corte está fora da duração real do vídeo e não pode ser preparado.");
      return;
    }

    setDetailsLoadingId(clip.id);
    setError("");

    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 45000);
      let res: Response;
      try {
        res = await fetch("/api/clip-details", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            url: analysis.sourceUrl,
            startSec: clip.startSec,
            endSec: clip.endSec,
            title: clip.title
          })
        });
      } finally {
        window.clearTimeout(timeout);
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Não consegui preparar a tradução deste corte.");

      const nextAnalysis: AnalysisResult = {
        ...analysis,
        clips: analysis.clips.map((item, index) =>
          index === selected
            ? {
                ...item,
                sentences: data.sentences ?? [],
                detailsReady: true,
                detailsVersion: data.detailsVersion ?? 5
              }
            : item
        )
      };

      setAnalysis(nextAnalysis);
      const session = await getSession(analysis.videoId);
      if (session) {
        session.analysis = nextAnalysis;
        session.lastClipIndex = selected;
        await saveSession(session);
      }
      await refreshHistory();

      if (Array.isArray(data.sentences) && data.sentences.length) {
        void generateChunks(analysis.videoId, selected, data.sentences);
      }

      setNotice(
        data.partial
          ? "Tradução preparada parcialmente. Alguns segundos não puderam ser transcritos."
          : "Tradução e frases de estudo preparadas para este corte."
      );
    } catch (e) {
      const message =
        e instanceof DOMException && e.name === "AbortError"
          ? "A tradução demorou mais de 45 segundos. Tente novamente depois."
          : e instanceof Error
            ? e.message
            : "Não consegui preparar a tradução deste corte.";
      setError(message);
    } finally {
      setDetailsLoadingId(null);
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
    } catch {}
  }

  function playClip() {
    if (!clip) return;
    stopAutoShadowing();
    player.current?.playRange(clip.startSec, clip.endSec);
    player.current?.setRate(rate);
  }

  function selectClip(index: number) {
    const next = analysis?.clips[index];
    if (!next) return;
    stopAutoShadowing();
    setSelected(index);
    setCurrentTime(next.startSec);
    void persistProgress(studiedClipIds, index);
    player.current?.playRange(next.startSec, next.endSec);
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
    const nextIndex = Math.max(0, Math.min(clip.sentences.length - 1, baseIndex + direction));
    stopAutoShadowing();
    playSentenceAt(nextIndex);
  }

  function changeRate(next: number) {
    setRate(next);
    player.current?.setRate(next);
  }

  async function startAutoShadowing() {
    if (!clip?.sentences?.length) {
      setError("Primeiro toque em “Preparar tradução + chunks” para gerar as frases deste corte.");
      return;
    }

    const initialIndex = sentenceIndex >= 0 ? sentenceIndex : 0;
    autoRef.current = { active: true, index: initialIndex, iteration: 1 };
    setAutoMode(true);
    setAutoStatus(`Frase ${initialIndex + 1}/${clip.sentences.length} · repetição 1/${autoRepeats}`);
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
      setNotice("Sessão automática concluída.");
      return;
    }

    setAutoStatus(repeatSame ? "Pausa para você repetir…" : "Pausa para você falar…");
    autoTimerRef.current = window.setTimeout(() => {
      if (!autoRef.current.active) return;
      autoRef.current = { active: true, index: nextIndex, iteration: nextIteration };
      setAutoStatus(`Frase ${nextIndex + 1}/${clip.sentences.length} · repetição ${nextIteration}/${autoRepeats}`);
      playSentenceAt(nextIndex);
    }, autoPauseSec * 1000);
  }

  function toggleStudied() {
    if (!clip) return;
    const next = studiedClipIds.includes(clip.id)
      ? studiedClipIds.filter((id) => id !== clip.id)
      : [...studiedClipIds, clip.id];
    setStudiedClipIds(next);
    void persistProgress(next, selected);
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
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (recordingUrl) URL.revokeObjectURL(recordingUrl);
        setRecordingUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        setIsRecording(false);
      };
      recorder.start();
      setIsRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não consegui acessar o microfone.");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  function buildRecallPack() {
    if (!analysis || !clip) return "";
    const chunkLines = (clip.chunks ?? [])
      .map((chunk, index) => `${index + 1}. ${chunk.en}\n   PT: ${chunk.pt}\n   Nota: ${chunk.note}`)
      .join("\n\n");
    const transcript = (clip.sentences ?? []).map((item) => `${item.en}\nPT: ${item.pt}`).join("\n\n");
    return `SHADOWCUT → RECALL\n\nVídeo: ${analysis.videoTitle}\nURL: ${analysis.sourceUrl}\nTrecho: ${formatTime(clip.startSec)} → ${formatTime(clip.endSec)}\n\nCHUNKS RECOMENDADOS\n${chunkLines || "Nenhum chunk gerado."}\n\nTRANSCRIÇÃO DO TRECHO\n${transcript}\n\nPedido: revise os chunks, elimine os pouco úteis, evite duplicatas e adicione os melhores ao meu Recall.`;
  }

  async function copyRecallPack() {
    const text = buildRecallPack();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setNotice("Pacote copiado. Cole no ChatGPT para revisar e adicionar ao Recall.");
  }

  async function removeSavedSession(videoId: string) {
    if (!window.confirm("Excluir esta sessão salva do aparelho?")) return;
    await deleteSession(videoId);
    if (analysis?.videoId === videoId) {
      setAnalysis(null);
      setStudiedClipIds([]);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não consegui importar o backup.");
    }
  }

  const progress = clip
    ? Math.max(0, Math.min(100, ((currentTime - clip.startSec) / Math.max(1, clip.endSec - clip.startSec)) * 100))
    : 0;
  const studiedCurrent = clip ? studiedClipIds.includes(clip.id) : false;
  const detailsLoading = clip ? detailsLoadingId === clip.id : false;
  const latestSession = history[0] ?? null;

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">S</span><span>ShadowCut</span></div>
        <div className="top-actions">
          <button className="history-toggle" onClick={() => setShowHistory((value) => !value)}>
            Histórico {history.length ? `(${history.length})` : ""}
          </button>
          <span className="pill">MVP 0.7 · pessoal</span>
        </div>
      </header>

      {showHistory && (
        <section className="history-panel">
          <div className="history-head">
            <div><p className="eyebrow">SALVO NESTE APARELHO</p><h2>Seu histórico</h2></div>
            <div className="history-tools">
              <button className="secondary compact" onClick={downloadBackup} disabled={!history.length}>Exportar</button>
              <button className="secondary compact" onClick={() => importInput.current?.click()}>Importar</button>
              <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void restoreBackup(file);
                e.currentTarget.value = "";
              }} />
            </div>
          </div>
          <div className="history-list">
            {history.map((session) => (
              <article className="history-card" key={session.videoId}>
                <div className="history-card-main">
                  <span className="history-progress">{session.studiedClipIds?.length ?? 0}/{session.analysis.clips.length} estudados</span>
                  <h3>{session.analysis.videoTitle}</h3>
                </div>
                <div className="history-card-actions">
                  <button className="primary compact" onClick={() => openSavedSession(session)}>Continuar</button>
                  <button className="danger-button compact" onClick={() => void removeSavedSession(session.videoId)}>Excluir</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="hero">
        <p className="eyebrow">YOUTUBE → SHADOWING</p>
        <h1>Transforme vídeos longos em <span>treinos curtos de inglês.</span></h1>
        <p className="hero-copy">O inglês aparece pela legenda nativa do YouTube. Tradução, chunks e treino frase a frase são preparados somente quando você pedir.</p>
        <div className="url-box">
          <input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void analyze()} placeholder="https://www.youtube.com/watch?v=..." />
          <button onClick={() => void analyze()} disabled={loading || !url.trim()}>{loading ? "Analisando…" : "Criar sessão"}</button>
        </div>
        {notice && <div className="notice"><span>{notice}</span>{loadedFromHistory && <button onClick={() => void analyze(true)}>Analisar novamente</button>}</div>}
        {error && <div className="error">{error}</div>}
      </section>

      {!analysis && !loading && latestSession && (
        <section className="continue-card">
          <div><p className="eyebrow">CONTINUE DE ONDE PAROU</p><h2>{latestSession.analysis.videoTitle}</h2></div>
          <button className="primary" onClick={() => openSavedSession(latestSession)}>Continuar estudo</button>
        </section>
      )}

      {analysis && clip && (
        <section className="workspace">
          <div className="player-column">
            <div className="card">
              <div className="card-head">
                <div><span className="clip-label">CORTE {selected + 1}</span><h2>{clip.title}</h2></div>
                <span className="duration">{formatTime(clip.endSec - clip.startSec)}</span>
              </div>

              <YouTubePlayer
                ref={player}
                videoId={analysis.videoId}
                onTime={onTime}
                onRangeEnd={handleRangeEnd}
                onDuration={setVideoDuration}
                onInvalidRange={(start, _end, duration) => {
                  setError(`Este corte começa em ${formatTime(start)}, mas o vídeo tem apenas ${formatTime(duration)}. O corte inválido será removido.`);
                  setVideoDuration(duration);
                }}
              />

              <button className="play-clip" onClick={playClip}>▶ Tocar este corte</button>

              <div className="detail-loading" style={{ display: detailsLoading ? "flex" : "none" }}>
                <span className="mini-spinner" /> Preparando tradução e chunks deste corte…
              </div>

              {!clip.sentences?.length ? (
                <div className="subtitle-stage">
                  <div>
                    <div className="muted">A legenda em inglês está no próprio player do YouTube.</div>
                    <div className="subtitle-pt" style={{ marginTop: 12 }}>Para ver português aqui embaixo, prepare a tradução deste corte.</div>
                  </div>
                </div>
              ) : studySubtitleMode === "off" ? (
                <div className="subtitle-stage"><span className="muted">Tradução externa ocultada.</span></div>
              ) : sentence ? (
                <div className="subtitle-stage">
                  {studySubtitleMode === "both" && <div className="subtitle-en">{sentence.en}</div>}
                  <div className="subtitle-pt">{sentence.pt}</div>
                </div>
              ) : (
                <div className="subtitle-stage"><span className="muted">Sem tradução sincronizada neste instante.</span></div>
              )}

              <button className="studied-button active" onClick={() => void prepareStudyAid()} disabled={detailsLoading}>
                {clip.sentences?.length ? "✓ Tradução preparada" : detailsLoading ? "Preparando…" : "Preparar tradução + chunks"}
              </button>

              <div className="timeline-row">
                <span>{formatTime(Math.max(0, currentTime - clip.startSec))}</span>
                <div className="progress"><i style={{ width: `${progress}%` }} /></div>
                <span>{formatTime(clip.endSec - clip.startSec)}</span>
              </div>

              <div className="controls">
                <button className="secondary" onClick={() => goSentence(-1)} disabled={!clip.sentences?.length}>← frase</button>
                <button className="primary" onClick={repeatSentence} disabled={!sentence}>↻ repetir</button>
                <button className="secondary" onClick={() => goSentence(1)} disabled={!clip.sentences?.length}>frase →</button>
              </div>

              <section className="practice-box">
                <div className="practice-head">
                  <div><span className="small-label">MODO SHADOWING</span><strong>Ouvir → pausa para falar → repetir</strong></div>
                  <button className={autoMode ? "danger-button compact" : "primary compact"} onClick={() => autoMode ? stopAutoShadowing() : void startAutoShadowing()}>
                    {autoMode ? "Parar" : "Iniciar automático"}
                  </button>
                </div>
                {autoStatus && <p className="auto-status">{autoStatus}</p>}
                <div className="practice-settings">
                  <div><label>Repetições por frase</label><div className="segmented three">{[1,2,3].map((value) => <button key={value} className={autoRepeats === value ? "active" : ""} onClick={() => setAutoRepeats(value)}>{value}x</button>)}</div></div>
                  <div><label>Pausa para você falar</label><div className="segmented three">{[2,3,4].map((value) => <button key={value} className={autoPauseSec === value ? "active" : ""} onClick={() => setAutoPauseSec(value)}>{value}s</button>)}</div></div>
                </div>
              </section>

              <button className={studiedCurrent ? "studied-button active" : "studied-button"} onClick={toggleStudied}>
                {studiedCurrent ? "✓ Corte estudado" : "Marcar corte como estudado"}
              </button>

              <section className="recording-box">
                <div><span className="small-label">COMPARE SUA VOZ</span><strong>Grave sua repetição e compare com o original.</strong></div>
                <div className="recording-actions">
                  {!isRecording ? <button className="secondary" onClick={() => void startRecording()}>● Gravar minha voz</button> : <button className="danger-button" onClick={stopRecording}>■ Parar gravação</button>}
                  {sentence && <button className="secondary" onClick={repeatSentence}>▶ Ouvir frase original</button>}
                </div>
                {recordingUrl && <audio className="recording-player" src={recordingUrl} controls />}
              </section>

              <div className="settings-grid">
                <div><label>Velocidade</label><div className="segmented">{[0.5,0.75,1,1.25].map((value) => <button key={value} className={rate === value ? "active" : ""} onClick={() => changeRate(value)}>{value}x</button>)}</div></div>
                <div><label>Caixa de estudo</label><div className="segmented three">{([["pt","PT"],["both","EN + PT"],["off","Off"]] as [StudySubtitleMode,string][]).map(([value,label]) => <button key={value} className={studySubtitleMode === value ? "active" : ""} onClick={() => setStudySubtitleMode(value)}>{label}</button>)}</div></div>
              </div>

              {!!clip.chunks?.length && (
                <section className="chunks-box">
                  <div className="chunks-head"><div><span className="small-label">CHUNKS DESTE CORTE</span><h3>Leve só o que vale revisar</h3></div><button className="secondary compact" onClick={() => void copyRecallPack()}>Copiar p/ Recall</button></div>
                  <div className="chunks-list">{clip.chunks.map((chunk, index) => <article className="chunk-card" key={`${chunk.en}-${index}`}><strong>{chunk.en}</strong><span>{chunk.pt}</span><p>{chunk.note}</p></article>)}</div>
                </section>
              )}
            </div>
          </div>

          <aside className="clips-column">
            <div className="aside-head"><div><p className="muted">{analysis.videoTitle}</p><h3>Cortes válidos</h3></div><strong>{studiedClipIds.length}/{analysis.clips.length}</strong></div>
            <div className="clip-list">
              {analysis.clips.map((item, index) => {
                const done = studiedClipIds.includes(item.id);
                return (
                  <button key={item.id} className={`clip-card ${index === selected ? "selected" : ""} ${done ? "done" : ""}`} onClick={() => selectClip(index)}>
                    <div className="clip-top"><span>{done ? "✓" : `0${index + 1}`}</span><span>{formatTime(item.endSec - item.startSec)} · {item.difficulty}</span></div>
                    <h4>{item.title}</h4><p>{item.why}</p><div className="clip-time">{formatTime(item.startSec)} → {formatTime(item.endSec)}</div>
                  </button>
                );
              })}
            </div>
          </aside>
        </section>
      )}

      {!analysis && !loading && (
        <section className="steps">
          <div><b>01</b><h3>Cole o vídeo</h3><p>A IA escolhe os trechos e o YouTube fornece a legenda inglesa.</p></div>
          <div><b>02</b><h3>Validação real</h3><p>O player descarta cortes que ultrapassem a duração verdadeira do vídeo.</p></div>
          <div><b>03</b><h3>Traduza quando quiser</h3><p>Português, chunks e treino frase a frase são gerados sob demanda.</p></div>
        </section>
      )}
    </main>
  );
}
