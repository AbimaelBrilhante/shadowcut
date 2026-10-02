export type Sentence = {
  startSec: number;
  endSec: number;
  en: string;
  pt: string;
};

export type Clip = {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  why: string;
  difficulty: string;
  sentences: Sentence[];
};

export type AnalysisResult = {
  videoTitle: string;
  videoId: string;
  sourceUrl: string;
  clips: Clip[];
};
