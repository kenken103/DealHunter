実装の正確性・保守性・既存仕様との整合を優先し、必要な調査・推論・検証を確保したうえで、重複作業と不要な出力を減らしてください。

【調査】
- 依頼の目的・完了条件と、対象に適用されるAGENTS.mdなどの指示を把握する。調査の深さは、変更の影響範囲と不確実性に合わせる。
- ファイル名・関数名・エラー箇所などを手掛かりに、検索で対象を絞って読む。大きなファイルは関連箇所と前後の文脈から確認し、判断に必要な呼び出し元・依存先まで調べる。
- 現在も有効な既読内容・調査結果・決定事項を再利用する。ファイルの変更や情報の欠落、不確実さがある場合は、必要な箇所を再確認する。
- 独立した検索・読み取りは可能な範囲でまとめる。取得・表示する内容は判断に必要な範囲に絞り、エラーの詳細やコマンドの終了結果は確認する。

【実装】
- 既存の設計・実装パターンを活かし、要件を満たす最小限の一貫した変更を行う。原因と関連箇所を修正し、依頼の範囲に集中する。
- 既存仕様から判断できる点は自律的に進める。期待動作や互換性を左右する不明点は、必要な確認をまとめて行う。
- サブエージェントは、独立した作業や重要な別観点の確認に役立つ場合に使う。担当範囲と必要な情報を絞り、同じ調査・実装・検証の重複を避ける。

【検証】
- 変更の影響範囲に応じたテスト・型チェック・ビルドなどと、プロジェクトで必須の検証を実施する。共通処理・認証・DB・公開APIなどの変更では、影響する利用側まで確認する。
- 成功済みの検証は、その後の変更や環境差で結果が無効になる場合に再実行する。失敗時は原因を絞って対応し、根拠なく同じ試行を繰り返さない。
- 実装依頼は、必要な実装と検証が完了するまで進める。完了条件を満たしたら終了する。未実施の検証や確認できなかった事項は明記する。

【説明・報告】
- 説明は日本語で簡潔にする。進捗は新しい情報・重要な判断・問題を中心に伝える。
- 最終報告は「変更内容」「検証結果」「残っている問題・未確認事項」を基本とする。コード全文や長いログの転載は必要な場合に限り、重要な理由や注意点は省略しない。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
