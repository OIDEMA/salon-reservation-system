# スタッフ招待メール

「スタッフを招待」でメールアドレス・役割・利用店舗を設定し、「招待メールを送信」を押すと、APIがAmazon SES経由で本人にメールを送信します。差出人は `Beauty Gum <noreply@beauty-gum.jp>`、本文にはテナント名、役割、招待先、有効期限（日本時間）、承諾ボタンが入ります。HTMLとプレーンテキストの両方を送信します。

## 本番設定

APIランタイムに次を設定します。ブラウザーやApp Hostingの公開環境変数には認証情報を渡しません。

| 設定 | 本番値・用途 |
| --- | --- |
| `APP_PUBLIC_ORIGIN` | `https://salon-reserve-web--salon-reserve-bg.asia-east1.hosted.app`。メール内URLの固定オリジン。リクエストのHost等から生成しない |
| `INVITATION_EMAIL_FROM` | `noreply@beauty-gum.jp`。SES側で送信元またはドメインの検証が必要 |
| `AWS_REGION` | `ap-northeast-1`。送信元を検証したリージョン |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 専用の最小権限認証情報。Secret ManagerからAPIへ注入する |

AWS権限は、この送信元からの `ses:SendEmail` に限定します。SESの送信元検証、DKIM/SPF/DMARC、本番アクセス状態を確認してください。サンドボックスのままでは未検証の宛先へ送れません。既存の他システムのキーやConfiguration Setを流用せず、招待用に用意します。

Secret Managerには例として `reservation-invitation-aws-access-key-id` と `reservation-invitation-aws-secret-access-key` を作成し、APIランタイムのサービスアカウントにその2シークレットだけの読み取り権限を付与します。APIサービスに `AWS_ACCESS_KEY_ID=reservation-invitation-aws-access-key-id:latest` と `AWS_SECRET_ACCESS_KEY=reservation-invitation-aws-secret-access-key:latest` をシークレットとして設定します。

ネイティブデプロイはAPIのシークレットを `--update-secrets` で更新するため、事前設定したメール認証情報を削除しません。通常環境変数は既定値に設定します。DBマイグレーションジョブへメール認証情報は渡しません。認証情報や送信元の準備が未完了の場合、招待操作は503で失敗し、送信済みと表示しません。

## 送信と失敗時の扱い

- 既存の権限・店舗範囲検証を通過した場合だけメールを送信します。招待の承諾にも確認済みの同一メールアドレスが必要です。
- メール送信は招待作成トランザクションの最後に行います。SESリクエストは10秒で打ち切り、自動再試行はしません。失敗時には新規作成・以前の招待の取消・監査記録がロールバックされます。
- 生トークンはメール内URLのフラグメントにだけ含めます。DBにはハッシュを保存し、API応答・監査・エラーログに生トークンやメール本文を出しません。
- SES受付直後のDBコミット失敗など、外部送信とDBを完全に一体化できない境界ではメールが届いても承諾できない場合があります。その場合は改めて招待します。送信の自動再試行や過去の招待の一括再送はしません。
- SESの受付をもって画面に送信完了を表示します。配達・バウンス・開封を追跡する機能は含みません。

## 確認

1. `npm run typecheck`、`npm run test:operations`、デプロイのPythonテストを実行します。テストのメール送信はモックで、実際の受信者へは送信しません。
2. 専用送信元の検証・本番アクセス・シークレット注入を確認してから、APIとWebを同じコミットで反映します。
3. 管理者が指定したテスト宛先へ1件招待し、差出人、店舗、役割、期限、承諾と再承諾拒否を確認します。実際のメール送信と受信は、本番確認として別途記録します。

参考: [SES SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)、[SESサンドボックスと本番アクセス](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)。
