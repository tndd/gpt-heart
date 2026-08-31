# Raspberry Pi ChatGPT Loop

Raspberry Pi上のDockerからWeb版ChatGPTを操作し、指定Project内のconversationを継続する非公式のブラウザ自動化ツールです。assistantの応答生成がUI上で完了すると、末尾の制御シグナルを処理し、シグナルがなければ同じconversationへ `.` を送ります。

対象Projectは初期値として次を設定済みです。

`https://chatgpt.com/g/g-p-6a94c14fffb48191a369bb25418da7f7/project`

## 重要な前提

- ChatGPTの公開APIではなくWeb UIを操作します。ChatGPT側のDOM変更、ログイン失効、bot確認、利用上限によって停止する可能性があります。
- 自動送信はアカウントのメッセージ利用量を消費します。最初は `MAX_CONCURRENCY=1` のまま動作を確認してください。
- 認証情報を含む `data/browser` はGit管理されません。バックアップや共有をしないでください。
- noVNCはcompose設定でRaspberry Pi自身のlocalhostだけに公開します。別PCからはSSHトンネルを使います。

## 必要環境

- 64bit Raspberry Pi OS / ARM64 Linux
- Docker EngineとDocker Compose v2
- 目安としてRaspberry Pi 4以降、空きメモリ2GB以上

## 起動

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f loop
```

別PCからRaspberry PiへSSHトンネルを作ります。

```bash
ssh -L 6080:127.0.0.1:6080 <user>@<raspi-host>
```

ブラウザで `http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale` を開きます。

## Googleアカウントでの初回ログイン

初回だけ、`.env` を次のようにします。

```dotenv
LOGIN_ONLY=true
```

起動後、noVNCに表示されたChromiumで次の操作を人手で行います。

1. ChatGPTの「ログイン」を選ぶ。
2. 「Googleで続行」を選ぶ。
3. Googleアカウント、パスワード、2段階認証を通常どおり入力する。
4. 対象ChatGPT Projectが表示できるところまで進む。

ログインできたらコンテナを停止し、`.env` の設定を通常運転へ戻します。

```bash
docker compose down
```

```dotenv
LOGIN_ONLY=false
```

```bash
docker compose up -d
docker compose logs -f loop
```

ログイン専用モードではPlaywrightワーカーを起動せず、通常のheaded Chromiumだけを起動します。ログイン後のCookieなどは `data/browser` に残り、通常運転時のPlaywrightが同じprofileを使用します。GoogleのパスワードやCookieを `.env`、ソースコード、Gitへ保存しないでください。また、Chromiumからパスワード保存を提案されても保存しないことを推奨します。

Google側がログインを拒否した場合は自動回避せず、追加認証を完了するか、アカウントで利用可能な別の正規ログイン方法を使用してください。

`INITIAL_BODY` を設定した場合はログイン後に新規conversationを自動作成します。空の場合は、noVNC上で最初のメッセージを手動送信すると、そのconversationを登録してループを開始します。

ループ開始前に [PROJECT_INSTRUCTIONS.md](PROJECT_INSTRUCTIONS.md) のテンプレートを対象Projectのinstructionsへ設定してください。これがない場合、ChatGPTは `.` を「前の思考を続ける」という意味に解釈するとは限りません。

## 制御シグナル

assistant responseの末尾に連続して存在する `@@RASPI@@` 行だけを読みます。本文中の同じ文字列は無視します。

```text
@@RASPI@@ {"action":"next","body":"次のconversationへの初回入力"}
```

複数の `next` は出現順に耐障害キューへ保存され、それぞれ同一Project内の新しいconversationになります。新しいconversationの `parent` には元conversation URLを保存します。

```text
@@RASPI@@ {"action":"end"}
```

`end` は現在のconversationだけを終了します。同じ末尾に `next` と `end` が併存した場合、`next` の子conversationを作成したうえで現在のconversationを終了します。

不正なJSON、未知のaction、空の `next.body` は警告ログに記録して無視します。有効な制御シグナルが1つもなければ `.` を送ります。

## 状態ファイル

`data/state/state.json` は仕様どおりconversation URLをキーとして保持します。

```json
{
  "https://chatgpt.com/c/parent": {
    "status": "ended",
    "parent": null
  },
  "https://chatgpt.com/c/child": {
    "status": "active",
    "parent": "https://chatgpt.com/c/parent"
  }
}
```

重複送信を抑える処理位置と終端決定は `progress.json`、未作成の `next` は `queue.json` に分離します。どのファイルも一時ファイルからatomic renameして更新します。

child conversationの送信ボタンを押す直前にjobを `send-uncertain` へ変更します。この状態のjobは、送信結果を確認できなくても同じbodyを自動再送しません。`queue.json` とChatGPT Projectを確認し、必要な場合だけ人手で整理してください。

## 停止と再開

```bash
docker compose stop
docker compose start
```

再開時は `active` のconversationと未完了queueを読み直します。個別conversationを人手で止める場合は、コンテナ停止中に該当URLの `status` を `ended` へ変更してください。

## ローカル検証

```bash
npm ci
npm run check
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
npm run test:browser
docker compose config
docker build -t raspi-chatgpt-loop:test .
```

実ChatGPTアカウントを使うend-to-end確認はメッセージ送信を伴うため、自動テストには含めていません。

## 既知の限界

- ChatGPT UIの変更時は `src/chatgpt-page.ts` の候補セレクタ更新が必要です。
- 新規conversationへの初回送信結果が不明になったjobは安全側で停止するため、人手での確認が必要です。UI操作だけで完全なexactly-once判定はできません。
- CAPTCHA、追加認証、利用上限画面は自動突破せず、noVNCでの手動対応を待ちます。
