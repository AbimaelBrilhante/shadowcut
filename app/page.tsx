"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import YouTubePlayer, { type PlayerHandle } from "../components/YouTubePlayer";
import type { AnalysisResult, Clip, Sentence } from "../lib/types";
import { formatTime } from "../lib/youtube";

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
  const player = useRef<PlayerHandle>(null);

  const clip: Clip | null = analysis?.clips[selected] ?? null;

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

  async function analyze() {
    if (!url.trim()) return;

    setLoading(true);
    setError("");
    setAnalysis(null);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Não foi possível analisar o vídeo.");

      setAnalysis(data);
      setSelected(0);
      setCurrentTime(data.clips[0]?.startSec ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setLoading(false);
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

  const progress = clip
    ? Math.max(
        0,
        Math.min(100, ((currentTime - clip.startSec) / (clip.endSec - clip.startSec)) * 100)
      )
    : 0;

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>ShadowCut</span>
        </div>
        <span className="pill">MVP 0.1 · pessoal</span>
      </header>

      <section className="hero">
        <p className="eyebrow">YOUTUBE → SHADOWING</p>
        <h1>
          Transforme vídeos longos em <span>treinos curtos de inglês.</span>
        </h1>
        <p className="hero-copy">
          Cole um vídeo público do YouTube. A IA escolhe automaticamente bons trechos,
          fecha frases e prepara inglês + português para você praticar.
        </p>

        <div className="url-box">
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && analyze()}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-label="URL do YouTube"
          />
          <button onClick={analyze} disabled={loading || !url.trim()}>
            {loading ? "Analisando…" : "Criar sessão"}
          </button>
        </div>

        <p className="hint">
          Para manter custo zero, o app usa apenas as cotas gratuitas configuradas no projeto.
        </p>

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

              <YouTubePlayer
                ref={player}
                videoId={analysis.videoId}
                onTime={onTime}
              />

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
              <strong>{analysis.clips.length}</strong>
            </div>

            <div className="clip-list">
              {analysis.clips.map((item, index) => (
                <button
                  key={item.id}
                  className={`clip-card ${index === selected ? "selected" : ""}`}
                  onClick={() => selectClip(index)}
                >
                  <div className="clip-top">
                    <span>0{index + 1}</span>
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
              ))}
            </div>
          </aside>
        </section>
      )}

      {!analysis && !loading && (
        <section className="steps">
          <div>
            <b>01</b>
            <h3>Cole o vídeo</h3>
            <p>Use um vídeo público do YouTube em inglês.</p>
          </div>
          <div>
            <b>02</b>
            <h3>A IA escolhe</h3>
            <p>Trechos fechados de aproximadamente 1–2 minutos.</p>
          </div>
          <div>
            <b>03</b>
            <h3>Pratique</h3>
            <p>EN/PT, velocidade e repetição frase por frase.</p>
          </div>
        </section>
      )}
    </main>
  );
}
