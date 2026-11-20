import crypto from 'crypto';
import type express from 'express';
import {
  DEFAULT_ALLOWED_SURAH_IDS,
  QURAN_MANNERS,
  QURAN_RECITERS,
  QURAN_STORIES,
  QURAN_SURAHS,
  getQuranMannerById,
  getQuranReciterById,
  getQuranStoryById,
  getQuranSurahById,
} from '../src/data/quranCatalog';
import {
  buildMonthlySnapshotForChild,
  calculateStreakDays,
  getCurrentMonthKey,
  getTodayDayKey,
} from '../src/engine/monthlyReportEngine';
import { getInternalAgeBand } from '../src/utils/ageAdaptation';
import {
  clampQuranDailyMinutes,
  clampQuranRepeatCount,
  isSafeQuranAudioUrl,
  sanitizeQuranNote,
  sanitizeShortText,
} from '../src/utils/validation';
import type {
  ActivityTimelineEvent,
  QuranActivityEvent,
  QuranChildSettings,
  QuranContentVerificationRecord,
  QuranMannerProgress,
  QuranMemorizationStatus,
  QuranReciterSpec,
  QuranStoryProgress,
  QuranSurahProgress,
  QuranVerificationStatus,
} from '../src/types/nonoland';
import { recordAuditEvent } from './auditLog';
import type { AuthenticatedRequest, ServerDb, StoredChildRecord } from './dbTypes';
import {
  awardGardenMilestoneIdempotent,
  canUserAccessChild,
  ensureChildFamilyAndGarden,
  ensureFamilyCollections,
  isChildOrStudentRole,
  recordFamilyEvent,
  requireParentGate,
} from './familyHelpers';
import { isQuranSchemaReady, runWithPgDbLock } from './pgStore';
import { getClientIp } from './security';

