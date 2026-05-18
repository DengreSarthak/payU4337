"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

const links = [
  { href: "#wallets", label: "01 overview" },
  { href: "#implement", label: "02 protocol" },
  { href: "#compute", label: "03 actions" },
  { href: "#log", label: "04 log" },
];

export function Navigation() {
  return (
    <header className="site-nav">
      <a className="site-mark" href="#top" aria-label="Membership protocol home">
        <span className="site-mark-accent">SBT</span>
        <span>MEMBER</span>
        <em>protocol</em>
      </a>

      <nav className="site-links" aria-label="Section navigation">
        {links.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>

      <div className="site-wallet">
        <ConnectButton.Custom>
          {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
            const ready = mounted && account && chain;

            if (!ready) {
              return (
                <button className="wallet-button" type="button" onClick={() => openConnectModal()}>
                  connect wallet
                </button>
              );
            }

            if (chain.unsupported) {
              return (
                <button className="wallet-button" type="button" onClick={() => openChainModal()}>
                  wrong network
                </button>
              );
            }

            return (
              <button className="wallet-button" type="button" onClick={() => openAccountModal()}>
                <span className="wallet-dot" />
                <span>{account.displayName}</span>
                <span className="wallet-chain">{chain.name}</span>
              </button>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </header>
  );
}
