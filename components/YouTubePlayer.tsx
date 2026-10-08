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

type PendingRange = { startSec: number; endSec: number } | null;

const YouTubePlayer = forwardRef<PlayerHandle, Props>(function YouTubePlayer(
  { videoId, onTime, onRangeEnd, onDuration, onInvalidRange },
  ref
) {
  const reactId = useId();
  const holderId = useRef(`yt-${reactId.replace(/:/g, "")}`);
  const playerRef = useRef<any>(null);
  const endRef = useRef<number | null>(null);
  const pendingRangeRef = useRef<PendingRange>(null);
  const readyRef = useRef(false);
  const onRangeEndRef = useRef(onRangeEnd);
  const onTimeRef = useRef(onTime);
  const onDurationRef = useRef(onDuration);
  const onInvalidRangeRef = useRef(onInvalidRange);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onRangeEndRef.current = onRangeEnd;
    onTimeRef.current = onTime;
    onDurationRef.current = onDuration;
    onInvalidRangeRef.current = onInvalidRange;
  }, [onRangeEnd, onTime, onDuration, onInvalidRange]);

  function validateAndPlay(startSec: number, endSec: number) {
    const player = playerRef.current;
    if (!player?.seekTo) {
      pendingRangeRef.current = { startSec, endSec };
      return;
    }

    const duration = Number(player.getDuration?.()) || 0;
    if (duration > 0 && (startSec < 0 || startSec >= duration - 0.25)) {
      endRef.current = null;
      player.pauseVideo?.();
      onInvalidRangeRef.current?.(startSec, endSec, duration);
      return;
    }

    const safeEnd = duration > 0 ? Math.min(endSec, duration) : endSec;
    endRef.current = safeEnd;
    player.seekTo(startSec, true);
    player.playVideo?.();
  }

  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    pendingRangeRef.current = null;

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
            if (pending) validateAndPlay(pending.startSec, pending.endSec);
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
        p.pauseVideo?.();
        endRef.current = null;
        onRangeEndRef.current?.();
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, []);

  useImperativeHandle(ref, () => ({
    playRange(startSec, endSec) {
      if (!readyRef.current) {
        pendingRangeRef.current = { startSec, endSec };
        return;
      }
      validateAndPlay(startSec, endSec);
    },
    setRate(rate) {
      playerRef.current?.setPlaybackRate?.(rate);
    },
    pause() {
      pendingRangeRef.current = null;
      endRef.current = null;
      playerRef.current?.pauseVideo?.();
    }
  }), []);

  return (
    <div className="video-shell">
      <div id={holderId.current} className="video-frame" />
      {!ready && <div className="video-loading">Carregando player…</div>}
    </div>
  );
});

export default YouTubePlayer;
