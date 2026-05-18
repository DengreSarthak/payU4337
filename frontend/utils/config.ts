import { scrollSepolia } from "wagmi/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

export const config = getDefaultConfig({
  appName: "Membership Command Center",
  projectId: process.env.NEXT_PUBLIC_PROJECT_ID ?? "8dd54aacfe3cf3db6f8040d9e9a901e4",
  chains: [scrollSepolia],
  ssr: true,
});
