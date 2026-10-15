import Image from "next/image";
import { AuthActionForm } from "@/components/auth-action-form";

type AuthActionPageProps = {
  searchParams?: Promise<{
    mode?: string;
    oobCode?: string;
    firebaseLink?: string;
  }>;
};

function actionParams(params?: { mode?: string; oobCode?: string; firebaseLink?: string }) {
  let mode = params?.mode;
  let oobCode = params?.oobCode;

  if ((!mode || !oobCode) && params?.firebaseLink) {
    try {
      const firebaseLink = new URL(params.firebaseLink);
      mode ||= firebaseLink.searchParams.get("mode") ?? undefined;
      oobCode ||= firebaseLink.searchParams.get("oobCode") ?? undefined;
    } catch {
      // The form below shows a localized invalid-link message.
    }
  }

  return { mode, oobCode };
}

export default async function AuthActionPage({ searchParams }: AuthActionPageProps) {
  const params = await searchParams;
  const action = actionParams(params);

  return (
    <main className="authPage">
      <section className="authCard authActionCard">
        <div className="authLogo">
          <Image
            src="/brand/beauty-gum-wordmark.webp"
            alt="株式会社Beauty Gum"
            width={308}
            height={70}
            preload
          />
        </div>
        <h1>パスワードの再設定</h1>
        <p>新しいパスワードを設定してください。</p>
        <AuthActionForm mode={action.mode} oobCode={action.oobCode} />
      </section>
    </main>
  );
}
