import { ProjectReportDetail, WeeklyReportContent } from '../../../types';
import {
  assertValidWeeklyTopHtml,
  parseStrictWeeklyTopHtml,
} from '../parsers/weekly-parser';
import {
  ExternalAuthError,
  ExternalNetworkError,
  ParsedWeeklyTopResult,
} from '../types';

export interface WeeklyPortalSession {
  pageHtml: string;
  cookieStr: string;
  finalUrl: string;
}

export interface FetchSubmittedDetailsTarget {
  staffId: number;
  staffName: string;
  wrTargetDateId: number;
  filingDatetime: string;
}

export interface FetchSubmittedDetailsResult {
  reports: Array<{
    report: WeeklyReportContent;
    filingDatetime: string;
    wrTargetDateId: number;
    externalReadRegistered: boolean;
  }>;
  failedStaffIds: Array<{
    staffId: number;
    staffName: string;
    reason: string;
  }>;
}

const DEFAULT_TIMEOUT_MS = 10000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Extracts and merges cookies from Fetch Response headers (supporting getSetCookie() and set-cookie).
 */
export function mergeResponseCookies(
  headers: Headers,
  cookieMap: Map<string, string>
): void {
  const anyHeaders = headers as unknown as {
    getSetCookie?: () => string[];
    get: (name: string) => string | null;
  };
  let rawCookies: string[] = [];
  if (typeof anyHeaders.getSetCookie === 'function') {
    rawCookies = anyHeaders.getSetCookie();
  } else {
    const raw = anyHeaders.get('set-cookie');
    if (raw) {
      rawCookies = raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
    }
  }

  for (const c of rawCookies) {
    const firstPart = c.split(';')[0].trim();
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      const key = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      if (key) cookieMap.set(key, val);
    }
  }
}

