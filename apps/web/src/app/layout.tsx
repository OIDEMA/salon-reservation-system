import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SalonOps",
  description: "サロン向けマルチテナント予約管理SaaS"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
