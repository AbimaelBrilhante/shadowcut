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
};

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YouTubePlayer = forwardRef<PlayerHandle, Props>(function YouTubePlayer(
  { videoId, onTime, onRangeEnd },
  ref
) {
  const reactId = useId();
  const holderId = useRef(`yt-${reactId.replace(/:/g, "")}`);
  const playerRef = useRef<any>(null);
  const endRef = useRef<number | null>(null);
  const onRangeEndRef = useRef(onRangeEnd);
  const onTimeRef = useRef(onTime);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onRangeEndRef.current = onRangeEnd;
  }, [onRangeEnd]);

  useEffect(() => {
    onTimeRef.current = onTime;
  }, [onTime]);

  useEffect(() => {
    let cancelled = false;

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
            // Keep English captions inside the official YouTube player whenever
            // the video exposes a caption track. AI captions become optional.
            try {
              playerRef.current?.setOption?.("captions", "track", { languageCode: "en" });
            } catch {}
            setReady(true);
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

      if (endRef.current !== null && current >= endRef.current - 0.05) {
        p.pauseVideo?.();
        endRef.current = null;
        onRangeEndRef.current?.();
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, []);

  useImperativeHandle(ref, () => ({
    playRange(startSec, endSec) {
      endRef.current = endSec;
      playerRef.current?.seekTo?.(startSec, true);
      playerRef.current?.playVideo?.();
    },
    setRate(rate) {
      playerRef.current?.setPlaybackRate?.(rate);
    },
    pause() {
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
