import Image from "next/image";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authLogo">
          <Image
            src="/brand/beauty-gum-logo.webp"
            alt="株式会社Beauty Gum"
            width={400}
            height={100}
            preload
          />
        </div>
        <h1>サロン管理へログイン</h1>
        <LoginForm />
      </section>
    </main>
  );
}
