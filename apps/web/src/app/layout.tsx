import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SalonOps Reservation Console",
  description: "Reservation operations console for LINE-first salons"
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