export function serializeCookieMap(cookieMap: Map<string, string>): string {
  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function fetchWithTimeoutAndRetry(
  url: string,
  init: RequestInit,
  options?: { timeoutMs?: number; maxRetries?: number }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 2;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const backoffMs = 200 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw new ExternalNetworkError(
    'weekly_report',
    lastErr ? lastErr.message : 'Request timed out'
  );
}

/**
 * Weekly Report Portal Fetcher separating Stage 1 (STATUS_ONLY: no external read side-effect)
 * from Stage 2 (WITH_DETAILS: registers manager read in tWrBrowseData).
 */
export class WeeklyPortalFetcher {
  private username: string;
  private password: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options?: {
    username?: string;
    password?: string;
    timeoutMs?: number;
    maxRetries?: number;
  }) {
    this.username =
      options?.username ??
      process.env.WEEKLY_REPORT_USERNAME ??
      process.env.WEEKLY_REPORT_USER ??
      '';
    this.password =
      options?.password ??
      process.env.WEEKLY_REPORT_PASSWORD ??
      process.env.WEEKLY_REPORT_PASS ??
      '';
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? 2;
  }

  /**
   * Authenticates and fetches Weekly Report top page HTML.
   * Throws ExternalAuthError or ExternalNetworkError on failure (never returns null or dummy).
   */
  async loginAndFetchTop(): Promise<WeeklyPortalSession> {
    if (!this.username || !this.password) {
      throw new ExternalAuthError(
        'weekly_report',
        'WEEKLY_REPORT_USERNAME or WEEKLY_REPORT_PASSWORD is not configured.'
      );
    }

    const loginUrl = 'https://auth.poweredge.co.jp/weekly_report/login';
    const cookies = new Map<string, string>();

    let currentRes = await fetchWithTimeoutAndRetry(
      loginUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://auth.poweredge.co.jp',
          Referer: 'https://auth.poweredge.co.jp/weekly_report/login',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({
          username: this.username,
          password: this.password,
        }).toString(),
        redirect: 'manual',
      },
      { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
    );

    let currentUrl = loginUrl;
    let redirectCount = 0;

    while (
      currentRes.status >= 300 &&
      currentRes.status < 400 &&
      redirectCount < 5
    ) {
      mergeResponseCookies(currentRes.headers, cookies);
      const location = currentRes.headers.get('location');
      if (!location) break;

      currentUrl = new URL(location, currentUrl).href;
      currentRes = await fetchWithTimeoutAndRetry(
        currentUrl,
        {
          headers: {
            Cookie: serializeCookieMap(cookies),
            Referer: currentUrl,
            'User-Agent': USER_AGENT,
          },
          redirect: 'manual',
        },
        { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
      );
      redirectCount++;
    }

    mergeResponseCookies(currentRes.headers, cookies);
    const pageHtml = await currentRes.text();

    assertValidWeeklyTopHtml(pageHtml, currentUrl);

    return {
      pageHtml,
      cookieStr: serializeCookieMap(cookies),
      finalUrl: currentUrl,
    };
  }

  /**
   * Stage 1 (STATUS_ONLY): Fetches submission status without calling `/weekly_report/getReportInfo`.
   * Zero external read (`tWrBrowseData`) side effect.
   */
  async fetchTopStatus(options?: { overrideWrTargetDateId?: number }): Promise<{
    session: WeeklyPortalSession;
    parsed: ParsedWeeklyTopResult;
  }> {
    const session = await this.loginAndFetchTop();
    const parsed = parseStrictWeeklyTopHtml(session.pageHtml, {
      finalUrl: session.finalUrl,
      overrideWrTargetDateId: options?.overrideWrTargetDateId,
    });
    return { session, parsed };
  }

  /**
   * Stage 2 (WITH_DETAILS): Fetches full report body for submitted members.
   * NOTE: Calling getReportInfo registers manager read (`既読`) into `tWrBrowseData` on the external portal.
   * Does NOT swallow individual member errors: tracks failedStaffIds so caller can flag PARTIAL_ERROR.
   */
  async fetchSubmittedDetails(
    cookieStr: string,
    targets: FetchSubmittedDetailsTarget[]
  ): Promise<FetchSubmittedDetailsResult> {
    const reports: FetchSubmittedDetailsResult['reports'] = [];
    const failedStaffIds: FetchSubmittedDetailsResult['failedStaffIds'] = [];

    for (const target of targets) {
      const viewUrl = `https://auth.poweredge.co.jp/weekly_report/view?staffId=${target.staffId}&wrTargetDateId=${target.wrTargetDateId}`;

      try {
        await fetchWithTimeoutAndRetry(
          viewUrl,
          {
            headers: {
              Cookie: cookieStr,
              Referer: 'https://auth.poweredge.co.jp/weekly_report/top',
              'User-Agent': USER_AGENT,
            },
          },
          { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
        );

        const apiUrl =
          'https://auth.poweredge.co.jp/weekly_report/getReportInfo';
        const res = await fetchWithTimeoutAndRetry(
          apiUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Cookie: cookieStr,
              Referer: viewUrl,
              'User-Agent': USER_AGENT,
            },
            body: new URLSearchParams({
              staffId: String(target.staffId),
              wrTargetDateId: String(target.wrTargetDateId),
              switchState: '0',
            }).toString(),
          },
          { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
        );

        if (!res.ok) {
          failedStaffIds.push({
            staffId: target.staffId,
            staffName: target.staffName,
            reason: `HTTP ${res.status}`,
          });
          continue;
        }

        const data = (await res.json()) as {
          impression?: string;
          weekUptime?: number | string;
          vProjectGeneralInformation?: Array<{
            properName?: string;
            endUser?: string;
            prjDetail?: string;
          }>;
        };

        const projects: ProjectReportDetail[] = [];
        if (Array.isArray(data.vProjectGeneralInformation)) {
          for (const p of data.vProjectGeneralInformation) {
            projects.push({
              properName: p.properName || '未確定',
              endUser: p.endUser || '未確定',
              prjDetail: p.prjDetail || '',
            });
          }
        }

        reports.push({
          report: {
            staffId: target.staffId,
            staffName: target.staffName,
            impression: data.impression || '',
            weekUptime: data.weekUptime,
            projects,
          },
          filingDatetime: target.filingDatetime,
          wrTargetDateId: target.wrTargetDateId,
          externalReadRegistered: true,
        });
      } catch (err) {
        failedStaffIds.push({
          staffId: target.staffId,
          staffName: target.staffName,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { reports, failedStaffIds };
  }
}
