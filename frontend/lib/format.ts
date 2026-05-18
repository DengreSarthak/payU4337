export function formatShortAddress(address?: string | null): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortenHex(hex?: string | null): string {
  if (!hex || hex === "—") return "—";
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export function formatEpoch(epoch?: bigint | string | number | null): string {
  if (epoch === undefined || epoch === null) return "—";
  return typeof epoch === "bigint" ? epoch.toString() : String(epoch);
}

export function formatTokenId(tokenId?: bigint | string | number | null): string {
  if (tokenId === undefined || tokenId === null) return "—";
  return typeof tokenId === "bigint" ? tokenId.toString() : String(tokenId);
}

export function asPrettyJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}
