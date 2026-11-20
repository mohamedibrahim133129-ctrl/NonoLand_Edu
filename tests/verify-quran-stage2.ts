import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  buildMonthlyReport,
  computeChildSubjectMetrics,
  getCurrentMonthKey,
  type QuranGrowthMetricsInput,
} from '../src/engine/monthlyReportEngine';
import type { ChildProfile, MonthlyReportSubjectSummary, QuranReciterSpec, SkillId, SkillProgress } from '../src/types/nonoland';
import { resolveVerifiedAudioUrl } from '../src/utils/quranAudioPlayer';

let TEST_PORT = 3098;
let BASE = `http://127.0.0.1:${TEST_PORT}`;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3198;
      srv.close(() => resolve(port));
    });
  });
}

class TestClient {
  cookies = new Map<string, string>();
  csrfToken = '';

  private buildCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private captureCookies(res: Response) {
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const rawList =
      typeof getSetCookie === 'function'
        ? getSetCookie.call(res.headers)
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')!]
          : [];
    for (const entry of rawList) {
      for (const name of ['nono_session', 'nono_device']) {
        const m = entry.match(new RegExp(`${name}=([^;]+)`));
        if (m) {
          if (m[1]) this.cookies.set(name, m[1]);
          else this.cookies.delete(name);
        }
      }
    }
  }

  async req(
    method: string,
    urlPath: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookieStr = this.buildCookieHeader();
    if (cookieStr) headers['Cookie'] = cookieStr;
    if (
      this.csrfToken &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) &&
      !('x-csrf-token' in headers)
    ) {
      headers['x-csrf-token'] = this.csrfToken;
    }

    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.captureCookies(res);

    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = { raw: text };
    }
    if (typeof data.csrfToken === 'string') {
      this.csrfToken = data.csrfToken;
    }
    return { status: res.status, data };
  }
}

