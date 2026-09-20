# cc-sidecar の内部

[English](internals.md)

このドキュメントでは、cc-sidecar の内部の仕組みと、その設計方針にいたった背景について説明します。具体的な機能や使い方については、[README](README.ja.md) を参照してください。

## コマンドの書き換え

各 CLI で追加されるオプション（フラグ）については README を参照してください。フックは、最終的に以下のようなコマンドを実行します。

```
mkdir -p <runs>; set -o pipefail; { <rewritten call> < /dev/null ; } 2>&1 | tee <log>; printf '{"type":"cc-sidecar.exit","code":%s}\n' "$?" >> <log>
```

ここで、`<log>` は `<runs>/<tool_use_id>.jsonl` を指し、`<runs>` は `$HOME/.cache/cc-sidecar/runs` になります（`HOME` の値は `$.env.get` を使って取得し、設定されていない場合のデフォルトは `/tmp` です）。なお、`run_in_background` を使ってバックグラウンドで呼び出す場合は、以下のようにコマンドの構成が異なります。

```
mkdir -p <runs>; { <rewritten call> < /dev/null ; } > <log> 2>&1; printf '…exit…' >> <log>; <wait up to 10 s for <runs>/<tool_use_id>.answer>; cat <answer> || echo 'cc-sidecar: no answer was extracted; the log is <log>'
```

- `< /dev/null`: これがないと、`codex exec` は標準入力からの入力を待ち続けてハングしてしまいます。他の 2 つの CLI も標準入力の内容を `-p` 引数に追加するため、結果的に 3 つの CLI すべてが標準入力を受け取ることになります。
- `tee`: 表示ペインが `$.fs.read` を使って監視しているファイルに、実行結果を出力するために使用します。
- 末尾の `printf`: パイプラインの処理が終わった後に終了レコードを追記することで、ログファイルを見るだけで実行終了を検知できるようにします。フォアグラウンドでの呼び出しであればツールの結果から完了を判断できますが、**バックグラウンド呼び出し** の場合はシェルが起動した時点で即座にツールの結果が返ってしまうため、この終了レコードだけが頼りになります。表示ペインは、この終了レコードがログに書き込まれるまでバックグラウンド処理を実行中として扱います。そのため、バックグラウンドのシェルプロセスが外部から強制終了されると終了レコードが書き込まれず、表示上は実行中のままになってしまいます。
- **background stdout**: JSONL の出力は、標準出力には出さずログファイルにのみ書き込みます。定期実行されるループ（ティックループ）が終了レコードを検知すると、`$.fs.write` を使って `<tool_use_id>.answer` ファイルに要約ダイジェスト（README の要約テーブルを参照）を書き込みます。このファイルの生成を待機していたバックグラウンドのシェルが、その内容を標準出力に出力します。これにより、モデルが後で読み込むタスク出力ファイルには、生の JSONL ログではなく最終的な回答だけが格納されるようになります。なお、回答が書き込まれる前にプラグインがリロードやアンロードによって削除された場合は、10 秒でタイムアウトし、実際のログファイルへのパスを示す 1 行のメッセージを出力します。

## JSONL の読み方

各 CLI で出力されるデータの構造が異なるため、`absorb` 処理では `run.key` の値に応じて処理を分岐させています。

|        | Final answer                          | Done when                      | Steps                          | Model                                                                            |
| ------ | ------------------------------------- | ------------------------------ | ------------------------------ | -------------------------------------------------------------------------------- |
| codex  | 最後の `agent_message`                | `turn.completed`               | `item.completed`               | 出力されません                                                                   |
| claude | `result.result`                       | `is_error` を含まない `result` | `assistant` コンテンツブロック | `system.model` → `assistant.message.model`                                       |
| gemini | `result` の直前のアシスタントテキスト | `result.status === 'success'`  | `tool_use`                     | `init.model` は `auto` で、実際のモデル名は `result.stats.models` に格納されます |

codex はモデル名を出力しないため、代わりに起動コマンドの `-m` または `--model` オプションからモデル名を取得します。このフォールバック処理は 3 つすべての CLI で共通で、JSONL データの解析前に初期表示されますが、その後 JSONL から実際のモデル名が取得できれば、そちらで上書きされます。なお、gemini は 1 回の実行で複数のモデルを使用することがあり、その場合は各モデル名が `/` で連結されて表示されます。

gemini では、`message` イベントは累積値ではなく **差分（増分）**（`delta: true`）として送られてくるため、順次結合していく必要があります。また、`role: 'user'` の `message` はエコーバックされたユーザーのプロンプトであるため、破棄します。

gemini の最終回答は、`result` の直前までに蓄積されたテキストのみが対象となります。ツール呼び出しが発生すると、それまでに蓄積されたテキストは履歴に書き出されて（フラッシュされて）消えてしまうため、会話の導入部分（プリアンブル）などは最終回答には残りません。

## モデルが読むもの

README にはモデルが受け取る情報について記載されていますが、書き換え後の実行結果からはさらに 2 つの要素が除外されています。これには、それぞれ以下の理由があります。

書き換え後の結果からは `ref` と `text` の両方が削除されます。`ToolCallResult` の仕様には以下のように定義されています。

