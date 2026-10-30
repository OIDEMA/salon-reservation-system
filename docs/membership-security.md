# 会員バーコード・ポイント連携のGCP安全設計

2026年10月30日の構成・実装・検査状況。会員証とポイントはテナントごとに分離する。同じ本人が別テナントへ登録しても、会員証・残高・履歴を共有しない。会員iOS、スタッフiOS、Salon ReserveのWebはFirebase AuthenticationとCloud Run APIを利用し、会計と台帳は同じCloud SQLで原子的に更新する。

会員連携の初回リリース `e55a7fbf86bdf50925dc19adb933c187295a8143` はCloud Build `4301dad7-8504-4c2f-8123-0c93fee78448` で本番反映済み。テナント別programもdry-run/確認hash付きapplyと再読取を完了した。本変更のGoogleログイン・default realm検証は追加リリース対象として、デプロイ結果を別途確認する。既存顧客・サンプル会員・残高は自動移行しない。

## 実装と本番反映の状態

| 項目 | 状態 |
| --- | --- |
| 会員iOS | Firebase本人認証、テナント別の会員証・残高・履歴・会員登録API接続を実装済み。実APIのHTTPS設定で専用シミュレーターへビルド・起動済み。実アカウントによる一連の操作は未確認 |
| スタッフiOS | GCP/Firebase認証、所属・店舗・対象会計の選択、バーコード照会、明示的顧客リンク、ポイント下書き、安全なWeb引継ぎを実装済み。実APIのHTTPS設定で専用シミュレーターを起動し、スタッフログイン画面を確認。実アカウントによる一連の操作は未確認 |
| Google認証の追加 | `salon-reserve-bg` のGoogle provider有効化、会員/スタッフ両iOS登録と同projectの公開client ID照合は実施済み。両ネイティブビルドは0 error。Google→Firebase交換とdefault realmのAPI制約は追加ソースのリリース対象で、実アカウントのログイン・配布実機での確認は未実施 |
| API・Web・DB制約 | テナント分離、店舗権限、会計/台帳の原子的更新、再送・同時利用・取消を実装。実PostgreSQL、DB guard、旧schemaからの既存Tenant保持、型チェック、Web buildを検証済み。初回会員連携リリースのAPI/Webはready・ログイン画面と未認証拒否を確認 |
| 専用program設定 | 1テナント・1program制約とdry-run/確認hash付き管理CLIを実装。`mens-gentle` / `missmrs-takamatsu` に異なる有効programを作成・割当し、再読取済み |
| 依存関係 | High対策でZodを4.6.7へ更新し、Salon側3系統の依存関係監査はいずれも指摘0件。初回会員連携リリースの本番imageへ適用済み。別リポジトリのiOS開発ツールの監査とは区別する |
| App Check / 配布実機 | App Check・App Attestの実機トークン生成/API検証/本番強制、署名した配布ビルド、実機カメラ/HID、TestFlightでの一連の確認は未実施 |

## テナントと権限の境界

`Tenant.membershipProgramId` はuniqueで、各テナントに専用 `MembershipProgram` を1件割り当てる。他テナントとのprogram共有はできない。会員登録後のprogram切離・別テナントへの再割当・所属テナント削除をDB guardで拒否する。会員作成には所属テナントが必要で、13桁の番号はサーバー採番と不変条件で保護する。

会員APIは検証済みFirebase project・UIDと選択programから本人の台帳を解決する。スタッフAPIはさらに、無効でないAppUser、ACTIVEな所属、店舗範囲、操作権限をリクエストと確定トランザクションで確認する。ID・ヘッダー・バーコードは対象の選択情報であり、権限を与えない。他テナントの会員番号やSupabase資格情報でFirebaseスタッフ権限を取得できない。

会員・スタッフ両iOSは同じFirebase project `salon-reserve-bg`（project number `42401528382`）のdefault user poolを共用し、メール/パスワードとGoogle認証を利用する。Salon DBの企業テナントとIdentity Platformの認証tenantは別概念で、APIはSDKの署名・project・失効検証後に `firebase.tenant` の非default値を拒否し、別認証realmの同じUIDをAppUserや会員へ解決しない。スタッフのsession cookie/ID tokenと会員ID tokenの全経路へ適用し、cookieのrealm拒否ではID tokenへのfallbackを行わない。Googleログイン成功だけでは所属会社・店舗・role/permissionを付与せず、既存のDB認可を通す。メール一致によるアプリ側のUIDマージや企業・顧客・予約の自動リンクは行わない。

公開参加先は、`MEMBER_BOOKING_TENANTS` の公開allowlist、有効テナント、専用programの明示割当、有効programの条件を満たす範囲に限定する。管理CLIは既存テナント1件とそのACTIVE OWNERを確認し、dry-runと同じplan/hashのapplyだけで作成・割当・監査をSerializableで一括反映する。両テナントのOWNERでもprogram共有を許可しない。入力OWNER UID自体は本人認証ではなく、保護されたGCP/IAM管理環境での追加境界・監査対象指定として扱う。

店舗顧客の `MembershipCustomerLink` は予約所有者の `MemberCustomerLink` と別に保持する。氏名・電話番号で自動連携せず、会員リンクを予約権限へ転用しない。スタッフへ返す詳細履歴は許可店舗に限定する。

## アプリと会計の安全な接続

