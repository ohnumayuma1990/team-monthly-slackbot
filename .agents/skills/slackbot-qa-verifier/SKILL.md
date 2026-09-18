---
name: slackbot-qa-verifier
description: Automated quality assurance, testing, security audit, and pre-deployment inspection skill for Slack bots on Google Cloud Run. Runs ESLint, TypeScript build, Jest tests, zero-hardcoding security scans, Slack mrkdwn formatting invariant audits, and live Cloud Run health verification. Use whenever testing changes, preparing to push, or conducting pre-deployment checks.
---

# SlackBot QA & Verification Skill (総合検証スキル)

このスキルは、Slack Bot および Google Cloud Run デプロイ前の **総合品質検査（QA）** を自動実行するためのスキルです。

---

## 1. いつこのスキルを使うか
* コードの修正・機能追加・リファクタリングが完了したとき
* `git push origin main` を実行する直前の安全確認
* Slack の太字・見出し装飾が壊れていないか、ハードコードされた個人情報や鍵が混入していないかを確認するとき

---

## 2. 実行手順

### ① ワンコマンド自動検証の実行
プロジェクトルートで以下のコマンドを実行します：

```bash
npm run verify
```

内部で `scripts/verify_slackbot.js` が起動し、以下の6層の検査を順次実行します：

1. **静的コード解析 (ESLint / Prettier)**:
   構文エラー、未定義変数、改行コード不一致（CRLF）を検査。
2. **TypeScript 型チェック & ビルド (`tsc`)**:
   すべての型整合性を検証し、コンパイルエラーがないことを確認。
3. **単体テスト全件実行 (Jest)**:
   シート名寄せ、Gemini連携、メール振り分け、週報チェック、勤怠確認の全テストを実行。
4. **セキュリティ & 機密情報スキャン**:
   `src/` 配下に社員番号（6桁数値）、個人メール、APIキー（`xoxb-`, `AIzaSy`）、秘密鍵が直接書かれていないかを走査。
5. **Slack `mrkdwn` 構文監査**:
   Slack 上で太字が無効化される構文トラップ（`・*` や `*：` など）が文字列リテラルに含まれていないか検査。
6. **本番稼働ヘルスチェック**:
   Cloud Run の `/health` エンドポイントへ疎通し、`status: healthy` が返るか確認。

---

## 3. 判定と対処方法

* **ALL PASS 🎉**:
  すべてのチェックが合格した場合、安全にコミット＆プッシュ（`git push origin main`）して問題ありません。
* **FAIL ❌ が発生した場合**:
  - `[Linter]` ➔ `npm run format` または対象ファイルの構文エラーを修正。
  - `[Build / Tests]` ➔ 型エラーまたはテストの期待値不一致を解消。
  - `[Scanning Secrets]` ➔ ハードコードされた社員情報・鍵を環境変数（`TEAM_MEMBERS_CONFIG` 等）へ退避。
  - `[Auditing mrkdwn]` ➔ `・ *`（スペース追加）または `*: `（半角コロン＋スペース）に修正。
