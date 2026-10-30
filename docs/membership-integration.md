# 会員証とサロン会計の連携

2026年10月30日更新。Webのサロン会計画面、会員iOS、スタッフiOSをSalon Reserveの共通APIへ接続する。会員証・ポイントはテナントごとに分離する。本番導入では以下の順序と確認を行い、ソースの実装だけで反映完了と判断しない。[GCPの安全設計と未実施事項](membership-security.md)も参照する。

## 店頭操作

会計画面で「会員証を読み取る」を開き、13桁の会員番号、外部キーボード型バーコードリーダー、または対応ブラウザのカメラを使って照会する。カメラ非対応や権限拒否時は番号入力で続行できる。会員名、テナント専用の会員番号・残高、現在店舗のポイント履歴を表示する。会員証とポイントはテナントごとに分離し、同じ本人が別テナントへ登録した場合も別会員証・別残高とする。

「ポイントを使いますか？」という質問や使用／不使用のボタンは置かない。スタッフがお客様へ口頭で確認し、利用ポイントを入力する。初期値0は利用なし、100以上は100ポイント単位で利用する。1ポイント＝1円、100ポイント＝100円単位。上限は最新の利用可能残高と通常値引き後の金額から求める。

会員証と店舗顧客が未連携の場合は、ご本人を確認したチェックと明示的な連携ボタンが必要。既存の別会員とのリンクは上書きしない。氏名・電話番号の一致で顧客や予約権限を自動的に移さない。

利用ポイントは通常値引き後の金額から差し引き、既存の明細配賦・内税計算・受領済み支払内訳・領収書に反映する。会員確認や下書き保存では台帳を減らさない。会計確定時に会員・店舗権限・最新残高を検証して利用と付与を記録する。付与はポイント利用後の支払額100円につき5ポイント。入金済み予約に後からポイント値引きを足すことは受け付けない。

取消時は利用分を元の会員へ返し、同じ会計の付与分を取り消す。使用済みの付与ポイントを取り消して負残高になっても、会計の取消自体は止めない。利用可能ポイントを0として保持し、履歴で増減を追えるようにする。

## API

| API | 認証・目的 |
| --- | --- |
| `POST /api/membership/lookup` | スタッフの店舗権限。`barcode` と対象 `checkoutId` または `reservationId` で照会 |
| `POST /api/admin/customers/:id/membership-link` | 顧客編集権限。barcode・expectedMemberId・confirmed=trueで本人確認後に連携 |
| `GET /api/admin/customers/:id/membership` | 顧客／会計の権限を満たした店舗から連携済み会員を参照 |
| `GET /api/member/membership/programs` | Firebase本人認証。公開参加先と本人の登録済み履歴参照先だけを返す |
| `POST /api/member/membership` | Firebase本人認証。programId・displayNameのみで本人の会員証をサーバー自動発行 |
| `GET /api/member/membership?programId=...` | Firebase本人認証。本人の残高・直近50件のポイント／会計履歴 |
| `GET /api/staff/mobile/context` | Firebaseスタッフ認証。有効な所属会社・許可店舗・権限だけを返す |
| `POST /api/staff/mobile/targets` | 明示した会社・店舗をDBで再認可し、権限内の予約／会計候補を返す |
| Web `/api/staff-handoff` GET/POST | ブラウザsessionの最新所属・対象会計を再検証し、CSRF保護付き明示POSTで店舗を選択して会計へ移動 |

会計APIは既存の作成・下書き保存・確定・全額取消へ組み込んでいる。下書きの `membershipAccountId`、`pointsToUse`、`pointPolicyVersion` と内部のUSE/SKIP識別を保存し、円値引きはサーバーで算定する。旧APIクライアントが会員フィールドを省略しても、保存済みの会員連携を黙って解除しない。旧確定会計や従来のポイント円値引きの記録は書き換えず、実際の台帳消費へ自動変換しない。

APIはprivate/no-storeで応答する。会員番号・トークンはURLやログに含めず、認証された担当者・店舗・会員内部ID・会計IDを監査に残す。照会回数はDBで制限し、複数Cloud Runインスタンスでカウンターを共有する。

## 導入順序

1. 別の検証環境でスキーマと会員番号・台帳のDB不変条件を適用する。`prisma:deploy` は採番sequenceの確認、Prismaの追加スキーマ、DB triggerの順に適用する。既存番号や残高を採番し直さない。
2. 管理者がテナント専用のMembershipProgramを作り、既存テナント1件だけに明示的に割り当てる。各テナントに別のprogram UUIDを指定し、複数テナントで同じprogramを共有しない。未設定テナントは503の設定待ちとし、別企業の会員データやサンプルへ切り替えない。
3. 共通APIとWebを同じソースのリリースとして適用する。旧会計の再表示・通知・領収書を検証する。
4. 会員iOSに `EXPO_PUBLIC_MEMBERSHIP_API_URL` をHTTPSで設定する。本人Firebase Tokenで公開先・本人の登録済み先を取得し、複数なら利用者が選ぶ。`EXPO_PUBLIC_MEMBERSHIP_PROGRAM_ID` は特定サービスへ固定する場合だけの任意設定。設定の欠落・障害時にローカル会員へ切り替えない。スタッフiOSは `EXPO_PUBLIC_STAFF_MODE=salon`、`EXPO_PUBLIC_STAFF_API_URL` と同じFirebase公開設定を使い、所属会社・許可店舗をサーバーから取得する。
5. 会員iOSで本人が会員証を発行する。番号はDBの13桁sequenceから自動発行され、クライアントは選択できない。旧PGliteのサンプル会員・残高は自動移行しない。
6. 店頭で本人確認を伴うリンクを登録し、会計・利用・付与・取消・会員画面への反映を隔離データで確認する。

