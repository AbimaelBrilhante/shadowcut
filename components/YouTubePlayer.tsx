"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";

export type PlayerHandle = {
  playRange: (startSec: number, endSec: number) => void;
  setRate: (rate: number) => void;
};

type Props = {
  videoId: string;
  onTime?: (seconds: number) => void;
};

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YouTubePlayer = forwardRef<PlayerHandle, Props>(function YouTubePlayer({ videoId, onTime }, ref) {
  const reactId = useId();
  const holderId = useRef(`yt-${reactId.replace(/:/g, "")}`);
  const playerRef = useRef<any>(null);
  const endRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const createPlayer = () => {
      if (cancelled || !window.YT?.Player) return;
      playerRef.current?.destroy?.();

      playerRef.current = new window.YT.Player(holderId.current, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0 },
        events: { onReady: () => setReady(true) }
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
      onTime?.(current);

      if (endRef.current !== null && current >= endRef.current - 0.05) {
        p.pauseVideo?.();
        endRef.current = null;
      }
    }, 120);

    return () => window.clearInterval(timer);
  }, [onTime]);

  useImperativeHandle(ref, () => ({
    playRange(startSec, endSec) {
      endRef.current = endSec;
      playerRef.current?.seekTo?.(startSec, true);
      playerRef.current?.playVideo?.();
    },
    setRate(rate) {
      playerRef.current?.setPlaybackRate?.(rate);
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
