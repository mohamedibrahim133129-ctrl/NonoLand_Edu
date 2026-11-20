import assert from 'node:assert';
import crypto from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { getPgConnectionDiagnostics, pool, resetPoolForResolvedSecrets } from '../src/db/index.ts';
import {
  getNonSensitiveDbSettings,
  getSecret,
  initializeSecretProvider,
  resetSecretProviderForTesting,
} from '../server/secretProvider.ts';

class E2ECookieClient {
  private cookies = new Map<string, string>();
  public csrfToken: string | null = null;

  constructor(private readonly baseUrl: string) {}

  private storeCookies(res: Response) {
    const hdrs = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof hdrs.getSetCookie === 'function' ? hdrs.getSetCookie() : [];
    const fallback = res.headers.get('set-cookie');
    const all = setCookies.length > 0 ? setCookies : fallback ? [fallback] : [];
    for (const raw of all) {
      const [nv] = raw.split(';');
      const idx = nv.indexOf('=');
      if (idx > 0) {
        const name = nv.slice(0, idx).trim();
        const val = nv.slice(idx + 1).trim();
        if (!val || /Max-Age=0/i.test(raw)) {
          this.cookies.delete(name);
        } else {
          this.cookies.set(name, val);
        }
      }
    }
  }

  async req<T = Record<string, unknown>>(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {};
    const cookieStr = Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieStr) headers['cookie'] = cookieStr;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && this.csrfToken) {
      headers['x-csrf-token'] = this.csrfToken;
    }

    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.storeCookies(res);
    const data = (await res.json().catch(() => ({}))) as T & { csrfToken?: string };
    if (data && typeof data === 'object' && typeof data.csrfToken === 'string') {
      this.csrfToken = data.csrfToken;
    }
    return { status: res.status, data };
  }
}

async function waitForHttpReady(url: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url);
      if (r.status > 0) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function killServer(proc: ChildProcess) {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    proc.kill('SIGTERM');
  }
}

function clearAllDbEnvVars() {
  delete process.env.NONOLAND_DB_HOST;
  delete process.env.NONOLAND_DB_DIRECT_HOST;
  delete process.env.NONOLAND_DB_NAME;
  delete process.env.NONOLAND_DB_USER;
  delete process.env.NONOLAND_DB_PASSWORD;
  delete process.env.SQL_HOST;
  delete process.env.SQL_DIRECT_HOST;
  delete process.env.SQL_DB_NAME;
  delete process.env.SQL_USER;
  delete process.env.SQL_PASSWORD;
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_DATABASE_URL;
  delete process.env.SQL_SSL;
  delete process.env.SQL_SSL_REJECT_UNAUTHORIZED;
}