スタッフiOSは会社・店舗と対象のお客様／会計を明示してから会員証を照会し、利用ポイントを既存会計の下書きへ保存する。単独の来店登録・ポイント付与APIを呼ばず、確定は既存のWeb会計へ集約する。Web側の選択店舗が違っていても安全なhandoffで最新権限を再確認する。URLへ認証Token・会員番号・氏名を埋め込まない。会社変更・logout・403の権限取消では古い会員／会計画面と通信を破棄する。

App Attest / App Check、DB側のTLS強制、署名済み配布ビルドの実機カメラ・実HID機器確認は導入後も追跡する。GCPのFirebase Tokenを従来のSupabase Tokenとして渡してはいけない。GCP選択時に旧ローカル／Supabase接続へ切り替えない。

## ローカル検証

```sh
npm run typecheck
npm run test:operations
OPERATIONS_TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/LOCAL_test' \
  npm run test:operations:db -w @reservation-system/api
```

DBテストは明示したローカルの末尾 `_test` DBだけを使う。実際のFirebase／メール送信は模擬し、実PostgreSQLの権限・店舗境界・トランザクション・同時利用・再送・取消・失敗時の全ロールバックを確認する。会計と台帳の間に外部サービス呼び出しを挟まず、再試行可能なSerializable競合だけをrollback後に限定再実行する。

## 既存テナントの参加設定CLI

`membership:provision` は既存テナント1件だけを対象にする管理コマンドで、既定は読み取りのみのdry-run。管理環境に `DATABASE_URL` と `MEMBERSHIP_PROVISION_OWNER_UID` を設定し、安定した明示program UUID・名称・承認済みtenant slug 1件を完全指定する。省略による全テナント選択、複数テナント、ワイルドカード、重複指定は受け付けない。テナントごとに別のUUIDを使い、2件目の設定も別のdry-runと確認付きapplyで行う。

```sh
npm run build -w @reservation-system/api
npm run membership:provision -w @reservation-system/api -- \
  --program-id="$MEMBERSHIP_PROGRAM_UUID" \
  --program-name="$MEMBERSHIP_PROGRAM_NAME" \
  --tenant-slug="$MEMBERSHIP_TARGET_TENANT_SLUG"
```

出力は対象DBのfingerprint、program・tenant 1件の設定だけを含むplan v2と `confirmationHash`。実行者のUID・氏名・メール・DB接続値・会員個人情報は出力しない。planを確認してから、同じ引数へ `--apply --confirm-hash="$MEMBERSHIP_CONFIRMATION_HASH"` を明示追加する。DB・対象tenant・権限・既存設定が変わった場合は拒否するので、dry-runからやり直す。旧複数テナント形式のplan/hashは受け付けない。

CLIはGCPの管理実行者のIAM権限と、管理用DB接続を保護した実行環境の下で使う。入力UID自体は実行者の本人認証ではなく、追加の誤操作防止・監査対象の指定である。DB上の無効でないAppUserと、指定tenantのACTIVE OWNER membership、ACTIVE tenantを確認する。他テナントのOWNER権限を持つ必要はない。UIDを知っているだけでAPI利用者が実行できるエンドポイントは設けない。

applyは対象行をlockし、Serializableの同じトランザクションで最新のplan/hashを再検証し、program作成・未割当tenantへの設定・監査を一括反映する。新programのslugはUUID由来の安定値。既存programは有効状態と名称が一致し、他tenantが使用していない場合だけ再利用する。実行者が両テナントのOWNERでもprogramの共有は拒否する。名称変更・再有効化・別programへの付け替えは行わない。同じtenantへ同じprogramを再適用する場合は変更せず、監査も重複作成しない。競合時の自動再試行はせず、新しいdry-runで確認する。

新規tenant・顧客・会員・予約所有権リンク・ポイントは作らず、残高の移行も行わない。予約公開用 `MEMBER_BOOKING_TENANTS` を自動追加・変更しない。会員アプリへ新規参加先として公開されるのは、その公開allowlist・ACTIVE tenant・明示program割当・有効programの条件をすべて満たす場合だけである。既存 `tenant:provision` は会社やOWNERを新規作成する別コマンドなので、今回の参加設定へ流用しない。このCLIの追加は本番実行、App Check強制、DB TLS強制、GCP設定変更を含まない。
