import type { Metadata } from "next";
import { Cormorant_Garamond, IBM_Plex_Mono } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import { WalletProvider } from "@/components/WalletProvider";
import { Navigation } from "@/components/Navigation";
import "./globals.css";

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-plex-mono",
});

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["italic", "normal"],
  variable: "--font-cormorant-garamond",
});

export const metadata: Metadata = {
  title: "SBT Membership Protocol",
  description: "On-chain membership with soulbound tokens, tier-based epoch rewards, and gasless ERC-4337 claims.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${ibmPlexMono.variable} ${cormorantGaramond.variable}`}>
      <body>
        <WalletProvider>
          <Navigation />
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}