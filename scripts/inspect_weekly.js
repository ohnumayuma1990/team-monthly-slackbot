/**
 * scripts/inspect_weekly.js
 * 
 * 週報システム（https://auth.poweredge.co.jp/weekly_report/）へ安全にログインし、
 * 画面の構造・リンク・テーブル項目を解析してローカルに保存するスクリプト。
 * 
 * 使い方:
 *   1. .env に以下を記載（または実行時にターミナルで対話入力）
 *      WEEKLY_REPORT_USERNAME=あなたのユーザー名
 *      WEEKLY_REPORT_PASSWORD=あなたのパスワード
 *   2. node scripts/inspect_weekly.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function promptPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let password = '';
    const onData = (ch) => {
      ch = ch.toString('utf8');
      switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password.trim());
          break;
        case '\u0003':
          process.exit();
          break;
        case '\u007f':
        case '\b':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          password += ch;
          process.stdout.write('*');
          break;
      }
    };
    stdin.on('data', onData);
  });
}

function parseCookies(cookieHeaders, existingCookies = new Map()) {
  if (!cookieHeaders) return existingCookies;
  const list = Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders];
  for (const c of list) {
    const parts = c.split(';')[0].split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      existingCookies.set(key, val);
    }
  }
  return existingCookies;
}

function getCookieString(cookieMap) {
  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function main() {
  console.log('========================================================');
  console.log('   週報システム（WeeklyReport）安全解析スクリプト');
  console.log('========================================================\n');

  let username = process.env.WEEKLY_REPORT_USERNAME || process.env.WEEKLY_REPORT_USER;
  let password = process.env.WEEKLY_REPORT_PASSWORD || process.env.WEEKLY_REPORT_PASS;

  if (!username) {
    username = await prompt('ユーザー名 (username / 社員番号): ');
  }
  if (!password) {
    password = await promptPassword('パスワード (password): ');
  }

  if (!username || !password) {
    console.error('❌ ユーザー名またはパスワードが入力されていません。');
    process.exit(1);
  }

  const baseUrl = 'https://auth.poweredge.co.jp/weekly_report/';
  const cookies = new Map();

  console.log(`\n1. ログイン画面へ接続中: ${baseUrl}`);
  const initialRes = await fetch(baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  const initSetCookie = initialRes.headers.getSetCookie ? initialRes.headers.getSetCookie() : [initialRes.headers.get('set-cookie')].filter(Boolean);
  parseCookies(initSetCookie, cookies);

  console.log('2. ログイン情報をPOST送信中...');
  const postBody = new URLSearchParams();
  postBody.append('username', username);
  postBody.append('password', password);

  const loginUrl = 'https://auth.poweredge.co.jp/weekly_report/login';
  let currentRes = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://auth.poweredge.co.jp',
      'Referer': 'https://auth.poweredge.co.jp/weekly_report/login',
      'Cookie': getCookieString(cookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: postBody.toString(),
    redirect: 'manual',
  });

  console.log(`   HTTPステータス: ${currentRes.status} (${currentRes.statusText})`);

  // リダイレクトチェーン（login -> loginSuccess -> top）をCookieを保持して追跡
  let currentUrl = loginUrl;
  let redirectCount = 0;

  while (currentRes.status >= 300 && currentRes.status < 400 && redirectCount < 5) {
    const setCookie = currentRes.headers.getSetCookie ? currentRes.headers.getSetCookie() : [currentRes.headers.get('set-cookie')].filter(Boolean);
    parseCookies(setCookie, cookies);

    const location = currentRes.headers.get('location');
    if (!location) break;

    currentUrl = new URL(location, currentUrl).href;
    console.log(`   ➡️ リダイレクト先 (${currentRes.status}): ${currentUrl}`);

    currentRes = await fetch(currentUrl, {
      headers: {
        'Cookie': getCookieString(cookies),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': currentUrl,
      },
      redirect: 'manual',
    });
    redirectCount++;
  }

  const finalSetCookie = currentRes.headers.getSetCookie ? currentRes.headers.getSetCookie() : [currentRes.headers.get('set-cookie')].filter(Boolean);
  parseCookies(finalSetCookie, cookies);

  const pageHtml = await currentRes.text();

  // ログイン成否の簡易判定
  if (pageHtml.includes('ユーザー名またはパスワードが違います') || pageHtml.includes('id="loginForm"') || currentUrl.includes('login?error')) {
    console.error('\n❌ ログインに失敗した可能性があります（ログイン画面またはエラーが表示されています）。');
    console.error('   ユーザー名・パスワードをご確認ください。');
  } else {
    console.log(`\n🎉 ログイン成功！画面の取得完了 (${currentUrl})`);
  }

  // タイトル抽出
  const titleMatch = pageHtml.match(/<title>([\s\S]*?)<\/title>/i);
  console.log(`   タイトル: ${titleMatch ? titleMatch[1].trim() : '（なし）'}`);

  // ページ内リンク抽出
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  const links = [];
  while ((linkMatch = linkRegex.exec(pageHtml)) !== null) {
    const href = linkMatch[1];
    const text = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    if (text && !href.startsWith('#') && !href.startsWith('javascript:')) {
      links.push({ text, href });
    }
  }

  if (links.length > 0) {
    console.log('\n   【検出されたメニュー・リンク一覧】');
    for (const l of links) {
      console.log(`   - ${l.text} -> ${l.href}`);
    }
  }

  // フォーム一覧抽出
  const formRegex = /<form[^>]+action=["']?([^"'>\s]*)["']?[^>]*method=["']?([^"'>\s]*)["']?[^>]*>/gi;
  let formMatch;
  const forms = [];
  while ((formMatch = formRegex.exec(pageHtml)) !== null) {
    forms.push({ action: formMatch[1] || '(current)', method: formMatch[2] || 'GET' });
  }
  if (forms.length > 0) {
    console.log('\n   【検出されたフォーム】');
    for (const f of forms) {
      console.log(`   - action: ${f.action}, method: ${f.method}`);
    }
  }

  // 表（テーブルヘッダー）抽出
  const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let thMatch;
  const headers = [];
  while ((thMatch = thRegex.exec(pageHtml)) !== null) {
    const text = thMatch[1].replace(/<[^>]+>/g, '').trim();
    if (text) headers.push(text);
  }
  if (headers.length > 0) {
    console.log('\n   【検出された表の項目名（見出し）】');
    console.log('   ' + headers.join(' | '));
  }

  // キーワード検出（大沼チームや提出状況など）
  const keywords = ['大沼', '提出', '未提出', '承認', '週報', 'ステータス', '一覧'];
  console.log('\n   【キーワード検索結果】');
  for (const kw of keywords) {
    const count = (pageHtml.match(new RegExp(kw, 'g')) || []).length;
    console.log(`   - 「${kw}」の出現回数: ${count} 回`);
  }

  // HTMLの保存
  const outPath = path.join(__dirname, 'weekly_report_page.html');
  fs.writeFileSync(outPath, pageHtml, 'utf-8');
  console.log(`\n💾 解析用HTMLを保存しました: ${outPath}`);
  console.log('   （※このファイルは.gitignoreによりGitにはコミットされません。安全に手元で確認できます）');
}

main().catch((err) => {
  console.error('\n❌ エラーが発生しました:', err);
});
