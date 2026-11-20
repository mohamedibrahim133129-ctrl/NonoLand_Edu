import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { QURAN_RECITERS, QURAN_STORIES, QURAN_SURAHS } from '../src/data/quranCatalog';

let TEST_PORT = 3099;
let BASE = `http://127.0.0.1:${TEST_PORT}`;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 3199;
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
  const adminSecret = 'inmem-test-admin-setup-secret-2026';
  const sessionSecret = 'inmem-test-session-secret-2026-only';
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
        const health = (await r.json()) as { database?: string; status?: string };
        assert.strictEqual(
          health.database,
          'in-memory-dev',
          `Test server MUST run in in-memory-dev mode, got ${health.database}`,
        );
        return { proc, adminSecret };
      }
    } catch {
      // Wait for startup
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  proc.kill('SIGTERM');
  throw new Error(`Isolated test server failed to start on ${BASE}. Logs:\n${logs}`);
}

async function runTests() {
  console.log('=== 1. VERIFIED QURAN TEXT CHECKSUMS & MIGRATION SQL SAFETY ===');
  assert.strictEqual(QURAN_SURAHS.length, 9, 'Expected 9 curated Short Surahs');
  for (const surah of QURAN_SURAHS) {
    assert.strictEqual(surah.ayahs.length, surah.ayahCount, `${surah.id} ayah count mismatch`);
    const actualSha = crypto
      .createHash('sha256')
      .update(surah.ayahs.map((a) => a.textUthmani).join('\n'), 'utf8')
      .digest('hex');
    assert.strictEqual(actualSha, surah.textSha256, `SHA-256 mismatch for ${surah.id}`);
    assert.strictEqual(surah.textVerificationStatus, 'verified', `${surah.id} text must be verified`);
  }
  for (const reciter of QURAN_RECITERS) {
    assert.strictEqual(
      reciter.verificationStatus,
      'pending_verification',
      `Default reciter ${reciter.id} must honestly remain pending_verification without fabricated licensing`,
    );
  }
  for (const story of QURAN_STORIES) {
    assert.strictEqual(story.prohibitsProphetDepiction, true, `${story.id} must enforce prohibitsProphetDepiction`);
  }

  const migrationSql = fs.readFileSync(path.resolve(process.cwd(), 'drizzle/0002_quran_world.sql'), 'utf-8');
  for (const tbl of [
    'quran_child_settings',
    'quran_surah_progress',
    'quran_story_progress',
    'quran_manners_progress',
    'quran_activity_events',
    'quran_content_verifications',
  ]) {
    assert.ok(migrationSql.includes(`CREATE TABLE IF NOT EXISTS "${tbl}"`), `Missing table ${tbl} in 0002 SQL`);
  }
  const migrationSqlStatements = migrationSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  assert.ok(!/\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|ALTER\s+TABLE)\b/i.test(migrationSqlStatements), '0002 SQL must be strictly additive');
  console.log('PASS: Uthmani SHA-256 digests, honest audio provenance, and additive migration SQL verified.');

  const { proc, adminSecret } = await startIsolatedInMemoryServer();
  try {
    console.log('=== 2. ISOLATED IN-MEMORY SERVER CONFIRMED (/api/health === in-memory-dev) ===');
    const ts = Date.now();
    const pw = 'QuranSafe!2026Test';

    // Unauthenticated rejected
    const anonCat = await new TestClient().req('GET', '/api/quran/catalog');
    assert.strictEqual(anonCat.status, 401, 'Unauthenticated catalog access must fail 401');

    // Register Parent A & Child A
    const parentA = new TestClient();
    const regA = await parentA.req('POST', '/api/auth/register', {
      displayName: 'أم زيد',
      email: `parent.a.${ts}@example.com`,
      password: pw,
      termsAccepted: true,
    });
    assert.strictEqual(regA.status, 201);
    const childARes = await parentA.req('POST', '/api/children', {
      displayName: 'زيد الصغير',
      ageGroup: '1-4',
      language: 'ar',
      birthYear: 2023,
      birthMonth: 5,
    });
    assert.strictEqual(childARes.status, 201);
    const childA = childARes.data.child as { id: string; familyId: string };

    // Set Parent Gate PIN + Child quick login credentials
    const setPin = await parentA.req('POST', '/api/parent/gate/pin', {
      currentPassword: pw,
      newPin: '4829',
    });
    assert.strictEqual(setPin.status, 200);
    const credA = await parentA.req('POST', `/api/family/children/${childA.id}/credentials`, { pin: '1357' });
    assert.strictEqual(credA.status, 201);
    const accessCodeA = credA.data.accessCode as string;

    // Register Parent B & Teacher + Bootstrap Super Admin to approve Teacher
    const parentB = new TestClient();
    const regB = await parentB.req('POST', '/api/auth/register', {
      displayName: 'Parent B',
      email: `parent.b.${ts}@example.com`,
      password: pw,
      termsAccepted: true,
    });
    assert.strictEqual(regB.status, 201);

    const adminClient = new TestClient();
    const adminPw = 'QuranSuperAdmin!2026Strong';
    const bootstrapRes = await adminClient.req('POST', '/api/auth/admin-bootstrap', {
      setupSecret: adminSecret,
      displayName: 'Super Admin',
      email: `superadmin.quran.${ts}@example.com`,
      password: adminPw,
      confirmPassword: adminPw,
    });
    assert.strictEqual(bootstrapRes.status, 201, `Bootstrap super admin must succeed: ${JSON.stringify(bootstrapRes.data)}`);

    const teacherClient = new TestClient();
    const teacherEmail = `teacher.quran.${ts}@example.com`;
    const regTeacher = await teacherClient.req('POST', '/api/auth/register-teacher', {
      displayName: 'Teacher Sara',
      email: teacherEmail,
      password: pw,
      confirmPassword: pw,
      phone: '+201001234567',
      subjects: ['arabic'],
      termsAccepted: true,
    });
    assert.strictEqual(regTeacher.status, 201);
    const teacherId = (regTeacher.data.user as { id: string }).id;
    assert.strictEqual(
      (await adminClient.req('PATCH', `/api/admin/teachers/${teacherId}`, { status: 'active' })).status,
      200,
    );
    assert.strictEqual(
      (await teacherClient.req('POST', '/api/auth/login', { email: teacherEmail, password: pw })).status,
      200,
    );

    // Log in Child A via Child Login
    const childClient = new TestClient();
    const childLogin = await childClient.req('POST', '/api/auth/child-login', {
      accessCode: accessCodeA,
      pin: '1357',
    });
    assert.strictEqual(childLogin.status, 200, 'Child A login must succeed');

    console.log('=== 3. CSRF, IDOR, TEACHER ISOLATION & CHILD BOUNDARIES ===');
    // Missing CSRF rejected
    const badCsrf = await childClient.req(
      'POST',
      `/api/children/${childA.id}/quran/listen`,
      { surahId: 'surah-112', mode: 'listen', durationSeconds: 20 },
      { 'x-csrf-token': 'invalid-csrf' },
    );
    assert.strictEqual(badCsrf.status, 403, 'Invalid CSRF token must be rejected 403');

    // IDOR: Parent B & Teacher cannot read or touch Child A Quran data
    assert.strictEqual((await parentB.req('GET', `/api/children/${childA.id}/quran`)).status, 403);
    assert.strictEqual(
      (await parentB.req('POST', `/api/children/${childA.id}/quran/listen`, { surahId: 'surah-112' })).status,
      403,
    );
    assert.strictEqual((await teacherClient.req('GET', `/api/children/${childA.id}/quran`)).status, 403);
    assert.strictEqual(
      (
        await teacherClient.req('POST', `/api/children/${childA.id}/quran/memorization-confirm`, {
          surahId: 'surah-112',
          confirmed: true,
        })
      ).status,
      403,
    );

    // Child CANNOT modify parent settings or confirm memorization
    assert.strictEqual(
      (await childClient.req('PUT', `/api/children/${childA.id}/quran/settings`, { enabled: false })).status,
      403,
    );
    assert.strictEqual(
      (
        await childClient.req('POST', `/api/children/${childA.id}/quran/memorization-confirm`, {
          surahId: 'surah-112',
          confirmed: true,
        })
      ).status,
      403,
    );

    console.log('=== 4. MEMORIZATION INTEGRITY & PARENT GATE ENFORCEMENT ===');
    // Child listens & repeats 4 times covering all 4 ayahs of Al-Ikhlas
    for (let i = 0; i < 3; i += 1) {
      const l = await childClient.req('POST', `/api/children/${childA.id}/quran/listen`, {
        surahId: 'surah-112',
        mode: i === 0 ? 'listen' : 'repeat',
        ayahNumbers: [1, 2, 3, 4],
        durationSeconds: 30,
        // Malicious spoof attempt inside body:
        parentConfirmedMemorization: true,
        status: 'parent_confirmed',
      });
      assert.strictEqual(l.status, 200);
    }
    const afterListen = await childClient.req('GET', `/api/children/${childA.id}/quran`);
    assert.strictEqual(afterListen.status, 200);
    const ikhlasProg = (afterListen.data.surahProgress as Array<Record<string, unknown>>).find(
      (p) => p.surahId === 'surah-112',
    );
    assert.ok(ikhlasProg);
    assert.strictEqual(ikhlasProg.status, 'familiar', 'Listening/repeat must cap at familiar, never parent_confirmed');
    assert.strictEqual(ikhlasProg.parentConfirmedMemorization, false, 'Listening must never auto-confirm memorization');

    // Story & Islamic manner engagement + Garden milestones
    assert.strictEqual(
      (await childClient.req('POST', `/api/children/${childA.id}/quran/story`, { storyId: 'qstory-elephant' })).status,
      200,
    );
    assert.strictEqual(
      (await childClient.req('POST', `/api/children/${childA.id}/quran/manner`, { mannerId: 'manner-bismillah' })).status,
      200,
    );

    // Parent WITHOUT active Parent Gate (fresh login) is blocked 403 PARENT_GATE_REQUIRED
    const parentAFresh = new TestClient();
    await parentAFresh.req('POST', '/api/auth/login', { email: `parent.a.${ts}@example.com`, password: pw });
    const gatedAttempt = await parentAFresh.req('POST', `/api/children/${childA.id}/quran/memorization-confirm`, {
      surahId: 'surah-112',
      confirmed: true,
    });
    assert.strictEqual(gatedAttempt.status, 403);
    assert.strictEqual(gatedAttempt.data.code, 'PARENT_GATE_REQUIRED');

    // Unlock Parent Gate -> confirm memorization with XSS note sanitization check
    assert.strictEqual((await parentAFresh.req('POST', '/api/parent/gate/verify', { pin: '4829' })).status, 200);
    const confirmRes = await parentAFresh.req('POST', `/api/children/${childA.id}/quran/memorization-confirm`, {
      surahId: 'surah-112',
      confirmed: true,
      parentNote: '<script>alert(1)</script> تلاوة جميلة مع ماما',
    });
    assert.strictEqual(confirmRes.status, 200);
    const confirmedProg = confirmRes.data.progress as Record<string, unknown>;
    assert.strictEqual(confirmedProg.parentConfirmedMemorization, true);
    assert.strictEqual(confirmedProg.status, 'parent_confirmed');
    assert.ok(!String(confirmedProg.parentNote).includes('<script>'), 'XSS angle brackets must be stripped');

    // Revoke confirmation -> returns cleanly to natural status
    const unconfirmRes = await parentAFresh.req('POST', `/api/children/${childA.id}/quran/memorization-confirm`, {
      surahId: 'surah-112',
      confirmed: false,
    });
    assert.strictEqual(unconfirmRes.status, 200);
    assert.strictEqual((unconfirmRes.data.progress as Record<string, unknown>).status, 'familiar');
    assert.strictEqual((unconfirmRes.data.progress as Record<string, unknown>).parentConfirmedMemorization, false);

    console.log('=== 5. PARENT CONTROLS, SURAH ALLOWLIST, DAILY LIMIT & EXPORT ===');
    const settingsRes = await parentAFresh.req('PUT', `/api/children/${childA.id}/quran/settings`, {
      enabled: true,
      allowedSurahIds: ['surah-1', 'surah-112'],
      repeatCount: 3,
      dailyMaxMinutes: 5,
    });
    assert.strictEqual(settingsRes.status, 200);

    // Disallowed Surah rejected
    const blockedSurah = await childClient.req('POST', `/api/children/${childA.id}/quran/listen`, {
      surahId: 'surah-106',
      mode: 'listen',
      durationSeconds: 30,
    });
    assert.strictEqual(blockedSurah.status, 403);
    assert.strictEqual(blockedSurah.data.code, 'SURAH_NOT_ALLOWED_FOR_CHILD');

    // Exceed 5-minute daily cap (already 90s used -> +240s = 330s = 5.5m)
    assert.strictEqual(
      (await childClient.req('POST', `/api/children/${childA.id}/quran/listen`, {
        surahId: 'surah-1',
        mode: 'listen',
        durationSeconds: 240,
      })).status,
      200,
    );
    const overLimit = await childClient.req('POST', `/api/children/${childA.id}/quran/listen`, {
      surahId: 'surah-1',
      mode: 'listen',
      durationSeconds: 30,
    });
    assert.strictEqual(overLimit.status, 429);
    assert.strictEqual(overLimit.data.code, 'QURAN_DAILY_LIMIT_REACHED');

    // Family privacy export includes Quran data
    const exportRes = await parentAFresh.req('POST', '/api/family/privacy/export', {});
    assert.strictEqual(exportRes.status, 200);
    const exportedChildren = ((exportRes.data.exportPackage as Record<string, unknown>).children || []) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(exportedChildren[0].quranSurahProgress), 'Export must include quranSurahProgress');

    console.log('=== 6. ADMIN RBAC & VERIFICATION PROVENANCE + ADULT FALLBACK ===');
    assert.strictEqual((await parentAFresh.req('GET', '/api/admin/quran/verifications')).status, 403);
    assert.strictEqual((await childClient.req('GET', '/api/admin/quran/verifications')).status, 403);
    assert.strictEqual((await teacherClient.req('GET', '/api/admin/quran/verifications')).status, 403);
    assert.strictEqual((await adminClient.req('GET', '/api/admin/quran/verifications')).status, 200);

    // Unsafe javascript: URL rejected
    const unsafeUrlRes = await adminClient.req('PUT', '/api/admin/quran/verifications/adult-husary-muallim', {
      verificationStatus: 'verified',
      sourceName: 'Test Source',
      licenseOrPermission: 'Documented CC0',
      tajweedReviewedBy: 'Certified Hafiz Reviewer',
      audioUrlsJson: { 'surah-112': 'javascript:alert(1)' },
    });
    assert.strictEqual(unsafeUrlRes.status, 400);

    // Valid HTTPS verification metadata accepted & enables child->adult fallback resolution
    const okVerifyRes = await adminClient.req('PUT', '/api/admin/quran/verifications/adult-husary-muallim', {
      verificationStatus: 'verified',
      sourceName: 'Authorized Quran Audio Archive',
      licenseOrPermission: 'Verified Open Recitation Permission #QA-2026',
      tajweedReviewedBy: 'Sheikh Ahmad (Ijazah Reviewer)',
      tajweedReviewedAt: '2026-11-20',
      audioUrlsJson: { 'surah-112': 'https://example.org/verified-audio/husary/112.mp3' },
    });
    assert.strictEqual(okVerifyRes.status, 200);

    // Set Child A preference to child reciter (pending) -> summary resolves active adult fallback automatically
    assert.strictEqual(
      (
        await parentAFresh.req('PUT', `/api/children/${childA.id}/quran/settings`, {
          preferredReciterId: 'child-reciter-approved',
          preferChildReciterFallback: true,
        })
      ).status,
      200,
    );
    const fallbackSummary = await childClient.req('GET', `/api/children/${childA.id}/quran`);
    assert.strictEqual(fallbackSummary.status, 200);
    const playbackRes = fallbackSummary.data.playbackResolution as {
      audioAvailable: boolean;
      usedAdultFallback: boolean;
      activeReciter: { id: string } | null;
    };
    assert.strictEqual(playbackRes.audioAvailable, true);
    assert.strictEqual(playbackRes.usedAdultFallback, true);
    assert.strictEqual(playbackRes.activeReciter?.id, 'adult-husary-muallim');

    console.log('ALL QURAN WORLD STAGE 1 BACKEND, SECURITY & PROVENANCE TESTS PASSED (in-memory-dev)!');
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
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