async function testDiagnosticsConfig() {
  const savedEnv = { ...process.env };
  try {
    clearAllDbEnvVars();

    const emptyDiag = getPgConnectionDiagnostics();
    assert.strictEqual(emptyDiag.configured, false);
    assert.strictEqual(emptyDiag.configComplete, false);
    assert.strictEqual(emptyDiag.source, 'none');
    assert.strictEqual(emptyDiag.configSource, 'none');
    assert.strictEqual(emptyDiag.databaseName, null);
    assert.deepStrictEqual(emptyDiag.missingEnvVars, ['SQL_HOST', 'SQL_DB_NAME', 'SQL_USER', 'SQL_PASSWORD']);

    // 1. NONOLAND_DB_* wins over SQL_* and DATABASE_URL when both groups are present
    process.env.NONOLAND_DB_HOST = 'ep-nonoland-prod-pooler.eu-central-1.aws.neon.tech';
    process.env.NONOLAND_DB_DIRECT_HOST = 'ep-nonoland-prod.eu-central-1.aws.neon.tech';
    process.env.NONOLAND_DB_NAME = 'neondb';
    process.env.NONOLAND_DB_USER = 'nonoland_owner';
    process.env.NONOLAND_DB_PASSWORD = 'nonoland_secret_password';
    process.env.SQL_HOST = 'ep-other-sql.us-east-2.aws.neon.tech';
    process.env.SQL_DIRECT_HOST = 'ep-other-sql-direct.us-east-2.aws.neon.tech';
    process.env.SQL_DB_NAME = 'wrong_sql_db';
    process.env.SQL_USER = 'wrong_sql_user';
    process.env.SQL_PASSWORD = 'wrong_sql_password';
    process.env.DATABASE_URL = 'postgresql://url_user:url_pass@ep-url-host.aws.neon.tech:5432/wrong_url_db?sslmode=require';

    resetPoolForResolvedSecrets();
    const nonolandWinsDiag = getPgConnectionDiagnostics();
    assert.strictEqual(nonolandWinsDiag.configured, true);
    assert.strictEqual(nonolandWinsDiag.configComplete, true);
    assert.strictEqual(nonolandWinsDiag.source, 'sql_vars');
    assert.strictEqual(nonolandWinsDiag.configSource, 'NONOLAND_DB_*');
    assert.strictEqual(nonolandWinsDiag.databaseName, 'neondb');
    assert.strictEqual(nonolandWinsDiag.sslEnabled, true);
    assert.strictEqual(nonolandWinsDiag.isNeonHost, true);
    assert.strictEqual(nonolandWinsDiag.isPooledEndpoint, true);
    assert.strictEqual(nonolandWinsDiag.hasDirectMigrationHost, true);

    const activePoolOpts = (pool as unknown as { options?: { host?: string; database?: string; user?: string; password?: string; ssl?: unknown } }).options;
    assert.strictEqual(activePoolOpts?.host, 'ep-nonoland-prod-pooler.eu-central-1.aws.neon.tech');
    assert.strictEqual(activePoolOpts?.database, 'neondb');
    assert.strictEqual(activePoolOpts?.user, 'nonoland_owner');
    assert.strictEqual(activePoolOpts?.password, 'nonoland_secret_password');
    assert.deepStrictEqual(activePoolOpts?.ssl, { rejectUnauthorized: true });

    // 2. SQL_* works when NONOLAND_DB_* is absent
    clearAllDbEnvVars();
    process.env.SQL_HOST = 'ep-example-12345-pooler.us-east-2.aws.neon.tech';
    process.env.SQL_DB_NAME = 'sql_explicit_db';
    process.env.SQL_USER = 'neondb_owner';
    process.env.SQL_PASSWORD = 'placeholder_password';
    process.env.DATABASE_URL = 'postgresql://url_user:url_pass@ep-url-host.aws.neon.tech:5432/ignored_url_db?sslmode=require';

    resetPoolForResolvedSecrets();
    const sqlDiag = getPgConnectionDiagnostics();
    assert.strictEqual(sqlDiag.configured, true);
    assert.strictEqual(sqlDiag.configComplete, true);
    assert.strictEqual(sqlDiag.source, 'sql_vars');
    assert.strictEqual(sqlDiag.configSource, 'SQL_*');
    assert.strictEqual(sqlDiag.databaseName, 'sql_explicit_db');
    assert.strictEqual(sqlDiag.sslEnabled, true);
    assert.strictEqual(sqlDiag.isNeonHost, true);
    assert.strictEqual(sqlDiag.isPooledEndpoint, true);

    const sqlPoolOpts = (pool as unknown as { options?: { host?: string; database?: string; user?: string; password?: string; ssl?: unknown } }).options;
    assert.strictEqual(sqlPoolOpts?.host, 'ep-example-12345-pooler.us-east-2.aws.neon.tech');
    assert.strictEqual(sqlPoolOpts?.database, 'sql_explicit_db');
    assert.strictEqual(sqlPoolOpts?.user, 'neondb_owner');
    assert.deepStrictEqual(sqlPoolOpts?.ssl, { rejectUnauthorized: true });

    // 3. DATABASE_URL fallback works when neither individual group provides a complete valid configuration
    clearAllDbEnvVars();
    process.env.SQL_DB_NAME = 'incomplete_group_only';
    process.env.DATABASE_URL = 'postgresql://url_user:url_pass@ep-example-pooler.aws.neon.tech:5432/url_neondb?sslmode=require';
    resetPoolForResolvedSecrets();
    const urlDiag = getPgConnectionDiagnostics();
    assert.strictEqual(urlDiag.configured, true);
    assert.strictEqual(urlDiag.configComplete, true);
    assert.strictEqual(urlDiag.source, 'database_url');
    assert.strictEqual(urlDiag.configSource, 'DATABASE_URL');
    assert.strictEqual(urlDiag.databaseName, 'url_neondb');
    assert.strictEqual(urlDiag.sslEnabled, true);
    assert.strictEqual(urlDiag.isNeonHost, true);
    assert.strictEqual(urlDiag.isPooledEndpoint, true);

    const urlPoolOpts = (pool as unknown as { options?: { host?: string; database?: string; user?: string; ssl?: unknown } }).options;
    assert.strictEqual(urlPoolOpts?.host, 'ep-example-pooler.aws.neon.tech');
    assert.strictEqual(urlPoolOpts?.database, 'url_neondb');
    assert.strictEqual(urlPoolOpts?.user, 'url_user');
    assert.deepStrictEqual(urlPoolOpts?.ssl, { rejectUnauthorized: true });

    // 4. Default database is neondb only when no explicit database name exists
    clearAllDbEnvVars();
    process.env.NONOLAND_DB_HOST = 'ep-example-pooler.eu-central-1.aws.neon.tech';
    process.env.NONOLAND_DB_USER = 'neondb_owner';
    process.env.NONOLAND_DB_PASSWORD = 'placeholder_password';
    resetPoolForResolvedSecrets();
    const defaultedDiag = getPgConnectionDiagnostics();
    assert.strictEqual(defaultedDiag.configured, true);
    assert.strictEqual(defaultedDiag.configComplete, true);
    assert.strictEqual(defaultedDiag.configSource, 'NONOLAND_DB_*');
    assert.strictEqual(defaultedDiag.databaseName, 'neondb');
    assert.strictEqual(defaultedDiag.sslEnabled, true);
    const dbDefaults = getNonSensitiveDbSettings();
    assert.strictEqual(dbDefaults.SQL_DB_NAME, 'neondb');
    assert.strictEqual(dbDefaults.SQL_PORT, 5432);
    assert.strictEqual(dbDefaults.SQL_SSL, true);

    process.env.NONOLAND_DB_NAME = 'explicit_custom_db';
    const explicitDiag = getPgConnectionDiagnostics();
    assert.strictEqual(explicitDiag.databaseName, 'explicit_custom_db');
    assert.strictEqual(getNonSensitiveDbSettings().SQL_DB_NAME, 'explicit_custom_db');

    // SecretProvider Priority 1 (process.env) -> fail closed when Secret Manager disabled/unavailable
    clearAllDbEnvVars();
    process.env.SQL_HOST = 'ep-example-pooler.us-east-2.aws.neon.tech';
    process.env.SQL_USER = 'neondb_owner';
    process.env.SQL_PASSWORD = 'placeholder_password';
    resetSecretProviderForTesting();
    process.env.DISABLE_SECRET_MANAGER = 'true';
    delete process.env.NONOLAND_SESSION_SECRET;
    process.env.SESSION_SECRET = 'test_legacy_session_secret_value';
    delete process.env.NONOLAND_ADMIN_SETUP_SECRET;
    const legacySnap = await initializeSecretProvider();
    assert.strictEqual(legacySnap.secretSource, 'environment');
    assert.strictEqual(getSecret('SQL_USER'), 'neondb_owner');
    assert.strictEqual(getSecret('NONOLAND_SESSION_SECRET'), 'test_legacy_session_secret_value');
    assert.ok(legacySnap.presentRequired.includes('SQL_HOST'));
    assert.ok(legacySnap.presentRequired.includes('SQL_USER'));
    assert.ok(legacySnap.presentRequired.includes('SQL_PASSWORD'));
    assert.ok(legacySnap.presentRequired.includes('NONOLAND_SESSION_SECRET'));
    assert.deepStrictEqual(legacySnap.missingRequired, ['NONOLAND_ADMIN_SETUP_SECRET']);
    assert.ok(legacySnap.configurationError && legacySnap.configurationError.includes('NONOLAND_ADMIN_SETUP_SECRET'));

    // Preferred NONOLAND_SESSION_SECRET takes precedence over legacy SESSION_SECRET
    resetSecretProviderForTesting();
    process.env.NONOLAND_SESSION_SECRET = 'test_nonoland_session_secret_value';
    const spSnap = await initializeSecretProvider();
    assert.strictEqual(getSecret('NONOLAND_SESSION_SECRET'), 'test_nonoland_session_secret_value');
    assert.ok(spSnap.presentRequired.includes('NONOLAND_SESSION_SECRET'));
    assert.deepStrictEqual(spSnap.missingRequired, ['NONOLAND_ADMIN_SETUP_SECRET']);

    console.log('✓ Test 1 passed: NONOLAND_DB_* > SQL_* > DATABASE_URL precedence, Neon TLS, defaults & SecretProvider');
  } finally {
    process.env = savedEnv;
    resetSecretProviderForTesting();
    resetPoolForResolvedSecrets();
  }
}

