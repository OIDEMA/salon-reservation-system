import Image from "next/image";
import { PasswordResetRequestForm } from "@/components/password-reset-request-form";

export default function PasswordResetPage() {
  return (
    <main className="authPage">
      <section className="authCard authResetCard">
        <div className="authLogo">
          <Image
            src="/brand/beauty-gum-logo.webp"
            alt="株式会社Beauty Gum"
            width={400}
            height={100}
            preload
          />
        </div>
        <h1>パスワードリセット</h1>
        <p>登録済みのメールアドレスに、パスワード再設定用のメールを送信します。</p>
        <PasswordResetRequestForm />
      </section>
    </main>
  );
}
