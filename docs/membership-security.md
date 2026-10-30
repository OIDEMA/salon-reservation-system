# 会員バーコード・ポイント連携のGCP安全設計

2026年10月30日、新リリース前の実装・検査状況。会員証とポイントはテナントごとに分離する。同じ本人が別テナントへ登録しても、会員証・残高・履歴を共有しない。会員iOS、スタッフiOS、Salon ReserveのWebはFirebase AuthenticationとCloud Run APIを利用し、会計と台帳は同じCloud SQLで原子的に更新する。

既存Salon Reserveの本番認証・API・DB接続は稼働中。新しい会員連携ソースのリリースと、テナント別program設定はこれから行う。実装済みと本番反映済みを区別し、既存顧客・サンプル会員・残高は自動移行しない。

## 実装と本番反映の状態

| 項目 | 状態 |
| --- | --- |
| 会員iOS | Firebase本人認証、テナント別の会員証・残高・履歴・会員登録API接続を実装済み。新APIへの本番接続はリリース後に確認 |
| スタッフiOS | GCP/Firebase認証、所属・店舗・対象会計の選択、バーコード照会、明示的顧客リンク、ポイント下書き、安全なWeb引継ぎを実装済み。本番接続は未確認 |
| API・Web・DB制約 | テナント分離、店舗権限、会計/台帳の原子的更新、再送・同時利用・取消を実装。実PostgreSQL、DB guard、旧schemaからの既存Tenant保持、型チェック、Web buildを検証済み。新リリース待ち |
| 専用program設定 | 1テナント・1program制約とdry-run/確認hash付き管理CLIを実装。本番作成・割当は未実施 |
| 依存関係 | High対策でZodを4.6.7へ更新し、今回の3系統の依存関係監査はいずれも指摘0件。更新ソースの本番適用は新リリース後に確認 |
| App Check / 配布実機 | App Check・App Attestの実機トークン生成/API検証/本番強制、署名した配布ビルド、実機カメラ/HID、TestFlightでの一連の確認は未実施 |

## テナントと権限の境界

`Tenant.membershipProgramId` はuniqueで、各テナントに専用 `MembershipProgram` を1件割り当てる。他テナントとのprogram共有はできない。会員登録後のprogram切離・別テナントへの再割当・所属テナント削除をDB guardで拒否する。会員作成には所属テナントが必要で、13桁の番号はサーバー採番と不変条件で保護する。

会員APIは検証済みFirebase project・UIDと選択programから本人の台帳を解決する。スタッフAPIはさらに、無効でないAppUser、ACTIVEな所属、店舗範囲、操作権限をリクエストと確定トランザクションで確認する。ID・ヘッダー・バーコードは対象の選択情報であり、権限を与えない。他テナントの会員番号やSupabase資格情報でFirebaseスタッフ権限を取得できない。

公開参加先は、`MEMBER_BOOKING_TENANTS` の公開allowlist、有効テナント、専用programの明示割当、有効programの条件を満たす範囲に限定する。管理CLIは既存テナント1件とそのACTIVE OWNERを確認し、dry-runと同じplan/hashのapplyだけで作成・割当・監査をSerializableで一括反映する。両テナントのOWNERでもprogram共有を許可しない。入力OWNER UID自体は本人認証ではなく、保護されたGCP/IAM管理環境での追加境界・監査対象指定として扱う。

店舗顧客の `MembershipCustomerLink` は予約所有者の `MemberCustomerLink` と別に保持する。氏名・電話番号で自動連携せず、会員リンクを予約権限へ転用しない。スタッフへ返す詳細履歴は許可店舗に限定する。

## アプリと会計の安全な接続

アプリに持たせるのは公開API URLとFirebase公開設定だけ。DB接続値・サービスアカウント鍵・管理用固定APIキーは含めない。Cloud Runは実行用SA/ADCと固定バージョンのSecret参照を使う。認証付き通信はHTTPS限定、リダイレクト禁止、private/no-storeとする。会員用/スタッフ用の保存キー・Keychain serviceを分け、refresh資格情報はSecureStore、アクセストークンはメモリで扱い、パスワードは保存しない。

GCP接続モードでは障害や設定不足をローカル/Supabase試作への自動切替で隠さない。ログアウトや会社・店舗切替で古い通信結果を無効化する。バーコードはPOST本文で送り、認証情報・会員番号はログから秘匿する。利用回数制限はDBで共有し、監査に担当者・店舗・会計・内部会員ID・要求IDを残す。

スタッフiOSはポイントを会計下書きへ保存し、支払確認と確定はWeb会計へ引き継ぐ。URLに認証トークンや会員番号を入れず、ブラウザ側のログイン・店舗・対象会計への権限を再確認する。GETでは確認画面を表示し、同一Originの確認POSTで店舗選択Cookieを更新する。URLを開くだけでは会計やポイントを変更せず、WebのSecure/HttpOnly CookieをiOSへコピーしない。

