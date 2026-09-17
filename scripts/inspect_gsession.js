/**
 * scripts/inspect_gsession.js
 * 
 * GroupSession（https://po-tal.poweredge.co.jp/gsession/common/cmn001.do）へ安全にログインし、
 * メイン画面・利用可能機能（日報、スケジュール、掲示板など）の構造を解析するスクリプト。
 * 
 * 使い方:
 *   1. .env に以下を記載（または実行時にターミナルで対話入力）
 *      GSESSION_USER=あなたのユーザーID
 *      GSESSION_PASS=あなたのパスワード
 *   2. node scripts/inspect_gsession.js
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
  console.log('   GroupSession 安全解析スクリプト');
  console.log('========================================================\n');

  let username = process.env.GSESSION_USER || process.env.GSESSION_USERNAME;
  let password = process.env.GSESSION_PASS || process.env.GSESSION_PASSWORD;

  if (!username) {
    username = await prompt('GroupSession ユーザーID (cmn001Userid): ');
  }
  if (!password) {
    password = await prompt('GroupSession パスワード (cmn001Passwd): ');
  }

  if (!username || !password) {
    console.error('❌ ユーザーIDまたはパスワードが入力されていません。');
    process.exit(1);
  }

  const loginUrl = 'https://po-tal.poweredge.co.jp/gsession/common/cmn001.do';
  const cookies = new Map();

  console.log(`\n1. ログイン画面を取得中: ${loginUrl}`);
  const initialRes = await fetch(loginUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  const initSetCookie = initialRes.headers.getSetCookie ? initialRes.headers.getSetCookie() : [initialRes.headers.get('set-cookie')].filter(Boolean);
  parseCookies(initSetCookie, cookies);

  const initialHtml = await initialRes.text();

  // Strutsトークンの抽出
  const tokenMatch = initialHtml.match(/name="org\.apache\.struts\.taglib\.html\.TOKEN"\s+value="([^"]+)"/i);
  const strutsToken = tokenMatch ? tokenMatch[1] : '';
  console.log(`   Strutsトークン: ${strutsToken ? '取得成功' : 'なし'}`);

  // フォームのアクションURL（jsessionidが含まれる場合がある）
  const formActionMatch = initialHtml.match(/<form[^>]+action="([^"]+)"/i);
  let postUrl = loginUrl;
  if (formActionMatch) {
    postUrl = new URL(formActionMatch[1], loginUrl).href;
  }
  console.log(`   POST送信先: ${postUrl}`);

  console.log('2. ログイン情報をPOST送信中...');
  const postBody = new URLSearchParams();
  if (strutsToken) {
    postBody.append('org.apache.struts.taglib.html.TOKEN', strutsToken);
  }
  postBody.append('CMD', 'login');
  postBody.append('cmn001loginType', '1');
  postBody.append('url', '');
  postBody.append('cmn001initAccess', '1');
  postBody.append('cmn001Userid', username);
  postBody.append('cmn001Passwd', password);

  const loginRes = await fetch(postUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieString(cookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    redirect: 'manual',
  });

  const loginSetCookie = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')].filter(Boolean);
  parseCookies(loginSetCookie, cookies);

  console.log(`   HTTPステータス: ${loginRes.status} (${loginRes.statusText})`);

  let targetUrl = postUrl;
  if (loginRes.status >= 300 && loginRes.status < 400) {
    const redirectLocation = loginRes.headers.get('location');
    targetUrl = new URL(redirectLocation, loginUrl).href;
    console.log(`   ➡️ リダイレクト先: ${targetUrl}`);
  }

  console.log(`\n3. ログイン後ポータルページを取得中: ${targetUrl}`);
  const pageRes = await fetch(targetUrl, {
    headers: {
      'Cookie': getCookieString(cookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  const pageHtml = await pageRes.text();

  if (pageHtml.includes('cmn001Userid') || pageHtml.includes('ユーザーIDまたはパスワードが違います')) {
    console.error('\n❌ ログインに失敗した可能性があります。ユーザーID・パスワードをご確認ください。');
  } else {
    console.log('\n🎉 GroupSession ログイン成功！');
  }

  const titleMatch = pageHtml.match(/<title>([\s\S]*?)<\/title>/i);
  console.log(`   タイトル: ${titleMatch ? titleMatch[1].trim() : '（なし）'}`);

  // プラグイン・メニュー機能の検出
  const menuKeywords = ['スケジュール', '日報', '掲示板', '回覧板', '施設予約', '稟議', 'プロジェクト', 'ショートメール', 'ファイル管理', '大沼'];
  console.log('\n   【検出された主要機能】');
  for (const kw of menuKeywords) {
    const count = (pageHtml.match(new RegExp(kw, 'g')) || []).length;
    if (count > 0) {
      console.log(`   - 「${kw}」: ${count} 箇所で検出`);
    }
  }

  // リンク一覧の抽出
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
    console.log('\n   【検出されたナビゲーションリンク】');
    for (const l of links.slice(0, 20)) {
      console.log(`   - ${l.text} -> ${l.href}`);
    }
    if (links.length > 20) {
      console.log(`   ...他 ${links.length - 20} 件`);
    }
  }

  // HTMLの保存
  const outPath = path.join(__dirname, 'gsession_main.html');
  fs.writeFileSync(outPath, pageHtml, 'utf-8');
  console.log(`\n💾 解析用HTMLを保存しました: ${outPath}`);
  console.log('   （※このファイルは.gitignoreによりGitにはコミットされません）');
}

main().catch((err) => {
  console.error('\n❌ エラーが発生しました:', err);
});
