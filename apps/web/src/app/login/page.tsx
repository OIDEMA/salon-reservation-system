import { CalendarCheck } from "lucide-react";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authBrand"><CalendarCheck size={30} /><strong>SalonOps</strong></div>
        <h1>サロン管理へログイン</h1>
        <p>テナントごとにデータと権限を分離して管理します。</p>
        <LoginForm />
      </section>
    </main>
  );
}