async function testProductionFailClosed() {
  const port = 3201;
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverProc = spawn('npx', ['tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
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
      SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  try {
    await waitForHttpReady(`${baseUrl}/api/health`);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 503);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.strictEqual(healthJson.database, 'unavailable');
    assert.strictEqual(healthJson.code, 'DB_UNAVAILABLE');
    assert.strictEqual(healthJson.reason, 'missing_env_vars');
    assert.strictEqual(healthJson.configSource, 'none');
    assert.strictEqual(healthJson.configComplete, false);
    assert.strictEqual(healthJson.databaseName, null);
    assert.strictEqual(healthJson.isNeonHost, false);
    assert.strictEqual(healthJson.isPooledEndpoint, false);
    assert.ok(Array.isArray(healthJson.missingEnvVars));

    const childLoginRes = await fetch(`${baseUrl}/api/auth/child-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessCode: 'NONO1234', pin: '1234' }),
    });
    assert.strictEqual(childLoginRes.status, 503);
    const childJson = (await childLoginRes.json()) as Record<string, unknown>;
    assert.strictEqual(childJson.code, 'DB_UNAVAILABLE');
    assert.strictEqual(childJson.error, 'Database unavailable. Failing closed for data safety.');
    assert.strictEqual(childJson.reason, 'missing_env_vars');
    assert.ok(Array.isArray(childJson.missingEnvVars));

    const parentRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Test Parent',
        email: 'parent.failclosed@example.com',
        password: 'StrongPassword!2026',
        termsAccepted: true,
      }),
    });
    assert.strictEqual(parentRegRes.status, 503);
    const regJson = (await parentRegRes.json()) as Record<string, unknown>;
    assert.strictEqual(regJson.code, 'DB_UNAVAILABLE');
    assert.strictEqual(regJson.reason, 'missing_env_vars');

    // Public/unauthenticated access to /api/admin/diagnostics MUST be rejected with 401 even when DB is down
    const unauthDiagRes = await fetch(`${baseUrl}/api/admin/diagnostics`);
    assert.strictEqual(unauthDiagRes.status, 401);

    console.log('✓ Test 2 passed: Production mode fails closed with 503 DB_UNAVAILABLE & protects admin diagnostics');
  } finally {
    killServer(serverProc);
  }

  // Verify /api/health safe metadata & zero secret leakage when NONOLAND_DB_* overrides SQL_* on unreachable local port
  const portDiag = 3203;
  const baseUrlDiag = `http://127.0.0.1:${portDiag}`;
  const sentinelSessionSecret = 'sentinel_session_secret_never_leak_999';
  const sentinelAdminSecret = 'sentinel_admin_secret_never_leak_888';
  const sentinelPassword = 'sentinel_db_password_never_leak_777';
  const sentinelUser = 'sentinel_db_user_never_leak_666';
  const diagProc = spawn('npx', ['tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(portDiag),
      NODE_ENV: 'production',
      DISABLE_SECRET_MANAGER: 'true',
      NONOLAND_DB_HOST: '127.0.0.1',
      NONOLAND_DB_NAME: 'neondb',
      NONOLAND_DB_USER: sentinelUser,
      NONOLAND_DB_PASSWORD: sentinelPassword,
      SQL_HOST: 'wrong_sql_host.invalid',
      SQL_DB_NAME: 'wrong_sql_db',
      SQL_USER: 'wrong_sql_user',
      SQL_PASSWORD: 'wrong_sql_password',
      SQL_PORT: '59999',
      NONOLAND_SESSION_SECRET: sentinelSessionSecret,
      NONOLAND_ADMIN_SETUP_SECRET: sentinelAdminSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  try {
    await waitForHttpReady(`${baseUrlDiag}/api/health`);
    const res = await fetch(`${baseUrlDiag}/api/health`);
    assert.strictEqual(res.status, 503);
    const bodyText = await res.text();
    const json = JSON.parse(bodyText) as Record<string, unknown>;
    assert.strictEqual(json.database, 'unavailable');
    assert.strictEqual(json.code, 'DB_UNAVAILABLE');
    assert.strictEqual(json.databaseName, 'neondb');
    assert.strictEqual(json.configSource, 'NONOLAND_DB_*');
    assert.strictEqual(json.configComplete, true);
    assert.strictEqual(json.isNeonHost, false);
    assert.strictEqual(json.isPooledEndpoint, false);
    assert.strictEqual(json.sslEnabled, true);
    assert.strictEqual(json.schemaReady, false);
    for (const forbidden of [
      '127.0.0.1',
      'wrong_sql_host',
      'wrong_sql_db',
      'wrong_sql_user',
      'wrong_sql_password',
      sentinelUser,
      sentinelPassword,
      sentinelSessionSecret,
      sentinelAdminSecret,
      'postgresql://',
      'postgres://',
    ]) {
      assert.ok(!bodyText.includes(forbidden), `/api/health must never leak sensitive detail: ${forbidden}`);
    }
    console.log('✓ Test 2b passed: /api/health reports safe metadata and leaks zero secrets or connection details');
  } finally {
    killServer(diagProc);
  }
}

async function testDevSeedSeparationAndSuperAdmin() {
  const port = 3202;
  const baseUrl = `http://127.0.0.1:${port}`;
  const setupSecret = 'NonolandSetupTestSecret_987654';
  const serverProc = spawn('npx', ['tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
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
      REQUIRE_POSTGRES: '',
      NONOLAND_ADMIN_SETUP_SECRET: setupSecret,
      SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  try {
    await waitForHttpReady(`${baseUrl}/api/health`);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.strictEqual(healthJson.database, 'in-memory-dev');
    assert.strictEqual(healthJson.databaseName, null);
    assert.strictEqual(healthJson.configSource, 'none');
    assert.strictEqual(healthJson.configComplete, false);
    assert.strictEqual(healthJson.isNeonHost, false);
    assert.strictEqual(healthJson.isPooledEndpoint, false);

    const super1 = new E2ECookieClient(baseUrl);
    const super1Pw = 'SuperAdmin#2026!A';
    const super1Email = 'super1.verify@nonoland-test.org';
    const bootRes = await super1.req('POST', '/api/auth/admin-bootstrap', {
      displayName: 'Primary Super Admin',
      email: super1Email,
      password: super1Pw,
      confirmPassword: super1Pw,
      setupSecret,
    });
    assert.strictEqual(bootRes.status, 201);

    // Check overview stats separate JSON seed data from real registered records
    const ov1 = await super1.req<{
      stats: Record<string, number>;
      storageBackend: string;
      devSeedEnabled: boolean;
      seedStats: Record<string, number> | null;
    }>('GET', '/api/admin/overview-stats');
    assert.strictEqual(ov1.status, 200);
    assert.strictEqual(ov1.data.storageBackend, 'in-memory-dev');
    assert.strictEqual(ov1.data.devSeedEnabled, true);
    assert.ok(ov1.data.seedStats && ov1.data.seedStats.totalParents > 0, 'Seed stats should reflect JSON seed baseline');
    assert.strictEqual(ov1.data.stats.totalParents, 0, 'Real parent count must start at 0 (excluding dev seeds)');
    assert.strictEqual(ov1.data.stats.totalChildren, 0, 'Real children count must start at 0 (excluding dev seeds)');
    assert.strictEqual(ov1.data.stats.totalTeachers, 0, 'Real teachers count must start at 0 (excluding dev seeds)');
    assert.strictEqual(ov1.data.stats.totalClasses, 0, 'Real classes count must start at 0 (excluding dev seeds)');
    assert.strictEqual(ov1.data.stats.totalExams, 0, 'Real exams count must start at 0 (excluding dev seeds)');

    // Register a real parent and child profile -> real stats increment strictly by 1
    const parentClient = new E2ECookieClient(baseUrl);
    const parentReg = await parentClient.req<{ user: { id: string } }>('POST', '/api/auth/register', {
      displayName: 'Real Parent User',
      email: 'realparent.verify@nonoland-test.org',
      password: 'ParentUser!2026#1',
      termsAccepted: true,
    });
    assert.strictEqual(parentReg.status, 201);

    const childRes = await parentClient.req('POST', '/api/children', {
      displayName: 'Nono Real Child',
      ageGroup: '1-4',
      birthYear: new Date().getFullYear() - 3,
      birthMonth: 3,
      language: 'ar',
      interests: ['reading'],
      pin: '4829',
    });
    assert.strictEqual(childRes.status, 201);

    const ov2 = await super1.req<{ stats: Record<string, number> }>('GET', '/api/admin/overview-stats');
    assert.strictEqual(ov2.data.stats.totalParents, 1);
    assert.strictEqual(ov2.data.stats.totalChildren, 1);

    // Non-super-admin cannot create admins
    assert.strictEqual(
      (
        await parentClient.req('POST', '/api/admin/admins', {
          displayName: 'Hack SA',
          email: 'hack@nonoland-test.org',
          password: 'SuperAdmin#2026!B',
          confirmPassword: 'SuperAdmin#2026!B',
          creatorCurrentPassword: 'ParentUser!2026#1',
          role: 'super_admin',
        })
      ).status,
      403,
    );

    // Super Admin validation rules for creating another Super Admin
    const sa2Email = 'super2.verify@nonoland-test.org';
    const sa2Pw = 'SuperAdmin#2026!B';

    assert.strictEqual(
      (
        await super1.req('POST', '/api/admin/admins', {
          displayName: 'Second SA',
          email: sa2Email,
          password: sa2Pw,
          confirmPassword: sa2Pw,
          role: 'super_admin',
        })
      ).status,
      400,
    );

    assert.strictEqual(
      (
        await super1.req('POST', '/api/admin/admins', {
          displayName: 'Second SA',
          email: sa2Email,
          password: sa2Pw,
          confirmPassword: sa2Pw,
          creatorCurrentPassword: 'WrongCurrentPassword!99',
          role: 'super_admin',
        })
      ).status,
      403,
    );

    assert.strictEqual(
      (
        await super1.req('POST', '/api/admin/admins', {
          displayName: 'Second SA',
          email: sa2Email,
          password: 'short',
          confirmPassword: 'short',
          creatorCurrentPassword: super1Pw,
          role: 'super_admin',
        })
      ).status,
      400,
    );

    assert.strictEqual(
      (
        await super1.req('POST', '/api/admin/admins', {
          displayName: 'Second SA',
          email: sa2Email,
          password: sa2Pw,
          confirmPassword: 'DifferentStrong#2026!',
          creatorCurrentPassword: super1Pw,
          role: 'super_admin',
        })
      ).status,
      400,
    );

    // Valid Super Admin creation
    const sa2Res = await super1.req<{ admin: { id: string; role: string; email: string } }>(
      'POST',
      '/api/admin/admins',
      {
        displayName: 'Second Super Admin',
        email: sa2Email,
        password: sa2Pw,
        confirmPassword: sa2Pw,
        creatorCurrentPassword: super1Pw,
        role: 'super_admin',
      },
    );
    assert.strictEqual(sa2Res.status, 201);
    assert.strictEqual(sa2Res.data.admin.role, 'super_admin');
    const serializedRes = JSON.stringify(sa2Res.data);
    assert.ok(!serializedRes.includes('passwordHash'));
    assert.ok(!serializedRes.includes(sa2Pw));

    // Duplicate email rejected with 409
    assert.strictEqual(
      (
        await super1.req('POST', '/api/admin/admins', {
          displayName: 'Duplicate SA',
          email: sa2Email,
          password: sa2Pw,
          confirmPassword: sa2Pw,
          creatorCurrentPassword: super1Pw,
          role: 'super_admin',
        })
      ).status,
      409,
    );

    // Second Super Admin can log in cleanly via admin portal
    const super2 = new E2ECookieClient(baseUrl);
    const sa2Login = await super2.req('POST', '/api/auth/login', {
      email: sa2Email,
      password: sa2Pw,
      portal: 'admin',
    });
    assert.strictEqual(sa2Login.status, 200);

    // Create subordinate admin and ensure subordinate admin CANNOT create Super Admin
    const subRes = await super1.req('POST', '/api/admin/admins', {
      displayName: 'Sub Ops Admin',
      email: 'sub.verify@nonoland-test.org',
      password: 'SubAdmin#2026!Op',
      role: 'admin',
    });
    assert.strictEqual(subRes.status, 201);
    const subClient = new E2ECookieClient(baseUrl);
    assert.strictEqual(
      (
        await subClient.req('POST', '/api/auth/login', {
          email: 'sub.verify@nonoland-test.org',
          password: 'SubAdmin#2026!Op',
          portal: 'admin',
        })
      ).status,
      200,
    );
    assert.strictEqual(
      (
        await subClient.req('POST', '/api/admin/admins', {
          displayName: 'Illegal SA',
          email: 'illegal.sa@nonoland-test.org',
          password: sa2Pw,
          confirmPassword: sa2Pw,
          creatorCurrentPassword: 'SubAdmin#2026!Op',
          role: 'super_admin',
        })
      ).status,
      403,
    );

    // Suspending second super_admin works when another active super_admin exists
    const suspendSa2 = await super1.req('PATCH', `/api/admin/admins/${sa2Res.data.admin.id}/status`, {
      status: 'suspended',
    });
    assert.strictEqual(suspendSa2.status, 200);

    // Self-suspension of remaining active super_admin is rejected
    const bootUserId = (bootRes.data as { user?: { id?: string } }).user?.id;
    if (bootUserId) {
      const selfSuspend = await super1.req('PATCH', `/api/admin/admins/${bootUserId}/status`, {
        status: 'suspended',
      });
      assert.ok(selfSuspend.status === 400 || selfSuspend.status === 403);
    }

    // Audit log recorded SUPER_ADMIN_CREATED
    const logsRes = await super1.req<{ logs: Array<{ actionType?: string; summary?: string }> }>(
      'GET',
      '/api/admin/audit-logs?limit=25',
    );
    assert.strictEqual(logsRes.status, 200);
    assert.ok(logsRes.data.logs.some((l) => l.actionType === 'SUPER_ADMIN_CREATED'));
    assert.ok(!JSON.stringify(logsRes.data).includes(sa2Pw));
    assert.ok(!JSON.stringify(logsRes.data).includes(super1Pw));

    // Admin Diagnostics RBAC:
    // - Unauthenticated -> 401
    assert.strictEqual((await fetch(`${baseUrl}/api/admin/diagnostics`)).status, 401);
    // - Non-admin parent -> 403
    assert.strictEqual((await parentClient.req('GET', '/api/admin/diagnostics')).status, 403);
    // - Authorized Super Admin -> 200 with safe non-secret metadata
    const diagRes = await super1.req<{
      secretSource: string;
      requiredVariables: { present: string[]; missing: string[] };
      database: { status: string };
      postgresError: { classification: string };
      schemaReady: boolean;
    }>('GET', '/api/admin/diagnostics');
    assert.strictEqual(diagRes.status, 200);
    assert.strictEqual(diagRes.data.database.status, 'in-memory-dev');
    assert.strictEqual(diagRes.data.postgresError.classification, 'none');
    assert.strictEqual(diagRes.data.schemaReady, true);
    assert.ok(!JSON.stringify(diagRes.data).includes(setupSecret), 'Must never leak setupSecret');

    console.log('✓ Test 3 passed: Dev seed separation, Super Admin RBAC, and protected /api/admin/diagnostics');
  } finally {
    killServer(serverProc);
  }
}

async function main() {
  await testDiagnosticsConfig();
  await testProductionFailClosed();
  await testDevSeedSeparationAndSuperAdmin();
  console.log('\nALL DB FAIL-CLOSED, DEV SEED AUDIT & SUPER ADMIN TESTS PASSED ✓');
}

main().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
