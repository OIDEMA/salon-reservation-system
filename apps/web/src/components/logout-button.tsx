"use client";

export function LogoutButton() {
  async function logout() {
    await fetch("/api/session", { method: "DELETE" });
    window.location.assign("/login");
  }

  return <button className="logoutButton" type="button" onClick={logout}>ログアウト</button>;
}
