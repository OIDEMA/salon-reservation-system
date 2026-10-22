import Image from "next/image";
import { PasswordResetRequestForm } from "@/components/password-reset-request-form";

export default function PasswordResetPage() {
  return (
    <main className="authPage">
      <section className="authCard authResetCard">
        <div className="authLogo">
          <Image
            src="/brand/beauty-gum-wordmark.webp"
            alt="株式会社Beauty Gum"
            width={308}
            height={70}
            preload
          />
        </div>
        <h1>パスワードの初回設定・再設定</h1>
        <p>初めて利用する方も、パスワードをお忘れの方も、登録済みのメールアドレスを入力してください。メール内のリンクからパスワードを設定できます。</p>
        <PasswordResetRequestForm />
      </section>
    </main>
  );
}