ポイント入力は初期値0、1ポイント＝1円、100ポイント単位。質問や使用/不使用ボタンは置かない。読取・下書きでは減算せず、確定時に会員行と権限をロックし、専用program・顧客リンク・最新残高・上限を再検証する。利用仕訳・会計確定・支払額100円につき5ポイントの付与を同一トランザクションで保存し、再送を二重処理しない。取消は利用返還と付与取消を一度だけ行い、停止会員/programでも返還を妨げない。使用済み付与の取消で負残高になれば利用可能額を0とする。入金済み予約への新たなポイント利用と、旧円値引き記録の実ポイントへの自動変換は行わない。

## 2026年10月30日の本番観測

gcloud再認証の回復後、構成メタデータと一時read-only jobの限定SELECTを確認した。jobは既存APIのimmutable image、同じruntime SA、固定Secret参照、同じDirect VPCを使用。実顧客・予約・会員行は読まず、UID・メール・DB接続値・秘密値をログへ出していない。

| 項目 | 観測値・確認範囲 |
| --- | --- |
| GCP / 既存Web | `salon-reserve-bg`、`https://salon-reserve.beauty-gum.jp/login` が応答。既存システムは稼働中 |
| API | `reservation-api` / `asia-northeast1`、稼働revision `reservation-api-00013-j2t` |
| 実行ID / DB参照 | `reservation-api-runtime`、`reservation-database-url-tokyo:1` |
| ネットワーク / DB | `salon-reserve-vpc` / `salon-reserve-run-asia-northeast1`、Direct VPC、`private-ranges-only`、非公開Cloud SQL `salon-reserve-db-tokyo` |
| 対象テナント | `mens-gentle` / `missmrs-takamatsu` はACTIVE、有効OWNER各1人。各テナントに別programを設定する |
| DBのTLS設定 | `sslMode=ALLOW_UNENCRYPTED_AND_ENCRYPTED` を再確認。DBで暗号化を強制する変更は未実施 |
| 検査接続 | 同じSA/SecretのPrisma接続でTLS 1.3 / AES256を実測 |
| 全体SSL集計 | `ssl=true` 2接続 / `ssl=false` 2接続。role未分類で、非暗号化接続が内部platform用途かは未確定。全接続TLSは保証できない |
| 新会員連携 | 新API/Webのリリースとテナント別programの本番設定は未実施。両iOSの本番での一連の確認はその後に行う |

## 導入前に残る確認

- 新API/Webのimage digest・revision・schema/invariants・readyを確認し、テナント別programを各1件のdry-run/確認付きapplyで設定する。旧会計・通知・領収書・再送・取消を検証する。mainへのpushは自動本番デプロイを起動する。
- DBのTLS強制は未実施。検査接続のTLS成功やprivate IPだけで全接続保護済みとはしない。API・schema job・メールworker・管理CLI等の暗号化と証明書検証、非暗号化接続の用途を確認してから強制する。SQL設定変更は新規接続に作用するため既存接続の排出も確認する。
- App Check/App Attestは実機生成とAPI検証を実装し、署名した配布ビルドで計測してから強制する。送信拡張点やヘッダー秘匿、Expo Goの成功を実機検証の代替にしない。既存Webの検証経路も整え、強制化で停止させない。Firebase認証・店舗認可・再送防止は引き続き必要。
- 実機カメラ/HID、Keychain復元・失効・テナント切替・Web引継ぎ、スタッフ招待/MFA/紛失端末対応、バックアップ/PITR/隔離復元を確認する。ローカルテスト成功は本番復旧や複数インスタンスの負荷検証の代替ではない。
- Cloud Armor等は未導入として扱う。導入時は旧relayやrun.appからの迂回も確認する。既存Domain Mappingだけで適用済みとは判断しない。

[導入手順と管理CLI](membership-integration.md)も参照する。新リリース、専用program設定、署名実機、App Check強制、DB TLS強制は、各完了を確認して状態を更新する。

## 公式資料

- [Cloud Runの利用者認証](https://docs.cloud.google.com/run/docs/authenticating/end-users)
- [Cloud SQLのTLS強制と既存接続](https://docs.cloud.google.com/sql/docs/postgres/configure-ssl-instance)
- [Cloud SQL Node ConnectorのPrisma対応](https://raw.githubusercontent.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/main/README.md)
- [Appleアプリから独自APIへApp Checkを送信](https://firebase.google.com/docs/app-check/ios/custom-resource)
- [独自バックエンドでのApp Check検証](https://firebase.google.com/docs/app-check/custom-resource-backend)
- [ExpoのFirebase/ネイティブSDK制約](https://docs.expo.dev/guides/using-firebase/)
