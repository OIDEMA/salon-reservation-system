import Image from "next/image";
import { AuthActionForm } from "@/components/auth-action-form";

type AuthActionPageProps = {
  searchParams?: Promise<{
    mode?: string;
    oobCode?: string;
  }>;
};

export default async function AuthActionPage({ searchParams }: AuthActionPageProps) {
  const params = await searchParams;

  return (
    <main className="authPage">
      <section className="authCard authActionCard">
        <div className="authLogo">
          <Image
            src="/brand/beauty-gum-logo.webp"
            alt="株式会社Beauty Gum"
            width={400}
            height={100}
            preload
          />
        </div>
        <h1>パスワードの再設定</h1>
        <p>新しいパスワードを設定してください。</p>
        <AuthActionForm mode={params?.mode} oobCode={params?.oobCode} />
      </section>
    </main>
  );
}