アプリに持たせるのは公開API URLとFirebase公開設定だけ。DB接続値・サービスアカウント鍵・管理用固定APIキーは含めない。Cloud Runは実行用SA/ADCと固定バージョンのSecret参照を使う。認証付き通信はHTTPS限定、リダイレクト禁止、private/no-storeとする。会員用/スタッフ用の保存キー・Keychain serviceを分け、refresh資格情報はSecureStore、アクセストークンはメモリで扱い、パスワードは保存しない。

Google SDKのID tokenは固定HTTPSの `accounts:signInWithIdp` へ `google.com` providerで交換し、FirebaseのUIDを本人識別に使う。Google credentialは保存せず、Firebase ID tokenと `accounts:lookup` のUID一致を確認してからFirebase refresh tokenだけをSecureStoreへ保存する。公式仕様の `returnRefreshToken:false` はIdPの `oauthRefreshToken` の返却抑制で、`returnSecureToken:true` によるFirebase `refreshToken` と別である。Firebase refresh tokenが欠けた場合はGoogleのものへ代替せず失敗とする。これは公式API契約と単体テストで確認した範囲であり、実Googleアカウントによる交換・更新の完走は未確認。ログイン世代はSDK起動前に切り替え、ログアウトや別ログイン後に届いたGoogle取得・交換・本人照会の結果を破棄する。アカウント競合時は既存のログイン方法を案内し、credentialの自動リンクを送信しない。

GCP接続モードでは障害や設定不足をローカル/Supabase試作への自動切替で隠さない。ログアウトや会社・店舗切替で古い通信結果を無効化する。バーコードはPOST本文で送り、認証情報・会員番号はログから秘匿する。利用回数制限はDBで共有し、監査に担当者・店舗・会計・内部会員ID・要求IDを残す。

スタッフiOSはポイントを会計下書きへ保存し、支払確認と確定はWeb会計へ引き継ぐ。URLに認証トークンや会員番号を入れず、ブラウザ側のログイン・店舗・対象会計への権限を再確認する。GETでは確認画面を表示し、同一Originの確認POSTで店舗選択Cookieを更新する。URLを開くだけでは会計やポイントを変更せず、WebのSecure/HttpOnly CookieをiOSへコピーしない。

ポイント入力は初期値0、1ポイント＝1円、100ポイント単位。質問や使用/不使用ボタンは置かない。読取・下書きでは減算せず、確定時に会員行と権限をロックし、専用program・顧客リンク・最新残高・上限を再検証する。利用仕訳・会計確定・支払額100円につき5ポイントの付与を同一トランザクションで保存し、再送を二重処理しない。取消は利用返還と付与取消を一度だけ行い、停止会員/programでも返還を妨げない。使用済み付与の取消で負残高になれば利用可能額を0とする。入金済み予約への新たなポイント利用と、旧円値引き記録の実ポイントへの自動変換は行わない。

## 2026年10月30日の本番観測

gcloud再認証の回復後、構成メタデータと一時read-only jobの限定SELECTを確認した。jobは既存APIのimmutable image、同じruntime SA、固定Secret参照、同じDirect VPCを使用。実顧客・予約・会員行は読まず、UID・メール・DB接続値・秘密値をログへ出していない。

| 項目 | 観測値・確認範囲 |
| --- | --- |
| GCP / 既存Web | `salon-reserve-bg`、`https://salon-reserve.beauty-gum.jp/login` が応答。既存システムは稼働中 |
| API | `reservation-api` / `asia-northeast1`、会員連携初回releaseのrevision `reservation-api-00014-wb4`（Web `salon-reserve-web-00015-sll`） |
| 実行ID / DB参照 | `reservation-api-runtime`、`reservation-database-url-tokyo:1` |
| ネットワーク / DB | `salon-reserve-vpc` / `salon-reserve-run-asia-northeast1`、Direct VPC、`private-ranges-only`、非公開Cloud SQL `salon-reserve-db-tokyo` |
| 対象テナント | `mens-gentle` / `missmrs-takamatsu` はACTIVE、有効OWNER各1人。各テナントに別の有効programを作成・割当・再読取済み |
| DBのTLS設定 | `sslMode=ALLOW_UNENCRYPTED_AND_ENCRYPTED` を再確認。DBで暗号化を強制する変更は未実施 |
| 検査接続 | 同じSA/SecretのPrisma接続でTLS 1.3 / AES256を実測 |
| 全体SSL集計 | `ssl=true` 2接続 / `ssl=false` 2接続。role未分類で、非暗号化接続が内部platform用途かは未確定。全接続TLSは保証できない |
| 新会員連携 | 初回API/Web releaseとテナント別programの本番設定は実施済み。両iOSのGoogle SDK入りnative buildも成功。実ユーザー認証後の会員発行・会計一連の操作は未代行 |

## 残る確認

- Google/default realm追加releaseのimage digest・revision・readyを確認する。実アカウントでのGoogle認証、テナント別会員発行とスタッフ側の対象確認を行う。実会計・通知等の業務操作は店舗担当者と確認する。mainへのpushは自動本番デプロイを起動する。
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
- [Firebase/Identity PlatformのIdP交換とrefresh tokenの区別](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithIdp)
- [Firebase project検証と認証tenantの認可](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy-managing-tenants#identity_verification)
