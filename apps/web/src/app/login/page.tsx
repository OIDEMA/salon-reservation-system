import Image from "next/image";
import { LoginForm } from "@/components/login-form";
import { safeStaffHandoffReturnTo } from "@/lib/staff-handoff";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const returnTo = safeStaffHandoffReturnTo((await searchParams).returnTo);
  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authLogo">
          <Image
            src="/brand/beauty-gum-wordmark.webp"
            alt="株式会社Beauty Gum"
            width={308}
            height={70}
            preload
          />
        </div>
        <h1>サロン管理へログイン</h1>
        <LoginForm returnTo={returnTo} />
      </section>
    </main>
  );
}
