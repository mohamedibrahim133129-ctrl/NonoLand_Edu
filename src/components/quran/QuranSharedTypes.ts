import type {
  InternalAgeBand,
  QuranActivityEvent,
  QuranChildSettings,
  QuranContentVerificationRecord,
  QuranMannerProgress,
  QuranMannerSpec,
  QuranReciterSpec,
  QuranStoryProgress,
  QuranStorySpec,
  QuranSurahProgress,
  QuranSurahSpec,
} from '../../types/nonoland';

export interface QuranPlaybackResolution {
  requestedReciter: QuranReciterSpec;
  activeReciter: QuranReciterSpec | null;
  usedAdultFallback: boolean;
  audioAvailable: boolean;
}

export interface QuranCatalogPayload {
  quranSchemaReady: boolean;
  featureEnabled: boolean;
  surahs: QuranSurahSpec[];
  reciters: QuranReciterSpec[];
  stories: QuranStorySpec[];
  manners: QuranMannerSpec[];
  playbackDefaultResolution: QuranPlaybackResolution;
}

export interface ChildQuranSummaryPayload {
  quranSchemaReady: boolean;
  childId: string;
  internalAgeBand: InternalAgeBand;
  featureEnabled: boolean;
  settings: QuranChildSettings;
  playbackResolution: QuranPlaybackResolution;
  minutesUsedToday: number;
  dailyLimitReached: boolean;
  surahProgress: QuranSurahProgress[];
  storyProgress: QuranStoryProgress[];
  mannerProgress: QuranMannerProgress[];
  recentEvents: QuranActivityEvent[];
  growthSummary: {
    listenedSurahsCount: number;
    practicedSurahsCount: number;
    familiarSurahsCount: number;
    parentConfirmedCount: number;
    storiesReadCount: number;
    mannersPracticedCount: number;
  };
}

export interface AdminQuranVerificationsPayload {
  surahTexts: Array<{
    contentKey: string;
    contentType: 'surah_text';
    nameAr: string;
    nameEn: string;
    ayahCount: number;
    textSource: string;
    textSourceUrl: string;
    textSha256: string;
    verificationStatus: string;
  }>;
  reciters: QuranReciterSpec[];
  customRecords: QuranContentVerificationRecord[];
}