async function startIsolatedInMemoryServer(): Promise<{ proc: ChildProcess; adminSecret: string }> {
  TEST_PORT = await getFreePort();
  BASE = `http://127.0.0.1:${TEST_PORT}`;
  const adminSecret = 'inmem-stage2-admin-secret-2026';
  const sessionSecret = 'inmem-stage2-session-secret-2026';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(TEST_PORT),
    NODE_ENV: 'development',
    SKIP_VITE: '1',
    DISABLE_DEV_SEED: 'true',
    REQUIRE_POSTGRES: 'false',
    NONOLAND_DB_HOST: '',
    NONOLAND_DB_DIRECT_HOST: '',
    NONOLAND_DB_NAME: '',
    NONOLAND_DB_USER: '',
    NONOLAND_DB_PASSWORD: '',
    SQL_HOST: '',
    SQL_DIRECT_HOST: '',
    SQL_DB_NAME: '',
    SQL_USER: '',
    SQL_PASSWORD: '',
    DATABASE_URL: '',
    DIRECT_DATABASE_URL: '',
    NONOLAND_SESSION_SECRET: sessionSecret,
    NONOLAND_ADMIN_SETUP_SECRET: adminSecret,
  };

  const proc = spawn('npx', ['tsx', 'server.ts'], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  proc.stdout?.on('data', (d) => {
    logs += d.toString();
  });
  proc.stderr?.on('data', (d) => {
    logs += d.toString();
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        const health = (await r.json()) as { database?: string };
        assert.strictEqual(
          health.database,
          'in-memory-dev',
          `Stage 2 test server MUST run in in-memory-dev mode, got ${health.database}`,
        );
        return { proc, adminSecret };
      }
    } catch {
      // Wait for boot
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  proc.kill('SIGTERM');
  throw new Error(`Isolated test server failed to start on ${BASE}. Logs:\n${logs}`);
}

function makeEmptySkill(skillId: SkillId, attempts = 0, correctCount = 0, accuracy = 0, lastPracticedAt?: string): SkillProgress {
  return {
    skillId,
    attempts,
    correctCount,
    accuracy,
    streak: attempts,
    masteryLevel: accuracy >= 80 ? 'confident' : 'exploring',
    lastPracticedAt,
  };
}

function makeSampleChild(): ChildProfile {
  const now = new Date().toISOString();
  return {
    id: 'child-stage2-test',
    displayName: 'نونو الصغير',
    ageGroup: '1-4',
    birthYear: 2023,
    birthMonth: 6,
    language: 'ar',
    interests: ['quran', 'stories'],
    companionId: 'nono',
    companionScarfColor: '#8054D9',
    stars: 10,
    level: 1,
    completedBaseline: true,
    unlockedWorlds: ['arabic-letters'],
    totalLearningMinutes: 25,
    completedActivityIds: ['act-1'],
    unlockedCharacters: ['nono'],
    unlockedBadges: [],
    unlockedRoomItems: [],
    placedRoomItems: [],
    savedDrawings: [],
    certificates: [],
    assessmentHistory: [],
    completedStoryIds: [],
    completedMissionsToday: [],
    downloadedWorldIds: [],
    attempts: [
      {
        id: 'att-1',
        worldId: 'arabic-letters',
        activityId: 'act-alif',
        skillId: 'arabic-literacy',
        ageGroup: '1-4',
        score: 4,
        maxScore: 5,
        accuracy: 80,
        completedAt: now,
        durationSeconds: 45,
        starsEarned: 2,
        synced: true,
      },
    ],
    skillProgress: {
      'early-recognition': makeEmptySkill('early-recognition'),
      'arabic-literacy': makeEmptySkill('arabic-literacy', 1, 4, 80, now),
      'english-literacy': makeEmptySkill('english-literacy'),
      numeracy: makeEmptySkill('numeracy'),
      'math-reasoning': makeEmptySkill('math-reasoning'),
      'logic-patterns': makeEmptySkill('logic-patterns'),
      'memory-focus': makeEmptySkill('memory-focus'),
      'science-discovery': makeEmptySkill('science-discovery'),
      'creativity-expression': makeEmptySkill('creativity-expression'),
      'life-health': makeEmptySkill('life-health'),
    },
    level1Progress: {
      'l1-ar-1': {
        lessonId: 'l1-ar-1',
        subject: 'arabic',
        startedAt: now,
        explanationViewed: true,
        completedActivityIds: ['act-alif'],
        status: 'demonstrated',
        correctCount: 5,
        mistakesCount: 0,
        attemptsCount: 1,
        lastScore: 5,
        lastTotal: 5,
        lastPracticedAt: now,
      },
    },
    level2Progress: {},
    examHistory: [
      {
        id: 'ex-1',
        childId: 'child-stage2-test',
        childName: 'نونو الصغير',
        ageGroup: '1-4',
        subject: 'arabic',
        mode: 'official',
        score: 36,
        totalQuestions: 40,
        percentage: 90,
        passed: true,
        passingPercentage: 70,
        weakLessonTitles: [],
        completedAt: now,
        paymentVerified: true,
        amountPaidEgp: 50,
      },
    ],
    activityTimeline: [],
    activeDaysHistory: [],
    monthlySnapshots: {},
    creativeProjects: [],
  };
}

async function runTests() {
  console.log('=== 1. STATIC AUDIO, TTS, MIC & UNIFIED AGE-UI SAFETY CHECK ===');
  const quranFiles = [
    'src/screens/QuranWorldScreen.tsx',
    'src/utils/quranAudioPlayer.ts',
    'src/components/quran/ParentQuranSettingsPanel.tsx',
    'src/components/quran/AdminQuranProvenancePanel.tsx',
    'src/components/quran/QuranSymbolicScene.tsx',
  ];
  for (const rel of quranFiles) {
    const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
    // Must not call speechSynthesis API or Web Speech / microphone APIs
    assert.ok(!/window\.speechSynthesis/.test(content), `${rel} must never call window.speechSynthesis`);
    assert.ok(!/SpeechSynthesisUtterance/.test(content), `${rel} must never use SpeechSynthesisUtterance`);
    assert.ok(!/getUserMedia/.test(content), `${rel} must never request microphone getUserMedia`);
    assert.ok(!/SpeechRecognition/.test(content), `${rel} must never use SpeechRecognition`);
    assert.ok(!/\beval\(/.test(content), `${rel} must never call eval`);
    assert.ok(!/soundEngine\.speak/.test(content), `${rel} must never use TTS soundEngine.speak`);
  }

  const audioTestsPending: QuranReciterSpec = {
    id: 'test-pending',
    reciterType: 'adult',
    name: { ar: 'قارئ', en: 'Reciter' },
    style: { ar: 'مرتل', en: 'Murattal' },
    sourceName: 'Archive',
    licenseOrPermission: 'Pending',
    verificationStatus: 'pending_verification',
    surahAudioUrls: { 'surah-112': 'https://example.org/ignored.mp3' },
  };
  assert.strictEqual(resolveVerifiedAudioUrl(audioTestsPending, 'surah-112'), null);

  const audioTestsUnsafe: QuranReciterSpec = {
    id: 'test-unsafe',
    reciterType: 'adult',
    name: { ar: 'قارئ', en: 'Reciter' },
    style: { ar: 'مرتل', en: 'Murattal' },
    sourceName: 'Archive',
    licenseOrPermission: 'Verified',
    verificationStatus: 'verified',
    surahAudioUrls: { 'surah-112': 'javascript:alert(1)' },
  };
  assert.strictEqual(resolveVerifiedAudioUrl(audioTestsUnsafe, 'surah-112'), null);

  const audioTestsValid: QuranReciterSpec = {
    id: 'test-valid',
    reciterType: 'adult',
    name: { ar: 'قارئ', en: 'Reciter' },
    style: { ar: 'مرتل', en: 'Murattal' },
    sourceName: 'Archive',
    licenseOrPermission: 'Verified',
    verificationStatus: 'verified',
    surahAudioUrls: { 'surah-112': 'https://example.org/verified/112.mp3' },
  };
  const validResolved = resolveVerifiedAudioUrl(audioTestsValid, 'surah-112');
  assert.strictEqual(validResolved, 'https://example.org/verified/112.mp3');
  console.log('PASS: Zero TTS/AI-voice/mic/eval APIs; audio controller rejects pending & unsafe URLs.');

  console.log('=== 2. GROWTH JOURNEY / MONTHLY REPORT ENGINE ISOLATION ===');
  const sampleChild = makeSampleChild();
  const baseMetrics = computeChildSubjectMetrics(sampleChild, null);
  const quranGrowth: QuranGrowthMetricsInput = {
    listenedSurahsCount: 4,
    practicedSurahsCount: 2,
    familiarSurahsCount: 2,
    parentConfirmedCount: 1,
    storiesReadCount: 2,
    mannersPracticedCount: 3,
  };
  const withQuranMetrics = computeChildSubjectMetrics(sampleChild, quranGrowth);
  assert.strictEqual(withQuranMetrics['quran-values'].accuracyPct, null, 'quran-values must NEVER calculate exam accuracy %');
  assert.strictEqual(withQuranMetrics['quran-values'].completedCount, 11);
  assert.strictEqual(withQuranMetrics['quran-values'].demonstratedCount, 3);
  // Academic subjects completely untouched by Quran metrics
  assert.deepStrictEqual(withQuranMetrics.arabic, baseMetrics.arabic);
  assert.deepStrictEqual(withQuranMetrics.math, baseMetrics.math);

  const report = buildMonthlyReport(sampleChild, getCurrentMonthKey(), undefined, quranGrowth);
  const quranRow = report.subjectBreakdown.find((s) => s.subjectKey === 'quran-values');
  assert.ok(quranRow, 'Monthly report must include quran-values domain');
  assert.strictEqual(quranRow.currentAccuracyPct, null, 'Monthly report quran-values must not use exam percentages');
  assert.strictEqual(quranRow.completedLessonsAndActivities, 11);
  console.log('PASS: Quran & Islamic Values domain is cleanly decoupled from academic exam metrics.');

  console.log('=== 3. ISOLATED IN-MEMORY STAGE 2 API & SETTINGS E2E ===');
  const { proc, adminSecret } = await startIsolatedInMemoryServer();
  try {
    const ts = Date.now();
    const pw = 'Stage2Safe!2026Pass';

    const parent = new TestClient();
    assert.strictEqual(
      (
        await parent.req('POST', '/api/auth/register', {
          displayName: 'أم نور',
          email: `parent.stage2.${ts}@example.com`,
          password: pw,
          termsAccepted: true,
        })
      ).status,
      201,
    );
    const createdChild = await parent.req('POST', '/api/children', {
      displayName: 'نور',
      ageGroup: '1-4',
      language: 'ar',
      birthYear: 2023,
      birthMonth: 4,
    });
    assert.strictEqual(createdChild.status, 201);
    const childId = (createdChild.data.child as { id: string }).id;

    // Parent Gate PIN + Child quick login
    assert.strictEqual(
      (await parent.req('POST', '/api/parent/gate/pin', { currentPassword: pw, newPin: '5291' })).status,
      200,
    );
    assert.strictEqual(
      (await parent.req('POST', '/api/parent/gate/verify', { pin: '5291' })).status,
      200,
    );
    const cred = await parent.req('POST', `/api/family/children/${childId}/credentials`, { pin: '2468' });
    assert.strictEqual(cred.status, 201);

    // Update ordered Surahs + listenOnlyMode via Parent Controls
    const updSettings = await parent.req('PUT', `/api/children/${childId}/quran/settings`, {
      enabled: true,
      allowedSurahIds: ['surah-112', 'surah-1'],
      surahOrder: ['surah-112', 'surah-1', 'surah-113', 'surah-114'],
      repeatCount: 4,
      listenOnlyMode: true,
      dailyMaxMinutes: 20,
      gentleReminderEnabled: true,
    });
    assert.strictEqual(updSettings.status, 200);

    // Child logs in & checks ordered Surahs, logs listen/story/manner
    const child = new TestClient();
    assert.strictEqual(
      (
        await child.req('POST', '/api/auth/child-login', {
          accessCode: cred.data.accessCode,
          pin: '2468',
        })
      ).status,
      200,
    );

    const childQuran = await child.req('GET', `/api/children/${childId}/quran`);
    assert.strictEqual(childQuran.status, 200);
    assert.strictEqual(childQuran.data.quranSchemaReady, true);
    assert.strictEqual(childQuran.data.featureEnabled, true);
    assert.strictEqual((childQuran.data.settings as { listenOnlyMode: boolean }).listenOnlyMode, true);
    assert.strictEqual(
      ((childQuran.data.settings as { surahOrder: string[] }).surahOrder || [])[0],
      'surah-112',
    );

    assert.strictEqual(
      (await child.req('POST', `/api/children/${childId}/quran/listen`, {
        surahId: 'surah-112',
        mode: 'listen',
        durationSeconds: 30,
      })).status,
      200,
    );
    assert.strictEqual(
      (await child.req('POST', `/api/children/${childId}/quran/story`, { storyId: 'qstory-ant' })).status,
      200,
    );
    assert.strictEqual(
      (await child.req('POST', `/api/children/${childId}/quran/manner`, { mannerId: 'manner-salam' })).status,
      200,
    );

    // Parent checks monthly-report includes Quran moments without altering academic scores
    const mReport = await parent.req('GET', `/api/children/${childId}/monthly-report`);
    assert.strictEqual(mReport.status, 200);
    const reportBody = mReport.data.report as {
      subjectBreakdown: Array<{
        subjectKey: string;
        completedLessonsAndActivities: number;
        currentAccuracyPct: number | null;
      }>;
    };
    const qDomain = reportBody.subjectBreakdown.find((s) => s.subjectKey === 'quran-values');
    assert.ok(qDomain);
    assert.strictEqual(qDomain.currentAccuracyPct, null);
    assert.ok(
      qDomain.completedLessonsAndActivities >= 3,
      `Monthly report must reflect logged Quran listens, stories, and manners (got ${qDomain.completedLessonsAndActivities})`,
    );

    // Admin toggles quranWorldEnabled=false -> child API reflects featureEnabled=false and blocks child writes
    const admin = new TestClient();
    const adminPw = 'Stage2Admin!2026Strong';
    assert.strictEqual(
      (
        await admin.req('POST', '/api/auth/admin-bootstrap', {
          setupSecret: adminSecret,
          displayName: 'Super Admin Two',
          email: `admin.stage2.${ts}@example.com`,
          password: adminPw,
          confirmPassword: adminPw,
        })
      ).status,
      201,
    );
    const flagsRes = await admin.req('GET', '/api/config/features');
    assert.strictEqual(flagsRes.status, 200);
    const curFlags = flagsRes.data.featureFlags as Record<string, boolean>;
    assert.strictEqual(
      (
        await admin.req('PUT', '/api/admin/feature-flags', {
          ...curFlags,
          quranWorldEnabled: false,
        })
      ).status,
      200,
    );

    const disabledCatalog = await child.req('GET', '/api/quran/catalog');
    assert.strictEqual(disabledCatalog.status, 200);
    assert.strictEqual(disabledCatalog.data.featureEnabled, false);
    const disabledWrite = await child.req('POST', `/api/children/${childId}/quran/listen`, {
      surahId: 'surah-112',
      mode: 'listen',
      durationSeconds: 15,
    });
    assert.strictEqual(disabledWrite.status, 403);

    // Re-enable flag
    assert.strictEqual(
      (
        await admin.req('PUT', '/api/admin/feature-flags', {
          ...curFlags,
          quranWorldEnabled: true,
        })
      ).status,
      200,
    );

    // Logout regression: Parent & Child stale cookie replay rejected
    const savedChildCookie = child.cookies.get('nono_session');
    assert.ok(savedChildCookie);
    assert.strictEqual((await child.req('POST', '/api/auth/logout')).status, 200);
    const childReplayMe = await fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: `nono_session=${savedChildCookie}` },
    });
    assert.strictEqual(childReplayMe.status, 200);
    assert.strictEqual(((await childReplayMe.json()) as { authenticated: boolean }).authenticated, false);
    const childReplayProtected = await fetch(`${BASE}/api/children/${childId}/quran`, {
      headers: { Cookie: `nono_session=${savedChildCookie}` },
    });
    assert.strictEqual(childReplayProtected.status, 401);

    const savedParentCookie = parent.cookies.get('nono_session');
    assert.ok(savedParentCookie);
    assert.strictEqual((await parent.req('POST', '/api/auth/logout')).status, 200);
    const parentReplayMe = await fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: `nono_session=${savedParentCookie}` },
    });
    assert.strictEqual(parentReplayMe.status, 200);
    assert.strictEqual(((await parentReplayMe.json()) as { authenticated: boolean }).authenticated, false);
    const parentReplayProtected = await fetch(`${BASE}/api/children/${childId}/quran`, {
      headers: { Cookie: `nono_session=${savedParentCookie}` },
    });
    assert.strictEqual(parentReplayProtected.status, 401);

    console.log('ALL QURAN WORLD STAGE 2 TESTS PASSED (in-memory-dev)!');
  } finally {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
    }
  }
}

runTests().catch((err) => {
  console.error('STAGE 2 TEST FAILURE:', err);
  process.exit(1);
});
