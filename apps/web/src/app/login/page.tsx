import { CalendarCheck } from "lucide-react";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authBrand"><CalendarCheck size={30} /><strong>SalonOps</strong></div>
        <h1>サロン管理へログイン</h1>
        <p>管理者から案内されたアカウントでログインしてください。</p>
        <LoginForm />
      </section>
    </main>
  );
}
