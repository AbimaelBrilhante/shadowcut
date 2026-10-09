"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";

export type PlayerHandle = {
  playRange: (startSec: number, endSec: number) => void;
  setRate: (rate: number) => void;
  pause: () => void;
};

type Props = {
  videoId: string;
  onTime?: (seconds: number) => void;
  onRangeEnd?: () => void;
  onDuration?: (seconds: number) => void;
  onInvalidRange?: (startSec: number, endSec: number, duration: number) => void;
};

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

type PendingRange = { startSec: number; endSec: number; loop: boolean } | null;

// AI-selected cuts are normally much longer than a sentence. Keeping the
// public PlayerHandle unchanged lets the existing page automatically loop
// full cuts while sentence-level practice still ends normally.
const MIN_LOOP_RANGE_SECONDS = 20;

const YouTubePlayer = forwardRef<PlayerHandle, Props>(function YouTubePlayer(
  { videoId, onTime, onRangeEnd, onDuration, onInvalidRange },
  ref
) {
  const reactId = useId();
  const holderId = useRef(`yt-${reactId.replace(/:/g, "")}`);
  const playerRef = useRef<any>(null);
  const startRef = useRef<number | null>(null);
  const endRef = useRef<number | null>(null);
  const loopRef = useRef(false);
  const pendingRangeRef = useRef<PendingRange>(null);
  const readyRef = useRef(false);
  const onRangeEndRef = useRef(onRangeEnd);
  const onTimeRef = useRef(onTime);
  const onDurationRef = useRef(onDuration);
  const onInvalidRangeRef = useRef(onInvalidRange);
  const [ready, setReady] = useState(false);
  const [looping, setLooping] = useState(false);

  useEffect(() => {
    onRangeEndRef.current = onRangeEnd;
    onTimeRef.current = onTime;
    onDurationRef.current = onDuration;
    onInvalidRangeRef.current = onInvalidRange;
  }, [onRangeEnd, onTime, onDuration, onInvalidRange]);

  function stopPlayback() {
    pendingRangeRef.current = null;
    startRef.current = null;
    endRef.current = null;
    loopRef.current = false;
    setLooping(false);
    playerRef.current?.pauseVideo?.();
  }

  function validateAndPlay(startSec: number, endSec: number, loop: boolean) {
    const player = playerRef.current;
    if (!player?.seekTo) {
      pendingRangeRef.current = { startSec, endSec, loop };
      return;
    }

    const duration = Number(player.getDuration?.()) || 0;
    if (duration > 0 && (startSec < 0 || startSec >= duration - 0.25)) {
      stopPlayback();
      onInvalidRangeRef.current?.(startSec, endSec, duration);
      return;
    }

    const safeEnd = duration > 0 ? Math.min(endSec, duration) : endSec;
    startRef.current = startSec;
    endRef.current = safeEnd;
    loopRef.current = loop;
    setLooping(loop);
    player.seekTo(startSec, true);
    player.playVideo?.();
  }

  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    pendingRangeRef.current = null;
    startRef.current = null;
    endRef.current = null;
    loopRef.current = false;
    setLooping(false);

    const createPlayer = () => {
      if (cancelled || !window.YT?.Player) return;
      playerRef.current?.destroy?.();

      playerRef.current = new window.YT.Player(holderId.current, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          playsinline: 1,
          rel: 0,
          cc_load_policy: 1,
          cc_lang_pref: "en",
          hl: "en"
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            try {
              playerRef.current?.setOption?.("captions", "track", { languageCode: "en" });
            } catch {}

            const duration = Number(playerRef.current?.getDuration?.()) || 0;
            if (duration > 0) onDurationRef.current?.(duration);

            setReady(true);

            const pending = pendingRangeRef.current;
            pendingRangeRef.current = null;
            if (pending) validateAndPlay(pending.startSec, pending.endSec, pending.loop);
          },
          onApiChange: () => {
            try {
              playerRef.current?.setOption?.("captions", "track", { languageCode: "en" });
            } catch {}
          }
        }
      });
    };

    if (window.YT?.Player) {
      createPlayer();
    } else {
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(script);
      }

      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        createPlayer();
      };
    }

    return () => {
      cancelled = true;
      readyRef.current = false;
      setReady(false);
      setLooping(false);
      playerRef.current?.destroy?.();
      playerRef.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;

      const current = Number(p.getCurrentTime()) || 0;
      onTimeRef.current?.(current);

      if (endRef.current !== null && current >= endRef.current - 0.08) {
        if (loopRef.current && startRef.current !== null) {
          p.seekTo(startRef.current, true);
          p.playVideo?.();
          onTimeRef.current?.(startRef.current);
          return;
        }

        p.pauseVideo?.();
        startRef.current = null;
        endRef.current = null;
        loopRef.current = false;
        setLooping(false);
        onRangeEndRef.current?.();
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, []);

  useImperativeHandle(ref, () => ({
    playRange(startSec, endSec) {
      const loop = endSec - startSec >= MIN_LOOP_RANGE_SECONDS;
      if (!readyRef.current) {
        pendingRangeRef.current = { startSec, endSec, loop };
        return;
      }
      validateAndPlay(startSec, endSec, loop);
    },
    setRate(rate) {
      playerRef.current?.setPlaybackRate?.(rate);
    },
    pause() {
      stopPlayback();
    }
  }), []);

  return (
    <>
      <div className="video-shell">
        <div id={holderId.current} className="video-frame" />
        {!ready && <div className="video-loading">Carregando player…</div>}
      </div>
      {looping && (
        <button
          type="button"
          className="secondary"
          style={{ width: "100%", marginTop: 12 }}
          onClick={stopPlayback}
        >
          ■ Parar loop
        </button>
      )}
    </>
  );
});

export default YouTubePlayer;
