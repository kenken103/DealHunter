import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DealHunter｜面談・入場予定",
  description: "営業担当者のSES面談・初回入場予定を確認するデモです。",
  robots: { index: false, follow: false },
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
