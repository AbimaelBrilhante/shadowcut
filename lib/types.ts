export type Sentence = {
  startSec: number;
  endSec: number;
  en: string;
  pt: string;
};

export type Chunk = {
  en: string;
  pt: string;
  note: string;
};

export type Clip = {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  why: string;
  difficulty: string;
  sentences: Sentence[];
  chunks?: Chunk[];
  detailsReady?: boolean;
};

export type AnalysisResult = {
  videoTitle: string;
  videoId: string;
  sourceUrl: string;
  clips: Clip[];
};

export type SentenceAdjustment = {
  startDelta: number;
  endDelta: number;
};

export type SavedSession = {
  videoId: string;
  analysis: AnalysisResult;
  studiedClipIds: string[];
  lastClipIndex: number;
  sentenceAdjustments?: Record<string, SentenceAdjustment>;
  createdAt: string;
  updatedAt: string;
};
