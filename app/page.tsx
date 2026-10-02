"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YouTubePlayer, { type PlayerHandle } from "../components/YouTubePlayer";
import type { AnalysisResult, Clip, SavedSession, Sentence } from "../lib/types";
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
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>("both");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<SavedSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [studiedClipIds, setStudiedClipIds] = useState<string[]>([]);
  const [loadedFromHistory, setLoadedFromHistory] = useState(false);
  const player = useRef<PlayerHandle>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const clip: Clip | null = analysis?.clips[selected] ?? null;

  useEffect(() => {
    refreshHistory();
  }, []);

  async function refreshHistory() {
    try {
      setHistory(await listSessions());
    } catch {
      // IndexedDB can be unavailable in some private browsing contexts.
    }
  }

  function applySavedSession(session: SavedSession, message = "Sessão salva aberta — 0 chamadas à IA.") {
    const index = Math.max(0, Math.min(session.lastClipIndex ?? 0, session.analysis.clips.length - 1));
    setAnalysis(session.analysis);
    setUrl(session.analysis.sourceUrl);
    setSelected(index);
    setCurrentTime(session.analysis.clips[index]?.startSec ?? 0);
    setStudiedClipIds(session.studiedClipIds ?? []);
    setLoadedFromHistory(true);
    setShowHistory(false);
    setError("");
    setNotice(message);
  }

  const sentenceIndex = useMemo(() => {
    if (!clip?.sentences.length) return -1;

    const exact = clip.sentences.findIndex(
      (s) => currentTime >= s.startSec - 0.15 && currentTime <= s.endSec + 0.2
    );
    if (exact >= 0) return exact;

    if (currentTime < clip.sentences[0].startSec) return 0;

    let latest = 0;
    for (let i = 0; i < clip.sentences.length; i += 1) {
      if (currentTime >= clip.sentences[i].startSec) latest = i;
    }
    return latest;
  }, [clip, currentTime]);

  const sentence: Sentence | null =
    sentenceIndex >= 0 && clip ? clip.sentences[sentenceIndex] : null;

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
      } catch {
        // If local history fails, analysis can still continue normally.
      }
    }

    setLoading(true);
    setAnalysis(null);
    setStudiedClipIds([]);
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
      setNotice("Análise salva automaticamente neste aparelho.");
      await refreshHistory();
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
      await saveSession(session);
      await refreshHistory();
    } catch {
      // Practice should not be blocked by a local persistence error.
    }
  }

  function playClip() {
    if (!clip) return;
    player.current?.playRange(clip.startSec, clip.endSec);
    player.current?.setRate(rate);
  }

  function selectClip(index: number) {
    const next = analysis?.clips[index];
    if (!next) return;

    setSelected(index);
    setCurrentTime(next.startSec);
    player.current?.playRange(next.startSec, next.endSec);
    player.current?.setRate(rate);
    void persistProgress(studiedClipIds, index);
  }

  function repeatSentence() {
    if (!sentence) return;
    player.current?.playRange(sentence.startSec, sentence.endSec);
    player.current?.setRate(rate);
  }

  function goSentence(direction: -1 | 1) {
    if (!clip?.sentences.length) return;

    const nextIndex = Math.max(
      0,
      Math.min(clip.sentences.length - 1, sentenceIndex + direction)
    );
    const next = clip.sentences[nextIndex];

    player.current?.playRange(next.startSec, next.endSec);
    player.current?.setRate(rate);
  }

  function changeRate(next: number) {
    setRate(next);
    player.current?.setRate(next);
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
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não consegui importar o backup.");
    }
  }

  const progress = clip
    ? Math.max(
        0,
        Math.min(100, ((currentTime - clip.startSec) / (clip.endSec - clip.startSec)) * 100)
      )
    : 0;

  const studiedCurrent = clip ? studiedClipIds.includes(clip.id) : false;

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>ShadowCut</span>
        </div>
        <div className="top-actions">
          <button className="history-toggle" onClick={() => setShowHistory((v) => !v)}>
            Histórico {history.length > 0 ? `(${history.length})` : ""}
          </button>
          <span className="pill">MVP 0.2 · pessoal</span>
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
              <button className="secondary compact" onClick={downloadBackup} disabled={!history.length}>
                Exportar
              </button>
              <button className="secondary compact" onClick={() => importInput.current?.click()}>
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
                      <span className="history-progress">{done}/{total} estudados</span>
                      <h3>{session.analysis.videoTitle}</h3>
                      <p>
                        {total} cortes · atualizado em {new Date(session.updatedAt).toLocaleDateString("pt-BR")}
                      </p>
                    </div>
                    <div className="history-card-actions">
                      <button className="primary compact" onClick={() => applySavedSession(session)}>
                        Continuar
                      </button>
                      <button className="danger-button compact" onClick={() => void removeSavedSession(session.videoId)}>
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
          Cole um vídeo público do YouTube. Se ele já estiver no seu histórico, o ShadowCut abre
          a sessão salva sem gastar uma nova chamada à IA.
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
          Histórico local = reabrir sessões sem consumir novamente a cota do Gemini.
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
                <span className="duration">{formatTime(clip.endSec - clip.startSec)}</span>
              </div>

              <YouTubePlayer ref={player} videoId={analysis.videoId} onTime={onTime} />

              <button className="play-clip" onClick={playClip}>
                ▶ Tocar este corte
              </button>

              <div className="subtitle-stage">
                {subtitleMode === "off" ? (
                  <span className="muted">Legendas ocultas</span>
                ) : sentence ? (
                  <>
                    {(subtitleMode === "en" || subtitleMode === "both") && (
                      <div className="subtitle-en">{sentence.en}</div>
                    )}
                    {(subtitleMode === "pt" || subtitleMode === "both") && (
                      <div className="subtitle-pt">{sentence.pt}</div>
                    )}
                  </>
                ) : (
                  <span className="muted">Toque o corte para acompanhar as frases.</span>
                )}
              </div>

              <div className="timeline-row">
                <span>{formatTime(Math.max(0, currentTime - clip.startSec))}</span>
                <div className="progress">
                  <i style={{ width: `${progress}%` }} />
                </div>
                <span>{formatTime(clip.endSec - clip.startSec)}</span>
              </div>

              <div className="controls">
                <button className="secondary" onClick={() => goSentence(-1)}>
                  ← frase
                </button>
                <button className="primary" onClick={repeatSentence}>
                  ↻ repetir
                </button>
                <button className="secondary" onClick={() => goSentence(1)}>
                  frase →
                </button>
              </div>

              <button
                className={studiedCurrent ? "studied-button active" : "studied-button"}
                onClick={toggleStudied}
              >
                {studiedCurrent ? "✓ Corte estudado" : "Marcar corte como estudado"}
              </button>

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
                        onClick={() => setSubtitleMode(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside className="clips-column">
            <div className="aside-head">
              <div>
                <p className="muted">{analysis.videoTitle}</p>
                <h3>Cortes escolhidos pela IA</h3>
              </div>
              <strong>{studiedClipIds.length}/{analysis.clips.length}</strong>
            </div>

            <div className="clip-list">
              {analysis.clips.map((item, index) => {
                const done = studiedClipIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    className={`clip-card ${index === selected ? "selected" : ""} ${done ? "done" : ""}`}
                    onClick={() => selectClip(index)}
                  >
                    <div className="clip-top">
                      <span>{done ? "✓" : `0${index + 1}`}</span>
                      <span>
                        {formatTime(item.endSec - item.startSec)} · {item.difficulty}
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
            <h3>A IA escolhe</h3>
            <p>A análise nova é salva no aparelho assim que termina.</p>
          </div>
          <div>
            <b>03</b>
            <h3>Continue amanhã</h3>
            <p>Progresso, cortes e legendas ficam disponíveis sem nova análise.</p>
          </div>
        </section>
      )}
    </main>
  );
}