interface QuranRoutesDeps {
  app: express.Express;
  getDb: () => ServerDb;
  saveDb: (db: ServerDb) => void;
  requireAuth: (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => void;
  assertChildAccess: (
    req: AuthenticatedRequest,
    res: express.Response,
    childId: string,
  ) => StoredChildRecord | null | 'untracked-sample';
  requireAdminPermission: (permission: string) => express.RequestHandler;
}

const VALID_SURAH_ID_SET = new Set(QURAN_SURAHS.map((s) => s.id));
const VALID_RECITER_ID_SET = new Set(QURAN_RECITERS.map((r) => r.id));

function recordQuranActiveDay(
  child: StoredChildRecord,
  event: Omit<ActivityTimelineEvent, 'id' | 'timestamp'>,
) {
  const today = getTodayDayKey();
  const monthKey = getCurrentMonthKey();

  child.monthlySnapshots = child.monthlySnapshots || {};
  if (!child.monthlySnapshots[monthKey]) {
    child.monthlySnapshots[monthKey] = buildMonthlySnapshotForChild(child, monthKey);
  }

  const days = new Set(child.activeDaysHistory || []);
  days.add(today);
  child.activeDaysHistory = Array.from(days).sort().slice(-90);
  child.learningStreakDays = calculateStreakDays(child.activeDaysHistory);

  child.activityTimeline = [
    {
      id: `evt_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...event,
    },
    ...(child.activityTimeline || []),
  ].slice(0, 120);
}

export function getEffectiveQuranChildSettings(
  db: ServerDb,
  childId: string,
): QuranChildSettings {
  ensureFamilyCollections(db);
  const existing = db.quranChildSettings![childId];
  const nowIso = new Date().toISOString();
  if (existing) {
    const validAllowed = (existing.allowedSurahIds || []).filter((id) => VALID_SURAH_ID_SET.has(id));
    const validOrder = (existing.surahOrder || []).filter((id) => VALID_SURAH_ID_SET.has(id));
    for (const id of DEFAULT_ALLOWED_SURAH_IDS) {
      if (!validOrder.includes(id)) validOrder.push(id);
    }
    return {
      ...existing,
      allowedSurahIds: validAllowed.length > 0 ? validAllowed : [...DEFAULT_ALLOWED_SURAH_IDS],
      surahOrder: validOrder,
      preferredReciterId: VALID_RECITER_ID_SET.has(existing.preferredReciterId)
        ? existing.preferredReciterId
        : 'adult-husary-muallim',
      repeatCount: clampQuranRepeatCount(existing.repeatCount, 2),
      dailyMaxMinutes: clampQuranDailyMinutes(existing.dailyMaxMinutes, 15),
    };
  }
  return {
    childId,
    enabled: true,
    allowedSurahIds: [...DEFAULT_ALLOWED_SURAH_IDS],
    surahOrder: [...DEFAULT_ALLOWED_SURAH_IDS],
    preferredReciterId: 'adult-husary-muallim',
    preferChildReciterFallback: true,
    repeatCount: 2,
    listenOnlyMode: false,
    dailyMaxMinutes: 15,
    gentleReminderEnabled: false,
    updatedAt: nowIso,
  };
}

export function mergeRecitersWithVerifications(db: ServerDb): QuranReciterSpec[] {
  ensureFamilyCollections(db);
  const overrides = db.quranContentVerifications || {};
  return QURAN_RECITERS.map((reciter) => {
    const v = overrides[reciter.id];
    if (!v || v.contentType !== 'reciter_audio') return reciter;
    const safeUrls: Record<string, string> = {};
    for (const [k, url] of Object.entries(v.audioUrlsJson || {})) {
      if (isSafeQuranAudioUrl(url)) safeUrls[k] = url;
    }
    const hasAudioUrls = Object.keys(safeUrls).length > 0;
    const effectiveStatus: QuranVerificationStatus =
      v.verificationStatus === 'verified' && !hasAudioUrls
        ? 'unavailable'
        : v.verificationStatus;
    return {
      ...reciter,
      sourceName: v.sourceName || reciter.sourceName,
      licenseOrPermission: v.licenseOrPermission || reciter.licenseOrPermission,
      tajweedReviewedBy: v.tajweedReviewedBy || reciter.tajweedReviewedBy,
      tajweedReviewedAt: v.tajweedReviewedAt || reciter.tajweedReviewedAt,
      verificationStatus: effectiveStatus,
      surahAudioUrls: hasAudioUrls ? safeUrls : undefined,
      unavailableReason:
        effectiveStatus === 'verified'
          ? undefined
          : reciter.unavailableReason,
    };
  });
}

export function resolveReciterForPlayback(
  reciters: QuranReciterSpec[],
  preferredReciterId: string,
  preferChildFallback = true,
): {
  requestedReciter: QuranReciterSpec;
  activeReciter: QuranReciterSpec | null;
  usedAdultFallback: boolean;
  audioAvailable: boolean;
} {
  const requested =
    reciters.find((r) => r.id === preferredReciterId) ||
    reciters.find((r) => r.reciterType === 'adult') ||
    reciters[0];

  const isPlayableVerified = (r: QuranReciterSpec | undefined): boolean =>
    Boolean(
      r &&
        r.verificationStatus === 'verified' &&
        ((r.surahAudioUrls && Object.keys(r.surahAudioUrls).length > 0) ||
          (r.ayahAudioUrls && Object.keys(r.ayahAudioUrls).length > 0)),
    );

  if (isPlayableVerified(requested)) {
    return {
      requestedReciter: requested,
      activeReciter: requested,
      usedAdultFallback: false,
      audioAvailable: true,
    };
  }

  // Child reciter unavailable/pending -> fall back strictly to a verified adult reciter (never TTS)
  if (requested.reciterType === 'child' && preferChildFallback) {
    const verifiedAdult = reciters.find((r) => r.reciterType === 'adult' && isPlayableVerified(r));
    if (verifiedAdult) {
      return {
        requestedReciter: requested,
        activeReciter: verifiedAdult,
        usedAdultFallback: true,
        audioAvailable: true,
      };
    }
  } else {
    const otherVerifiedAdult = reciters.find((r) => r.reciterType === 'adult' && isPlayableVerified(r));
    if (otherVerifiedAdult) {
      return {
        requestedReciter: requested,
        activeReciter: otherVerifiedAdult,
        usedAdultFallback: true,
        audioAvailable: true,
      };
    }
  }

  return {
    requestedReciter: requested,
    activeReciter: null,
    usedAdultFallback: false,
    audioAvailable: false,
  };
}

export function computeNaturalSurahStatus(
  listenCount: number,
  repeatSessionsCount: number,
  ayahsPracticedCount: number,
  totalAyahs: number,
): Exclude<QuranMemorizationStatus, 'parent_confirmed'> {
  if (listenCount >= 3 && ayahsPracticedCount >= totalAyahs && totalAyahs > 0) {
    return 'familiar';
  }
  if (repeatSessionsCount >= 1 || ayahsPracticedCount >= 1) {
    return 'practiced';
  }
  if (listenCount >= 1) {
    return 'heard';
  }
  return 'not_started';
}

export function getChildQuranMinutesUsedToday(db: ServerDb, childId: string): number {
  const today = getTodayDayKey();
  const totalSeconds = (db.quranActivityEvents || [])
    .filter((ev) => ev.childId === childId && ev.occurredAt.slice(0, 10) === today)
    .reduce((sum, ev) => sum + Math.max(0, Number(ev.durationSeconds || 0)), 0);
  return Math.round((totalSeconds / 60) * 10) / 10;
}

export function buildChildQuranSummary(db: ServerDb, child: StoredChildRecord) {
  ensureFamilyCollections(db);
  const settings = getEffectiveQuranChildSettings(db, child.id);
  const reciters = mergeRecitersWithVerifications(db);
  const playback = resolveReciterForPlayback(
    reciters,
    settings.preferredReciterId,
    settings.preferChildReciterFallback,
  );

  const surahProgressList = Object.values(db.quranSurahProgress || {}).filter(
    (p) => p.childId === child.id,
  );
  const storyProgressList = Object.values(db.quranStoryProgress || {}).filter(
    (p) => p.childId === child.id,
  );
  const mannerProgressList = Object.values(db.quranMannerProgress || {}).filter(
    (p) => p.childId === child.id,
  );
  const recentEvents = (db.quranActivityEvents || [])
    .filter((ev) => ev.childId === child.id)
    .slice(0, 40);

  const minutesUsedToday = getChildQuranMinutesUsedToday(db, child.id);

  return {
    childId: child.id,
    internalAgeBand: getInternalAgeBand(child),
    featureEnabled: db.featureFlags?.quranWorldEnabled !== false,
    settings,
    playbackResolution: playback,
    minutesUsedToday,
    dailyLimitReached: minutesUsedToday >= settings.dailyMaxMinutes,
    surahProgress: surahProgressList,
    storyProgress: storyProgressList,
    mannerProgress: mannerProgressList,
    recentEvents,
    growthSummary: {
      listenedSurahsCount: surahProgressList.filter((s) => s.listenCount > 0).length,
      practicedSurahsCount: surahProgressList.filter((s) => s.repeatSessionsCount > 0).length,
      familiarSurahsCount: surahProgressList.filter(
        (s) => s.status === 'familiar' || s.status === 'parent_confirmed',
      ).length,
      parentConfirmedCount: surahProgressList.filter((s) => s.parentConfirmedMemorization).length,
      storiesReadCount: storyProgressList.filter((s) => s.completedCount > 0).length,
      mannersPracticedCount: mannerProgressList.reduce((acc, m) => acc + m.practicedCount, 0),
    },
  };
}

export function registerQuranRoutes({
  app,
  getDb,
  saveDb,
  requireAuth,
  assertChildAccess,
  requireAdminPermission,
}: QuranRoutesDeps) {
  // 1. Authenticated Catalog & Verified Provenance Registry
  app.get('/api/quran/catalog', requireAuth, (_req: AuthenticatedRequest, res) => {
    const db = getDb();
    ensureFamilyCollections(db);
    const reciters = mergeRecitersWithVerifications(db);
    return res.json({
      quranSchemaReady: isQuranSchemaReady(),
      featureEnabled: db.featureFlags?.quranWorldEnabled !== false,
      surahs: QURAN_SURAHS,
      reciters,
      stories: QURAN_STORIES,
      manners: QURAN_MANNERS,
      playbackDefaultResolution: resolveReciterForPlayback(reciters, 'adult-husary-muallim', true),
    });
  });

  // 2. Child's Quran Settings, Progress & Age-Adapted Summary
  app.get('/api/children/:id/quran', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const child = assertChildAccess(req, res, req.params.id);
    if (!child || child === 'untracked-sample') {
      if (child === 'untracked-sample') return res.status(404).json({ error: 'Child profile not found' });
      return;
    }
    if (!canUserAccessChild(db, req.authSession!.user, child, 'view_progress')) {
      return res.status(403).json({ error: 'Forbidden: missing permission to view child Quran progress.' });
    }
    return res.json({
      quranSchemaReady: isQuranSchemaReady(),
      ...buildChildQuranSummary(db, child),
    });
  });

  // 3. Record Listen / Listen & Repeat Activity (NEVER confirms memorization!)
  app.post('/api/children/:id/quran/listen', requireAuth, async (req: AuthenticatedRequest, res) => {
    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }

      if (!isQuranSchemaReady()) {
        return {
          status: 503,
          body: {
            error: 'Quran World storage tables are pending additive migration 0002_quran_world.sql.',
            code: 'QURAN_SCHEMA_PENDING',
          },
        };
      }
      if (db.featureFlags?.quranWorldEnabled === false) {
        return {
          status: 403,
          body: { error: 'Quran World is currently disabled by platform administrators.', code: 'FEATURE_DISABLED' },
        };
      }

      const user = req.authSession!.user;
      if (!isChildOrStudentRole(user.role) && !canUserAccessChild(db, user, child, 'view_progress')) {
        return { status: 403, body: { error: 'Forbidden: cannot record activity for this child.' } };
      }

      const settings = getEffectiveQuranChildSettings(db, child.id);
      if (!settings.enabled) {
        return {
          status: 403,
          body: { error: 'Quran World is currently paused by a parent for this child.', code: 'QURAN_DISABLED_FOR_CHILD' },
        };
      }

      const body = (req.body || {}) as {
        surahId?: string;
        mode?: 'listen' | 'repeat';
        ayahNumbers?: number[];
        durationSeconds?: number;
        reciterId?: string;
      };

      const surahId = sanitizeShortText(body.surahId || '', 32);
      const surah = getQuranSurahById(surahId);
      if (!surah) {
        return { status: 400, body: { error: 'Invalid Surah identifier.' } };
      }
      if (!settings.allowedSurahIds.includes(surah.id)) {
        return {
          status: 403,
          body: { error: 'This Surah is not currently enabled in this child’s Quran plan.', code: 'SURAH_NOT_ALLOWED_FOR_CHILD' },
        };
      }

      const minutesUsedToday = getChildQuranMinutesUsedToday(db, child.id);
      if (minutesUsedToday >= settings.dailyMaxMinutes) {
        return {
          status: 429,
          body: {
            error: 'Daily Quran listening time limit reached. Let’s take a peaceful break!',
            code: 'QURAN_DAILY_LIMIT_REACHED',
            dailyLimitReached: true,
            minutesUsedToday,
            dailyMaxMinutes: settings.dailyMaxMinutes,
          },
        };
      }

      const mode: 'listen' | 'repeat' = body.mode === 'repeat' && !settings.listenOnlyMode ? 'repeat' : 'listen';
      const validAyahs = Array.isArray(body.ayahNumbers)
        ? Array.from(
            new Set(
              body.ayahNumbers
                .map((n) => Math.round(Number(n)))
                .filter((n) => Number.isFinite(n) && n >= 1 && n <= surah.ayahCount),
            ),
          )
        : [];
      const durationSeconds = Math.max(0, Math.min(1800, Math.round(Number(body.durationSeconds || 20))));
      const reciterId = VALID_RECITER_ID_SET.has(String(body.reciterId || ''))
        ? String(body.reciterId)
        : settings.preferredReciterId;

      const key = `${child.id}__${surah.id}`;
      const nowIso = new Date().toISOString();
      const prev = db.quranSurahProgress![key];
      const mergedAyahs = Array.from(
        new Set([...(prev?.ayahsPracticed || []), ...validAyahs]),
      ).sort((a, b) => a - b);

      const nextListenCount = (prev?.listenCount || 0) + 1;
      const nextRepeatSessions = (prev?.repeatSessionsCount || 0) + (mode === 'repeat' ? 1 : 0);
      const naturalStatus = computeNaturalSurahStatus(
        nextListenCount,
        nextRepeatSessions,
        mergedAyahs.length,
        surah.ayahCount,
      );

      // Preserve prior explicit parent confirmation if already confirmed; NEVER confirm automatically
      const parentConfirmed = Boolean(prev?.parentConfirmedMemorization);
      const nextStatus: QuranMemorizationStatus = parentConfirmed ? 'parent_confirmed' : naturalStatus;

      const updatedProgress: QuranSurahProgress = {
        id: key,
        childId: child.id,
        surahId: surah.id,
        listenCount: nextListenCount,
        repeatSessionsCount: nextRepeatSessions,
        ayahsPracticed: mergedAyahs,
        status: nextStatus,
        parentConfirmedMemorization: parentConfirmed,
        parentConfirmedAt: prev?.parentConfirmedAt,
        parentConfirmedByUserId: prev?.parentConfirmedByUserId,
        parentNote: prev?.parentNote,
        lastListenedAt: nowIso,
        updatedAt: nowIso,
      };
      db.quranSurahProgress![key] = updatedProgress;

      const event: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: mode,
        targetId: surah.id,
        durationSeconds,
        ayahCount: validAyahs.length || surah.ayahCount,
        reciterId,
        recordedByUserId: user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [event, ...(db.quranActivityEvents || [])].slice(0, 2000);

      ensureChildFamilyAndGarden(db, child);
      child.totalLearningMinutes = (child.totalLearningMinutes || 0) + Math.max(0, Math.round(durationSeconds / 60));
      recordQuranActiveDay(child, {
        category: 'quran',
        title: { ar: `الاستماع إلى ${surah.nameAr}`, en: `Quran Time: ${surah.nameEn}` },
        detail:
          mode === 'repeat'
            ? { ar: 'استماع وترديد هادئ في عالم القرآن', en: 'Calm listen & repeat session' }
            : { ar: 'جلسة استماع هادئة في عالم القرآن', en: 'Calm Quran listening moment' },
      });

      awardGardenMilestoneIdempotent(db, child, {
        milestoneKey: 'quran-first-listen',
        preferredItemId: 'garden-olive-tree',
        reason: { ar: 'أول لحظة استماع هادئة في عالم القرآن', en: 'First peaceful moment in Quran World' },
      });
      if (mode === 'repeat') {
        awardGardenMilestoneIdempotent(db, child, {
          milestoneKey: 'quran-repeat-explorer',
          preferredItemId: 'garden-star-lantern',
          reason: { ar: 'الترديد اللطيف لآيات القرآن الكريم', en: 'Gentle listen & repeat in Quran World' },
        });
      }

      return {
        status: 200,
        body: {
          progress: updatedProgress,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 4. Record Quran Story Engagement (Symbolic only, non-competitive)
  app.post('/api/children/:id/quran/story', requireAuth, async (req: AuthenticatedRequest, res) => {
    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }
      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }
      if (db.featureFlags?.quranWorldEnabled === false) {
        return { status: 403, body: { error: 'Quran World is disabled.', code: 'FEATURE_DISABLED' } };
      }

      const settings = getEffectiveQuranChildSettings(db, child.id);
      if (!settings.enabled) {
        return { status: 403, body: { error: 'Quran World is disabled for this child.', code: 'QURAN_DISABLED_FOR_CHILD' } };
      }

      const storyId = sanitizeShortText(req.body?.storyId || '', 64);
      const story = getQuranStoryById(storyId);
      if (!story) {
        return { status: 400, body: { error: 'Invalid Quran story identifier.' } };
      }

      const key = `${child.id}__${story.id}`;
      const nowIso = new Date().toISOString();
      const prev = db.quranStoryProgress![key];
      const next: QuranStoryProgress = {
        id: key,
        childId: child.id,
        storyId: story.id,
        completedCount: (prev?.completedCount || 0) + 1,
        lastReadAt: nowIso,
      };
      db.quranStoryProgress![key] = next;

      const qEvent: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: 'story',
        targetId: story.id,
        durationSeconds: 30,
        ayahCount: 0,
        recordedByUserId: req.authSession!.user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [qEvent, ...(db.quranActivityEvents || [])].slice(0, 2000);

      ensureChildFamilyAndGarden(db, child);
      recordQuranActiveDay(child, {
        category: 'quran',
        title: story.title,
        detail: { ar: 'قصة قرآنية مصوّرة برموز هادئة', en: 'Completed a symbolic Quran story' },
      });

      return {
        status: 200,
        body: {
          storyProgress: next,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 5. Record Islamic Manner Practice
  app.post('/api/children/:id/quran/manner', requireAuth, async (req: AuthenticatedRequest, res) => {
    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }
      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }
      if (db.featureFlags?.quranWorldEnabled === false) {
        return { status: 403, body: { error: 'Quran World is disabled.', code: 'FEATURE_DISABLED' } };
      }

      const settings = getEffectiveQuranChildSettings(db, child.id);
      if (!settings.enabled) {
        return { status: 403, body: { error: 'Quran World is disabled for this child.', code: 'QURAN_DISABLED_FOR_CHILD' } };
      }

      const mannerId = sanitizeShortText(req.body?.mannerId || '', 64);
      const manner = getQuranMannerById(mannerId);
      if (!manner) {
        return { status: 400, body: { error: 'Invalid Islamic manner identifier.' } };
      }

      const key = `${child.id}__${manner.id}`;
      const nowIso = new Date().toISOString();
      const prev = db.quranMannerProgress![key];
      const next: QuranMannerProgress = {
        id: key,
        childId: child.id,
        mannerId: manner.id,
        practicedCount: (prev?.practicedCount || 0) + 1,
        lastPracticedAt: nowIso,
      };
      db.quranMannerProgress![key] = next;

      const qEvent: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: 'manner',
        targetId: manner.id,
        durationSeconds: 15,
        ayahCount: 0,
        recordedByUserId: req.authSession!.user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [qEvent, ...(db.quranActivityEvents || [])].slice(0, 2000);

      ensureChildFamilyAndGarden(db, child);
      recordQuranActiveDay(child, {
        category: 'quran',
        title: manner.title,
        detail: { ar: `تطبيق أدب إسلامي جميل: ${manner.phraseAr}`, en: `Practiced daily manner: ${manner.transliteration}` },
      });

      awardGardenMilestoneIdempotent(db, child, {
        milestoneKey: 'quran-kind-manners',
        preferredItemId: 'garden-family-blossom',
        reason: { ar: 'ممارسة أدب إسلامي جميل اليوم', en: 'Practiced a kind Islamic manner today' },
      });

      return {
        status: 200,
        body: {
          mannerProgress: next,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 6. Parent-Gated Quran Settings Update (Parent / Authorized Guardian Only)
  app.put('/api/children/:id/quran/settings', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!requireParentGate(req, res)) return;

    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }

      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }

      const user = req.authSession!.user;
      if (!canUserAccessChild(db, user, child, 'manage_learning_settings')) {
        return {
          status: 403,
          body: { error: 'Forbidden: manage_learning_settings permission required.', code: 'GUARDIAN_PERMISSION_DENIED' },
        };
      }

      const current = getEffectiveQuranChildSettings(db, child.id);
      const body = (req.body || {}) as Partial<QuranChildSettings>;

      const nextAllowed = Array.isArray(body.allowedSurahIds)
        ? body.allowedSurahIds.filter((id) => typeof id === 'string' && VALID_SURAH_ID_SET.has(id))
        : current.allowedSurahIds;

      const rawOrder = Array.isArray(body.surahOrder)
        ? body.surahOrder.filter((id) => typeof id === 'string' && VALID_SURAH_ID_SET.has(id))
        : current.surahOrder;
      const dedupOrder = Array.from(new Set(rawOrder));
      for (const id of DEFAULT_ALLOWED_SURAH_IDS) {
        if (!dedupOrder.includes(id)) dedupOrder.push(id);
      }

      const preferredReciterId =
        typeof body.preferredReciterId === 'string' && VALID_RECITER_ID_SET.has(body.preferredReciterId)
          ? body.preferredReciterId
          : current.preferredReciterId;

      const nowIso = new Date().toISOString();
      const updated: QuranChildSettings = {
        childId: child.id,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        allowedSurahIds: nextAllowed.length > 0 ? Array.from(new Set(nextAllowed)) : current.allowedSurahIds,
        surahOrder: dedupOrder,
        preferredReciterId,
        preferChildReciterFallback:
          typeof body.preferChildReciterFallback === 'boolean'
            ? body.preferChildReciterFallback
            : current.preferChildReciterFallback,
        repeatCount:
          body.repeatCount !== undefined ? clampQuranRepeatCount(body.repeatCount, current.repeatCount) : current.repeatCount,
        listenOnlyMode: typeof body.listenOnlyMode === 'boolean' ? body.listenOnlyMode : current.listenOnlyMode,
        dailyMaxMinutes:
          body.dailyMaxMinutes !== undefined
            ? clampQuranDailyMinutes(body.dailyMaxMinutes, current.dailyMaxMinutes)
            : current.dailyMaxMinutes,
        gentleReminderEnabled:
          typeof body.gentleReminderEnabled === 'boolean'
            ? body.gentleReminderEnabled
            : current.gentleReminderEnabled,
        updatedByUserId: user.id,
        updatedAt: nowIso,
      };
      db.quranChildSettings![child.id] = updated;

      if (child.familyId) {
        recordFamilyEvent(db, {
          familyId: child.familyId,
          category: 'learning',
          actionType: 'QURAN_SETTINGS_UPDATED',
          actorId: user.id,
          actorName: user.displayName,
          actorRole: user.role,
          childId: child.id,
          childName: child.displayName,
          title: { ar: 'تحديث إعدادات عالم القرآن الكريم', en: 'Quran World settings updated' },
          description: {
            ar: `حدّث ${user.displayName} إعدادات عالم القرآن للطفل ${child.displayName} (مفعّل=${updated.enabled}، الحد اليومي=${updated.dailyMaxMinutes} د)`,
            en: `${user.displayName} updated Quran World settings for ${child.displayName} (enabled=${updated.enabled}, max=${updated.dailyMaxMinutes}m)`,
          },
          ip: getClientIp(req),
        });
      }

      return {
        status: 200,
        body: {
          settings: updated,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 7. Parent-Only Explicit Memorization Confirmation (Parent Gate + approve_content)
  app.post('/api/children/:id/quran/memorization-confirm', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!requireParentGate(req, res)) return;

    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }

      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }

      const user = req.authSession!.user;
      if (!canUserAccessChild(db, user, child, 'approve_content')) {
        return {
          status: 403,
          body: { error: 'Forbidden: approve_content permission required to confirm memorization.', code: 'GUARDIAN_PERMISSION_DENIED' },
        };
      }

      const body = (req.body || {}) as {
        surahId?: string;
        confirmed?: boolean;
        parentNote?: string;
      };

      const surahId = sanitizeShortText(body.surahId || '', 32);
      const surah = getQuranSurahById(surahId);
      if (!surah) {
        return { status: 400, body: { error: 'Invalid Surah identifier.' } };
      }

      const confirmed = Boolean(body.confirmed);
      const cleanNote = body.parentNote !== undefined ? sanitizeQuranNote(body.parentNote, 280) : undefined;
      const key = `${child.id}__${surah.id}`;
      const prev = db.quranSurahProgress![key];
      const nowIso = new Date().toISOString();

      const naturalStatus = computeNaturalSurahStatus(
        prev?.listenCount || 0,
        prev?.repeatSessionsCount || 0,
        (prev?.ayahsPracticed || []).length,
        surah.ayahCount,
      );

      const updated: QuranSurahProgress = {
        id: key,
        childId: child.id,
        surahId: surah.id,
        listenCount: prev?.listenCount || 0,
        repeatSessionsCount: prev?.repeatSessionsCount || 0,
        ayahsPracticed: prev?.ayahsPracticed || [],
        status: confirmed ? 'parent_confirmed' : naturalStatus,
        parentConfirmedMemorization: confirmed,
        parentConfirmedAt: confirmed ? nowIso : undefined,
        parentConfirmedByUserId: confirmed ? user.id : undefined,
        parentNote: cleanNote !== undefined ? cleanNote || undefined : prev?.parentNote,
        lastListenedAt: prev?.lastListenedAt,
        updatedAt: nowIso,
      };
      db.quranSurahProgress![key] = updated;

      const qEvent: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: 'parent_confirm',
        targetId: surah.id,
        durationSeconds: 0,
        ayahCount: surah.ayahCount,
        recordedByUserId: user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [qEvent, ...(db.quranActivityEvents || [])].slice(0, 2000);

      if (child.familyId) {
        recordFamilyEvent(db, {
          familyId: child.familyId,
          category: 'learning',
          actionType: confirmed ? 'QURAN_MEMORIZATION_CONFIRMED' : 'QURAN_MEMORIZATION_UNCONFIRMED',
          actorId: user.id,
          actorName: user.displayName,
          actorRole: user.role,
          childId: child.id,
          childName: child.displayName,
          title: confirmed
            ? { ar: `اعتماد حفظ ${surah.nameAr} بواسطة ولي الأمر`, en: `Parent confirmed ${surah.nameEn} memorization` }
            : { ar: `إلغاء اعتماد حفظ ${surah.nameAr}`, en: `Parent cleared ${surah.nameEn} confirmation` },
          description: {
            ar: confirmed
              ? `أكّد ${user.displayName} حفظ الطفل ${child.displayName} لسورة ${surah.nameAr}`
              : `أعاد ${user.displayName} حالة حفظ ${surah.nameAr} للمتابعة المستمرة`,
            en: confirmed
              ? `${user.displayName} confirmed ${child.displayName} memorized ${surah.nameEn}`
              : `${user.displayName} reset parent memorization confirmation for ${surah.nameEn}`,
          },
          ip: getClientIp(req),
        });
      }

      return {
        status: 200,
        body: {
          progress: updated,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 8. Admin Provenance & Recitation Verification Registry (manage_lessons RBAC)
  app.get('/api/admin/quran/verifications', requireAdminPermission('manage_lessons'), (_req, res) => {
    const db = getDb();
    ensureFamilyCollections(db);
    return res.json({
      surahTexts: QURAN_SURAHS.map((s) => ({
        contentKey: s.id,
        contentType: 'surah_text' as const,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        ayahCount: s.ayahCount,
        textSource: s.textSource,
        textSourceUrl: s.textSourceUrl,
        textSha256: s.textSha256,
        verificationStatus: s.textVerificationStatus,
      })),
      reciters: mergeRecitersWithVerifications(db),
      customRecords: Object.values(db.quranContentVerifications || {}),
    });
  });

  app.put('/api/admin/quran/verifications/:key', requireAdminPermission('manage_lessons'), (req: AuthenticatedRequest, res) => {
    if (!isQuranSchemaReady()) {
      return res.status(503).json({ error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' });
    }
    const db = getDb();
    ensureFamilyCollections(db);
    const key = sanitizeShortText(req.params.key || '', 64);
    const reciter = getQuranReciterById(key);
    if (!reciter) {
      return res.status(404).json({
        error: 'Unknown Quran reciter verification key. Quran Surah text cannot be edited via admin verification.',
      });
    }

    const body = (req.body || {}) as {
      sourceName?: string;
      licenseOrPermission?: string;
      tajweedReviewedBy?: string;
      tajweedReviewedAt?: string;
      verificationStatus?: QuranVerificationStatus;
      audioUrlsJson?: Record<string, string>;
      notes?: string;
    };

    const allowedStatuses: QuranVerificationStatus[] = ['verified', 'pending_verification', 'unavailable'];
    const nextStatus = allowedStatuses.includes(body.verificationStatus as QuranVerificationStatus)
      ? (body.verificationStatus as QuranVerificationStatus)
      : 'pending_verification';

    const cleanUrls: Record<string, string> = {};
    if (body.audioUrlsJson && typeof body.audioUrlsJson === 'object') {
      for (const [surahId, rawUrl] of Object.entries(body.audioUrlsJson)) {
        if (!VALID_SURAH_ID_SET.has(surahId)) continue;
        if (!isSafeQuranAudioUrl(rawUrl)) {
          return res.status(400).json({
            error: `Unsafe or invalid audio URL for ${surahId}. Only https:// or /assets/quran/ paths are permitted.`,
          });
        }
        cleanUrls[surahId] = rawUrl.trim();
      }
    }

    const cleanSource = sanitizeShortText(body.sourceName || reciter.sourceName, 160);
    const cleanLicense = sanitizeShortText(body.licenseOrPermission || reciter.licenseOrPermission, 200);
    const cleanReviewer = body.tajweedReviewedBy ? sanitizeShortText(body.tajweedReviewedBy, 120) : undefined;
    const cleanReviewedAt = body.tajweedReviewedAt ? sanitizeShortText(body.tajweedReviewedAt, 40) : undefined;

    if (nextStatus === 'verified') {
      if (Object.keys(cleanUrls).length === 0 || !cleanLicense || !cleanReviewer) {
        return res.status(400).json({
          error: 'Cannot mark reciter audio as verified without audioUrlsJson, licenseOrPermission, and tajweedReviewedBy.',
        });
      }
    }

    const nowIso = new Date().toISOString();
    const record: QuranContentVerificationRecord = {
      id: `qver_${key}`,
      contentType: 'reciter_audio',
      contentKey: key,
      sourceName: cleanSource,
      licenseOrPermission: cleanLicense,
      tajweedReviewedBy: cleanReviewer,
      tajweedReviewedAt: cleanReviewedAt,
      verificationStatus: nextStatus,
      audioUrlsJson: Object.keys(cleanUrls).length > 0 ? cleanUrls : undefined,
      notes: body.notes ? sanitizeQuranNote(body.notes, 280) : undefined,
      updatedByUserId: req.authSession?.user.id,
      updatedAt: nowIso,
    };
    db.quranContentVerifications![key] = record;

    recordAuditEvent(db, {
      eventType: 'CONTENT_REVIEW',
      actorId: req.authSession?.user.id || 'admin',
      actorRole: req.authSession?.user.role || 'admin',
      actionType: 'QURAN_VERIFICATION_UPDATED',
      recordType: 'quran_content_verification',
      recordId: key,
      newValue: {
        verificationStatus: record.verificationStatus,
        sourceName: record.sourceName,
        surahUrlsCount: Object.keys(cleanUrls).length,
      },
      summary: `Updated Quran verification provenance for ${key} -> ${record.verificationStatus}`,
      ip: getClientIp(req),
    });

    saveDb(db);
    return res.json({
      verification: record,
      reciters: mergeRecitersWithVerifications(db),
    });
  });
}