> A hook that returns the object it got makes core use them verbatim.

そのため、これらの要素を残したままにすると、core 側で置換処理が無視されてしまいます。

`persistedOutputPath`、`persistedOutputSize`、`rawOutputPath`、`structuredContent` といったフィールドは、`stdout` と一緒に破棄されます。出力が肥大化した場合、core は生のテキストを別ファイルに退避させ、そのファイルパスを実行結果に含めます。そのため、`stdout` だけを書き換えても、「output too large, saved to...」という通知や生の JSONL へのリンクが残ってしまい、非表示にしたいコンテンツが別の形でモデルに渡ってしまいます。codex では JSONL の出力サイズがしきい値を超えないためこの現象は起きませんが、claude では実際に発生していました。

## 設計を決めた事実

これらの設計方針は、`/plugin-types` の定義仕様や、実際の挙動を計測・検証した結果に基づいています。

**実行中のツールの出力は読み取れません。** `ToolUse.output` の仕様では以下のように定義されています。

> The stored result once the call has resolved; undefined while it runs.

`ToolResult` はその定義の通り「実行完了後の最終結果」であるため、実行中にログを監視するには先述したようなコマンドの書き換え（パイプライン化）が必要になります。

**ペインの再描画タイミングは不規則です。** 再描画の間隔を計測したところ、1 ms から 9.7 s と大きなバラつきがありました。経過時間の表示やスピナーの動作は `$.clock.every` と `$.ui.invalidate` を組み合わせて制御しており、実行中のタスクが表示されなくなるとタイマーも停止するようになっています。

**`ui.render` の出力はキャッシュされます。**

> once per input value (props, viewport width), plugin load or `$.ui.invalidate("ui.render")`

**`command.run` フックだけではコマンドは登録されません。** `command.run` だけをフックした状態で `/cc-sidecar` コマンドを実行しようとしても、「Unknown command」 エラーになります。コマンドとして認識させるには、`$.command.register` を使って明示的に登録する必要があります。この登録処理は通常 `session.start` のタイミングで行われますが、ホットリロード時には `session.start` が再実行されないため、リロード後の最初のフックが実行されるタイミングでも遅延登録（lazy registration）を行うようにしています。

**Escape キーはインターセプト（横取り）できません。** `ClientKeyEvent` の仕様において、`Escape never arrives: it returns the focus` と定められています。エンジン（Claude Code の本体側）が、フォーカスをプロンプトに戻すキーとして Escape キーの挙動を専有しているため、履歴画面を抜けるには `← back` ボタン（ホットキー `b` に割り当て）を押す必要があります。

## hooks module の制約

このモジュールは Node.js のない環境で動くため、`process` や `node:fs` は使えません。外部とのインタラクションはすべて `$` オブジェクトを経由させる必要があります。また、`$` オブジェクトはファイル内のトップレベル（最上位）で宣言された関数にしか渡せません。`register` 内のクロージャに渡してしまうと、`claude plugin validate` による検証でエラーとなり、プラグインが拒否されてしまいます。

そのため、`Button.onPress` の中身は空のままにしておき、ボタン押下時の処理は `ui.press` フック側でハンドリングしています。これは、`onPress` が描画（render）関数内のクロージャであるために `$` にアクセスできないのに対し、フックであれば引数として `$` を問題なく受け取れるという仕様上の理由によるものです。

## 約束

エンジンが本来行う描画（`next(e)`）の結果は、常にそのまま返します。アクティビティが検知されない場合や、プロパティ（props）の取得時にエラーが発生した場合は、元の描画内容に一切手を加えずそのままパススルーさせます。これにより、プラグインが原因で `ToolUse` の表示行が消失してしまうのを防いでいます。

## テスト

`plugin test` コマンドは、専用のフラグを指定しないと利用できません。また、テストキット内の `$` オブジェクトには `clock` プロパティがなく、`tool.call` や `ui.render` からもデータが提供されません。そのため、実行中の呼び出しを前提とするテストでは、`tool.call` をモックして後から解決（resolve）される Promise を返すように実装する必要があります。同様に、エンジンによる本来の描画内容を必要とするテストでは、`ui.render` をスタブとしてモックする必要があります。

画面レイアウトの配置はプログラム上でのテストが難しいため、`script` コマンドを使って `--debug-file` と使い捨て（ワンショット）のプロンプトでセッションを実行し、記録された画面出力を読み取ることで、描画結果をシミュレート・検証できます。

```sh
(sleep 100) | CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 timeout 75 script -q -c \
  "stty cols 228 rows 51; claude --debug-file /tmp/sidecar.log --plugin-dir . \
   --model sonnet --permission-mode auto --allowedTools Bash \
   'Use the Bash tool to run: claude -p \"Reply with ok\" --model haiku'" /dev/null > /tmp/sidecar.screen
```

キャプチャした出力に含まれるカーソル移動シーケンス（`ESC[row;colH`）を確認することで、各パーツがどの行に描画されたかを特定できます。また、ログに `does not validate` と出力されている場合は、描画された UI ツリーが不正と判定されて拒否されたことを示しています。
