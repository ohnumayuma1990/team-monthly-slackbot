import { GSessionScheduleDay } from '../../../types';
import {
  assertValidGSessionHtml,
  parseStrictGSessionMan050Html,
  parseStrictGSessionScheduleHtml,
} from '../parsers/gsession-parser';
import {
  ExternalAuthError,
  ExternalNetworkError,
  ParsedGSessionLoginsResult,
} from '../types';
import { mergeResponseCookies, serializeCookieMap } from './weekly-fetcher';

const DEFAULT_TIMEOUT_MS = 10000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchGsWithRetry(
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
      const res = await fetch(url, { ...init, signal: controller.signal });
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
    'gsession',
    lastErr ? lastErr.message : 'GroupSession request timed out'
  );
}

/**
 * GroupSession Portal Fetcher with multi-cookie merging, login redirect verification,
 * configurable GSESSION_GROUP_SID, and single-session reuse.
 */
export class GSessionPortalFetcher {
  private username: string;
  private password: string;
  private groupSid: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options?: {
    username?: string;
    password?: string;
    groupSid?: string;
    timeoutMs?: number;
    maxRetries?: number;
  }) {
    this.username =
      options?.username ??
      process.env.GSESSION_USERNAME ??
      process.env.GSESSION_USER ??
      '';
    this.password =
      options?.password ??
      process.env.GSESSION_PASSWORD ??
      process.env.GSESSION_PASS ??
      '';
    this.groupSid =
      options?.groupSid ?? process.env.GSESSION_GROUP_SID ?? '157';
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? 2;
  }

  /**
   * Logs into GroupSession, merging all Set-Cookie headers and verifying authentication success.
   */
  async login(): Promise<{ sessionCookie: string }> {
    if (!this.username || !this.password) {
      throw new ExternalAuthError(
        'gsession',
        'GSESSION_USERNAME or GSESSION_PASSWORD is not configured.'
      );
    }

    const loginUrl = 'https://po-tal.poweredge.co.jp/gsession/common/cmn001.do';
    const cookies = new Map<string, string>();

    const initRes = await fetchGsWithRetry(
      loginUrl,
      { headers: { 'User-Agent': USER_AGENT } },
      { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
    );
    mergeResponseCookies(initRes.headers, cookies);
    const initHtml = await initRes.text();

    const tokenMatch = initHtml.match(
      /name="org\.apache\.struts\.taglib\.html\.TOKEN"\s+value="([^"]+)"/i
    );
    const token = tokenMatch ? tokenMatch[1] : '';

    const postBody = new URLSearchParams();
    if (token) {
      postBody.append('org.apache.struts.taglib.html.TOKEN', token);
    }
    postBody.append('CMD', 'login');
    postBody.append('cmn001loginType', '1');
    postBody.append('cmn001Userid', this.username);
    postBody.append('cmn001Passwd', this.password);

    const loginRes = await fetchGsWithRetry(
      loginUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: serializeCookieMap(cookies),
          'User-Agent': USER_AGENT,
        },
        body: postBody.toString(),
        redirect: 'manual',
      },
      { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
    );

    mergeResponseCookies(loginRes.headers, cookies);

    // If status is 200 (not 3xx redirect), verify that it didn't render the login error screen
    if (loginRes.status === 200) {
      const loginHtml = await loginRes.text();
      assertValidGSessionHtml(loginHtml, 'login');
    }

    const sessionCookie = serializeCookieMap(cookies);
    if (!sessionCookie) {
      throw new ExternalAuthError(
        'gsession',
        'No session cookie received from GroupSession login.'
      );
    }

    return { sessionCookie };
  }

  /**
   * Fetches team login history (`man050.do`) strictly (Fail-Closed).
   */
  async fetchLoginStatuses(options?: {
    sessionCookie?: string;
    inactiveThresholdDays?: number;
    now?: Date;
  }): Promise<{
    sessionCookie: string;
    result: ParsedGSessionLoginsResult;
  }> {
    const cookie = options?.sessionCookie || (await this.login()).sessionCookie;

    const listUrl = 'https://po-tal.poweredge.co.jp/gsession/main/man050.do';
    const man050Body = new URLSearchParams({
      CMD: '',
      cmd: '',
      man050SortKey: '4',
      man050OrderKey: '0',
      man050Backurl: '1',
      man050SelectedUsrSid: '0',
      man050cmdMode: '0',
      man050SearchFlg: '0',
      sch010SelectUsrSid: '',
      sch010SelectUsrKbn: '',
      helpPrm: '2',
      man050grpSid: this.groupSid,
    });

    const listRes = await fetchGsWithRetry(
      listUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
          'User-Agent': USER_AGENT,
        },
        body: man050Body.toString(),
      },
      { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
    );

    const listHtml = await listRes.text();
    const result = parseStrictGSessionMan050Html(listHtml, {
      now: options?.now,
      thresholdDays: options?.inactiveThresholdDays ?? 7,
      groupSid: this.groupSid,
    });

    return { sessionCookie: cookie, result };
  }

  /**
   * Fetches manager's 1-week schedule (`schmain.do`) strictly (Fail-Closed).
   */
  async fetchManagerSchedule(options?: {
    sessionCookie?: string;
  }): Promise<GSessionScheduleDay[]> {
    const cookie = options?.sessionCookie || (await this.login()).sessionCookie;

    const schmainUrl =
      'https://po-tal.poweredge.co.jp/gsession/schedule/schmain.do';
    const res = await fetchGsWithRetry(
      schmainUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
          'User-Agent': USER_AGENT,
        },
        body: '',
      },
      { timeoutMs: this.timeoutMs, maxRetries: this.maxRetries }
    );

    const html = await res.text();
    return parseStrictGSessionScheduleHtml(html);
  }
}
