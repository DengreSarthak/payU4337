"use client";

import { AbiCoder, BrowserProvider, Contract, JsonRpcProvider, getBytes, isAddress, keccak256, parseEther } from "ethers";
import { useEffect, useState } from "react";
import { parseAbi } from "viem";
import { useAccount, useChainId } from "wagmi";
import { useWalletClient } from "wagmi";
import {
  DISTRIBUTOR_ROLE,
  ENTRY_POINT_ABI,
  MEMBERSHIP_SBT_ABI,
  MINTER_ROLE,
  REVOKER_ROLE,
  PAYMASTER_ABI,
  REWARDS_ABI,
  SMART_ACCOUNT_FACTORY_ABI,
  TIER_NAMES,
  tierNameFromValue,
} from "@/lib/contracts";
import { asPrettyJson, formatEpoch, formatShortAddress, formatTokenId, shortenHex } from "@/lib/format";
import { signUserOperation, type UserOperation } from "@/lib/userop";

type DashboardState = {
  owner: string;
  smartAccount: string;
  deployed: boolean;
  tokenId: string;
  tokenStandard: string;
  collectionName: string;
  collectionSymbol: string;
  tokenUri: string;
  walletBalance: string;
  sbtAddress: string;
  tier: string;
  reputation: string;
  currentEpoch: string;
  currentEpochStart: string;
  rewardsPoolAccrued: string;
};

type RewardsConfigState = {
  claimFeeBps: string;
  rewardsBps: string;
  opsBps: string;
  burnBps: string;
  burnSink: string;
  sbtIsV2: boolean;
  tierBpsTotal: string;
  tierBpsValid: boolean;
  tierBpsByTier: string[];
};

type JsonUserOp = UserOperation;

type ActionResult = {
  title: string;
  ok: boolean;
  message: string;
  tenderlyUrl?: string;
  txHash?: string;
  userOp?: JsonUserOp;
};

const abi = AbiCoder.defaultAbiCoder();
const SCROLL_SEPOLIA = 534351;

const emptyState: DashboardState = {
  owner: "",
  smartAccount: "",
  deployed: false,
  tokenId: "—",
  tokenStandard: "ERC-721",
  collectionName: "—",
  collectionSymbol: "—",
  tokenUri: "—",
  walletBalance: "0",
  sbtAddress: "",
  tier: "—",
  reputation: "—",
  currentEpoch: "—",
  currentEpochStart: "—",
  rewardsPoolAccrued: "—",
};

const emptyRewardsConfig: RewardsConfigState = {
  claimFeeBps: "—",
  rewardsBps: "—",
  opsBps: "—",
  burnBps: "—",
  burnSink: "—",
  sbtIsV2: false,
  tierBpsTotal: "—",
  tierBpsValid: false,
  tierBpsByTier: ["—", "—", "—", "—"],
};

function getAddresses() {
  return {
    entryPoint: process.env.NEXT_PUBLIC_ENTRYPOINT_ADDRESS ?? "",
    factory: process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? "",
    paymaster: process.env.NEXT_PUBLIC_PAYMASTER_ADDRESS ?? "",
    sbt: process.env.NEXT_PUBLIC_SBT_ADDRESS ?? "",
    rewards: process.env.NEXT_PUBLIC_REWARDS_ADDRESS ?? "",
    backend: process.env.NEXT_PUBLIC_BACKEND_URL ?? "",
  };
}

function asBigInt(value: string) {
  return BigInt(value || "0");
}

function parseBigIntInput(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Enter a ${label} first.`);
  }
  return BigInt(trimmed);
}

function parseTokenIdList(value: string) {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => BigInt(item));
}

function assertConfiguredAddress(value: string, label: string): `0x${string}` {
  if (!value || !isAddress(value)) {
    throw new Error(`Missing or invalid ${label}. Set it in frontend/.env.local before using the app.`);
  }
  return value as `0x${string}`;
}

function claimDigest(smartAccount: string, tokenId: string, epoch: string): Uint8Array {
  const encoded = abi.encode(["address", "uint256", "uint256"], [smartAccount, BigInt(tokenId), BigInt(epoch)]);
  return getBytes(keccak256(encoded));
}

function previewDigest(smartAccount: string, tokenId: string, epoch: string) {
  try {
    if (!smartAccount || !tokenId || !epoch || tokenId === "—" || epoch === "—") return "—";
    const encoded = abi.encode(["address", "uint256", "uint256"], [smartAccount, BigInt(tokenId), BigInt(epoch)]);
    return keccak256(encoded);
  } catch {
    return "—";
  }
}

export default function Page() {
  const { address: connectedAddress, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient({ chainId });
  const walletAddress = connectedAddress ?? "";
  const [smartAccount, setSmartAccount] = useState("");
  const [salt, setSalt] = useState("0");
  const [mintRecipientEoa, setMintRecipientEoa] = useState("");
  const [adminTokenId, setAdminTokenId] = useState("");
  const [adminReputation, setAdminReputation] = useState("");
  const [adminTier, setAdminTier] = useState("0");
  const [adminTierBps, setAdminTierBps] = useState("");
  const [adminTierBpsTier, setAdminTierBpsTier] = useState("0");
  const [adminTreasuryRewards, setAdminTreasuryRewards] = useState("7000");
  const [adminTreasuryOps, setAdminTreasuryOps] = useState("2000");
  const [adminTreasuryBurn, setAdminTreasuryBurn] = useState("1000");
  const [adminBurnSink, setAdminBurnSink] = useState("");
  const [adminSbtIsV2, setAdminSbtIsV2] = useState(false);
  const [closeEpochTokenIds, setCloseEpochTokenIds] = useState("");
  const [minterAddress, setMinterAddress] = useState("");
  const [paymasterDepositAmount, setPaymasterDepositAmount] = useState("0.2");
  const [distributeTokenId, setDistributeTokenId] = useState("");
  const [distributeEpoch, setDistributeEpoch] = useState("");
  const [revokeHolder, setRevokeHolder] = useState("");
  const [backendHealth, setBackendHealth] = useState<{ ok: boolean; message: string }>({
    ok: false,
    message: "Backend not checked",
  });
  const [state, setState] = useState<DashboardState>(emptyState);
  const [rewardsConfig, setRewardsConfig] = useState<RewardsConfigState>(emptyRewardsConfig);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [copiedDigest, setCopiedDigest] = useState(false);

  async function writeContractAction({
    title,
    address,
    addressLabel,
    abiDefinition,
    functionName,
    args,
    message,
    value,
  }: {
    title: string;
    address: string;
    addressLabel: string;
    abiDefinition: readonly string[];
    functionName: string;
    args: readonly unknown[];
    message: string;
    value?: bigint;
  }) {
    if (!walletClient) {
      throw new Error("Connected wallet client unavailable");
    }
    if (!walletAddress) {
      throw new Error("Connect a wallet first");
    }

    const txHash = await walletClient.writeContract({
      account: walletAddress as `0x${string}`,
      address: assertConfiguredAddress(address, addressLabel),
      abi: parseAbi(abiDefinition as readonly `${string}`[]),
      functionName,
      args: args as never,
      ...(value !== undefined ? { value } : {}),
    });

    setResult({
      title,
      ok: true,
      message,
      txHash,
    });
  }

  async function refresh(
    ownerOverride?: string,
    providerOverride?: BrowserProvider,
    options?: { setLoadingState?: boolean },
  ): Promise<DashboardState | null> {
    const owner = ownerOverride ?? walletAddress;
    if (!owner) return null;

    // Use backend's RPC for reliability instead of MetaMask provider
    const shouldSetLoading = options?.setLoadingState !== false;
    if (shouldSetLoading) setLoading(true);
    try {
      const rpcUrl = "https://sepolia-rpc.scroll.io/";
      const provider = providerOverride ?? new JsonRpcProvider(rpcUrl);
      const { entryPoint, factory, paymaster, sbt, rewards, backend } = getAddresses();
      let entryPointAddress: string;
      let factoryAddress: string;
      let paymasterAddress: string;
      let sbtAddress: string;
      let rewardsAddress: string;

      try {
        entryPointAddress = assertConfiguredAddress(entryPoint, "NEXT_PUBLIC_ENTRYPOINT_ADDRESS");
        factoryAddress = assertConfiguredAddress(factory, "NEXT_PUBLIC_FACTORY_ADDRESS");
        paymasterAddress = assertConfiguredAddress(paymaster, "NEXT_PUBLIC_PAYMASTER_ADDRESS");
        sbtAddress = assertConfiguredAddress(sbt, "NEXT_PUBLIC_SBT_ADDRESS");
        rewardsAddress = assertConfiguredAddress(rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      } catch (configError) {
        setResult({
          title: "configuration",
          ok: false,
          message: configError instanceof Error ? configError.message : "Missing frontend contract configuration",
        });
        return null;
      }

      // Guard: use wagmi's chainId (authoritative) rather than querying window.ethereum directly.
      if (chainId !== SCROLL_SEPOLIA) {
        setResult({
          title: "wrong network",
          ok: false,
          message: `Switch your wallet to Scroll Sepolia (chain ${SCROLL_SEPOLIA}) — currently on chain ${chainId}.`,
        });
        return null;
      }

      console.log(`[refresh] Using Scroll Sepolia RPC directly for contract reads`);

      const factoryContract = new Contract(factoryAddress, SMART_ACCOUNT_FACTORY_ABI, provider) as any;
      // NOTE: ethers v6 BaseContract has a built-in getAddress() that shadows the
      // Solidity getAddress(address,uint256) function on our factory. Call via the
      // fully-qualified signature so ethers dispatches to the Solidity function.
      const derived = (await factoryContract["getAddress(address,uint256)"](owner, asBigInt(salt))) as string;
      const code = await provider.getCode(derived);

      const sbtContract = new Contract(sbtAddress, MEMBERSHIP_SBT_ABI, provider) as any;
      const rewardsContract = new Contract(rewardsAddress, REWARDS_ABI, provider) as any;

      let tokenId = "0";
      let tier = "—";
      let reputation = "0";

      // Try to get member data from backend database first (indexed by owner wallet address)
      console.log("[refresh] Checking backend for membership data (owner:", owner, ")");
      try {
        const dbResponse = await fetch(backend + "/member/owner/" + owner);
        if (dbResponse.ok) {
          const dbData = (await dbResponse.json()) as any;
          if (dbData.member) {
            console.log("[refresh] Found member in backend database:", dbData.member);
            tokenId = String(dbData.member.token_id || "0");
            tier = tierNameFromValue(BigInt(dbData.member.tier || "0"));
            console.log("[refresh] From database - tokenId:", tokenId, "tier:", tier);
          }
        }
      } catch (e) {
        console.log("[refresh] Backend query failed (expected if not yet indexed):", e instanceof Error ? e.message : String(e));
      }
      let collectionName = "—";
      let collectionSymbol = "—";
      let tokenUri = "—";
      let walletBalance = "0";

      // Verify SBT contract is deployed
      const sbtCode = await provider.getCode(sbtAddress);
      console.log(`[refresh] Checking SBT code at ${sbtAddress} - result: ${sbtCode === "0x" ? "NOT DEPLOYED (0x)" : "deployed (" + sbtCode.length + " bytes)"}`);
      if (sbtCode === "0x") {
        console.warn(`[refresh] Warning: SBT contract code not found at ${sbtAddress}. Provider may be on wrong chain or RPC may be cached. Continuing with database fallback...`);
      }

      // Always try to read SBT metadata, even if code check failed (might be RPC issue)
      try {
        const rawName = await sbtContract.name();
        collectionName = rawName || "—";
        const rawSymbol = await sbtContract.symbol();
        collectionSymbol = rawSymbol || "—";
        const balance = await sbtContract.balanceOf(derived);
        walletBalance = BigInt(balance).toString();
        console.log(`[refresh] SBT metadata loaded: name=${collectionName}, symbol=${collectionSymbol}, balance=${walletBalance}`);
      } catch (e) {
        console.warn(`[refresh] SBT metadata read failed:`, e instanceof Error ? e.message : String(e));
      }

      try {
        // SBT holder is the smart account (it's the one that calls mint via UserOp
        // and is the only address that can later call claim).
        const onChainTokenId = await sbtContract.tokenIdOf(derived);
        tokenId = BigInt(onChainTokenId).toString();
        console.log(`[refresh] tokenIdOf(${derived.slice(0, 10)}... SA) = ${tokenId}`);
        if (tokenId !== "0") {
          try {
            const onChainTier = await sbtContract.tierOf(tokenId);
            tier = tierNameFromValue(onChainTier);
            console.log(`[refresh] tierOf(${tokenId}) = ${tier}`);
          } catch (tierErr) {
            console.error(`[refresh] tierOf read failed:`, tierErr instanceof Error ? tierErr.message : String(tierErr));
          }
          try {
            const rep = await rewardsContract.reputationOf(tokenId);
            reputation = BigInt(rep).toString();
            console.log(`[refresh] reputationOf(${tokenId}) = ${reputation}`);
          } catch (repErr) {
            console.error(`[refresh] reputationOf read failed:`, repErr instanceof Error ? repErr.message : String(repErr));
          }
          try {
            tokenUri = (await sbtContract.tokenURI(tokenId)) as string;
            console.log(`[refresh] tokenURI(${tokenId}) = ${tokenUri}`);
          } catch (uriErr) {
            console.error(`[refresh] tokenURI read failed:`, uriErr instanceof Error ? uriErr.message : String(uriErr));
            tokenUri = "—";
          }
        }
      } catch (e) {
        console.error(`[refresh] tokenIdOf or tier chain read failed:`, e instanceof Error ? e.message : String(e));
      }

      let currentEpoch = "0";
      let currentEpochStart = "0";
      let rewardsPoolAccrued = "0";
      let claimFeeBps = "0";
      let treasuryRewardsBps = "0";
      let treasuryOpsBps = "0";
      let treasuryBurnBps = "0";
      let burnSink = "—";
      let sbtIsV2 = false;
      let tierBpsTotal = "0";
      let tierBpsValid = false;
      let tierBpsByTier = ["0", "0", "0", "0"];
      try {
        currentEpoch = BigInt(await rewardsContract.currentEpoch()).toString();
        currentEpochStart = BigInt(await rewardsContract.currentEpochStart()).toString();
        rewardsPoolAccrued = BigInt(await rewardsContract.rewardsPoolAccrued()).toString();
        claimFeeBps = BigInt(await rewardsContract.claimFeeBps()).toString();
        treasuryRewardsBps = BigInt(await rewardsContract.rewardsBps()).toString();
        treasuryOpsBps = BigInt(await rewardsContract.opsBps()).toString();
        treasuryBurnBps = BigInt(await rewardsContract.burnBps()).toString();
        burnSink = (await rewardsContract.burnSink()) as string;
        sbtIsV2 = Boolean(await rewardsContract.sbtIsV2());
        const [total, valid] = (await rewardsContract.getTierBpsTotal()) as readonly [bigint, boolean];
        tierBpsTotal = BigInt(total).toString();
        tierBpsValid = valid;
        tierBpsByTier = await Promise.all(TIER_NAMES.map(async (_tier, index) => BigInt(await rewardsContract.tierBps(index)).toString()));
      } catch {
        // contract not yet deployed or call failed
      }

      setSmartAccount(derived);
      setState({
        owner,
        smartAccount: derived,
        deployed: code !== "0x",
        tokenId,
        tokenStandard: "ERC-721",
        collectionName,
        collectionSymbol,
        tokenUri,
        walletBalance,
        sbtAddress,
        tier,
        reputation,
        currentEpoch,
        currentEpochStart,
        rewardsPoolAccrued,
      });
      setRewardsConfig({
        claimFeeBps,
        rewardsBps: treasuryRewardsBps,
        opsBps: treasuryOpsBps,
        burnBps: treasuryBurnBps,
        burnSink,
        sbtIsV2,
        tierBpsTotal,
        tierBpsValid,
        tierBpsByTier,
      });

      if (!adminTokenId && tokenId !== "0") {
        setAdminTokenId(tokenId);
      }
      if (!adminReputation && reputation !== "0") {
        setAdminReputation(reputation);
      }
      if (!adminBurnSink && burnSink !== "—") {
        setAdminBurnSink(burnSink);
      }
      if (!adminTierBps && tierBpsByTier[Number(adminTierBpsTier)] !== undefined) {
        setAdminTierBps(tierBpsByTier[Number(adminTierBpsTier)]);
      }
      if (!adminTreasuryRewards) {
        setAdminTreasuryRewards(treasuryRewardsBps);
      }
      if (!adminTreasuryOps) {
        setAdminTreasuryOps(treasuryOpsBps);
      }
      if (!adminTreasuryBurn) {
        setAdminTreasuryBurn(treasuryBurnBps);
      }
      setAdminSbtIsV2(sbtIsV2);

      if (backend) {
        const health = await fetch("/api/backend-health", { cache: "no-store" });
        const json = (await health.json()) as { ok: boolean; backend?: { ok?: boolean }; reason?: string };
        setBackendHealth({
          ok: Boolean(json.ok && json.backend && json.backend.ok),
          message: json.ok ? "Backend reachable" : json.reason ?? "Backend unavailable",
        });
      } else {
        setBackendHealth({ ok: false, message: "Set NEXT_PUBLIC_BACKEND_URL to check backend health" });
      }

      void entryPointAddress;
      void paymasterAddress;

      return {
        owner,
        smartAccount: derived,
        deployed: code !== "0x",
        tokenId,
        tokenStandard: "ERC-721",
        collectionName,
        collectionSymbol,
        tokenUri,
        walletBalance,
        sbtAddress,
        tier,
        reputation,
        currentEpoch,
        currentEpochStart,
        rewardsPoolAccrued,
      };
    } finally {
      if (shouldSetLoading) setLoading(false);
    }
  }

  async function submitUserOp(userOp: JsonUserOp) {
    if (!walletClient) throw new Error("Connected wallet client unavailable");
    const owner = walletClient.account?.address ?? walletAddress;
    if (!owner) throw new Error("No connected wallet account found");

    const entryPointAddress = assertConfiguredAddress(getAddresses().entryPoint, "NEXT_PUBLIC_ENTRYPOINT_ADDRESS");
    // Use a dedicated RPC (not MetaMask's BrowserProvider) so getUserOpHash computes on the correct chain.
    const readProvider = new JsonRpcProvider("https://sepolia-rpc.scroll.io/");
    const entryPoint = new Contract(entryPointAddress, ENTRY_POINT_ABI, readProvider) as any;

    // DEBUG: log the userOp being signed
    console.log("[submitUserOp] userOp:", JSON.stringify(userOp, null, 2));

    const signature = await signUserOperation({
      entryPoint,
      signer: {
        signMessage: (message: Uint8Array) =>
          walletClient.signMessage({ account: walletAddress as `0x${string}`, message: { raw: message } }),
      },
      userOp,
    });

    const signedUserOp = { ...userOp, signature };
    const response = await fetch("/api/send-userop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryPoint: entryPointAddress,
        userOp: signedUserOp,
      }),
    });
    const json = (await response.json()) as { ok: boolean; result?: unknown; reason?: string };
    if (!response.ok || !json.ok) {
      throw new Error(json.reason ?? "Bundler submission failed");
    }

    return typeof json.result === "string" ? json.result : undefined;
  }

  async function onMint() {
    if (!walletAddress) {
      setResult({ title: "mint", ok: false, message: "Connect a wallet before minting membership" });
      return;
    }

    // The input is the recipient's EOA. We always mint to that EOA's smart account
    // (claim() requires msg.sender == ownerOf(tokenId), and only the SA can be a
    // UserOp sender in our gasless flow). If the field is blank we use the connected
    // wallet's own smart account.
    const targetEoa = mintRecipientEoa.trim() || walletAddress;
    if (!targetEoa.match(/^0x[0-9a-fA-F]{40}$/)) {
      setResult({ title: "mint", ok: false, message: "Invalid recipient EOA address" });
      return;
    }

    let recipient: string;
    if (targetEoa.toLowerCase() === walletAddress.toLowerCase() && smartAccount) {
      recipient = smartAccount;
    } else {
      // Derive the SA for an arbitrary EOA via the factory.
      const factoryAddress = assertConfiguredAddress(getAddresses().factory, "NEXT_PUBLIC_FACTORY_ADDRESS");
      const provider = new JsonRpcProvider("https://sepolia-rpc.scroll.io/");
      const factoryContract = new Contract(factoryAddress, SMART_ACCOUNT_FACTORY_ABI, provider) as any;
      try {
        recipient = (await factoryContract["getAddress(address,uint256)"](targetEoa, asBigInt(salt))) as string;
      } catch (e) {
        setResult({
          title: "mint",
          ok: false,
          message: `Could not derive smart account for ${targetEoa}: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
    }
    console.log(`[mint] target EOA ${targetEoa} \u2192 SA ${recipient}`);

    setLoading(true);
    try {
      console.log("[mint] Starting mint flow for address:", recipient);

      if (!smartAccount) {
        console.log("[mint] Smart account not cached, refreshing...");
        await refresh(walletAddress);
      }

      if (!smartAccount) {
        throw new Error("Smart account is not ready yet. Refresh the page or reconnect your wallet, then try again.");
      }

      console.log("[mint] Using smart account:", smartAccount);
      console.log("[mint] Salt:", salt);

      assertConfiguredAddress(getAddresses().factory, "NEXT_PUBLIC_FACTORY_ADDRESS");
      assertConfiguredAddress(getAddresses().entryPoint, "NEXT_PUBLIC_ENTRYPOINT_ADDRESS");
      assertConfiguredAddress(getAddresses().sbt, "NEXT_PUBLIC_SBT_ADDRESS");

      console.log("[mint] Calling /api/mint endpoint...");
      const response = await fetch("/api/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: walletAddress, recipient, salt }),
      });
      const json = (await response.json()) as {
        ok: boolean;
        userWallet?: string;
        sender?: string;
        saDeployed?: boolean;
        userOp?: JsonUserOp;
        reason?: string;
      };

      console.log("[mint] Backend response:", json);

      if (!response.ok || !json.ok || !json.userOp) {
        throw new Error(json.reason ?? "Unable to build mint user operation");
      }

      console.log("[mint] UserOp built for sender:", json.sender);
      console.log("[mint] SA deployed:", json.saDeployed);
      console.log("[mint] Minting to:", json.userWallet);

      // Sign the UserOp with the connected wallet and submit to bundler
      console.log("[mint] Signing UserOp with connected wallet...");
      const bundlerHash = await submitUserOp(json.userOp);

      setResult({
        title: "mint",
        ok: true,
        message: `Mint submitted for ${recipient}`,
        txHash: bundlerHash,
        userOp: json.userOp,
      });

      console.log("[mint] Polling for smart account deployment and minting...");
      const pollDeadline = Date.now() + 60_000;
      let pollCount = 0;
      let latestSnapshot = await refresh(walletAddress, undefined, { setLoadingState: false });
      console.log("[mint] Poll #0 - tokenId:", latestSnapshot?.tokenId);

      while (latestSnapshot?.tokenId === "0" && Date.now() < pollDeadline) {
        pollCount++;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        latestSnapshot = await refresh(walletAddress, undefined, { setLoadingState: false });
        console.log(`[mint] Poll #${pollCount} - tokenId: ${latestSnapshot?.tokenId}, deployed: ${latestSnapshot?.deployed}`);
      }

      console.log("[mint] Polling complete. Final snapshot:", latestSnapshot);
      await refresh(walletAddress);
    } catch (error) {
      console.error("[mint] Error:", error);
      setResult({
        title: "mint",
        ok: false,
        message: error instanceof Error ? error.message : "Mint failed",
      });
    } finally {
      setLoading(false);
    }
  }

  async function onClaim() {
    if (!walletAddress) return;
    // Force a fresh on-chain read so we never claim with stale tokenId/epoch
    // (e.g. right after switching wallets, when the useEffect refresh is mid-flight).
    const snapshot = await refresh(walletAddress, undefined, { setLoadingState: false });
    if (!snapshot) {
      setResult({ title: "claim", ok: false, message: "Could not refresh on-chain state" });
      return;
    }
    const sa = snapshot.smartAccount || smartAccount;
    if (!sa) {
      setResult({ title: "claim", ok: false, message: "Smart account not derived yet" });
      return;
    }
    const tokenId = snapshot.tokenId;
    const currentEpochBn = snapshot.currentEpoch && snapshot.currentEpoch !== "—" ? BigInt(snapshot.currentEpoch) : 0n;
    const epoch = currentEpochBn > 0n ? (currentEpochBn - 1n).toString() : "0";
    console.log("[claim] using fresh snapshot:", { sa, tokenId, epoch, currentEpoch: snapshot.currentEpoch });
    if (tokenId === "0" || !tokenId) {
      setResult({ title: "claim", ok: false, message: "No member token found for this smart account" });
      return;
    }

    setLoading(true);
    try {
      assertConfiguredAddress(getAddresses().entryPoint, "NEXT_PUBLIC_ENTRYPOINT_ADDRESS");
      assertConfiguredAddress(getAddresses().rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      if (!walletClient) throw new Error("Connected wallet client unavailable");
      const sig = await walletClient.signMessage({
        account: walletAddress as `0x${string}`,
        message: { raw: claimDigest(sa, tokenId, epoch) },
      });
      const response = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smartAccount: sa,
          owner: walletAddress,
          salt,
          tokenId,
          epoch,
          userSignature: sig,
        }),
      });

      const json = (await response.json()) as { ok: boolean; userOp?: JsonUserOp; tenderlyUrl?: string; reason?: string };
      if (!response.ok || !json.ok || !json.userOp) {
        throw new Error(json.reason ?? "Unable to build claim user operation");
      }

      const bundlerHash = await submitUserOp(json.userOp);
      setResult({
        title: "claim",
        ok: true,
        message: `Claim prepared for token ${tokenId} in epoch ${epoch}`,
        txHash: bundlerHash,
        tenderlyUrl: json.tenderlyUrl,
        userOp: json.userOp,
      });
      await refresh();
    } catch (error) {
      setResult({
        title: "claim",
        ok: false,
        message: error instanceof Error ? error.message : "Claim failed",
      });
    } finally {
      setLoading(false);
    }
  }

  async function runAdminAction(title: string, action: () => Promise<void>) {
    setLoading(true);
    try {
      await action();
      await refresh();
    } catch (error) {
      setResult({
        title,
        ok: false,
        message: error instanceof Error ? error.message : `${title} failed`,
      });
    } finally {
      setLoading(false);
    }
  }

  async function onSetTier() {
    await runAdminAction("set tier", async () => {
      const sbtAddress = assertConfiguredAddress(getAddresses().sbt, "NEXT_PUBLIC_SBT_ADDRESS");
      const tokenId = parseBigIntInput(adminTokenId, "token id");
      const tier = BigInt(adminTier);
      await writeContractAction({
        title: "set tier",
        address: sbtAddress,
        addressLabel: "NEXT_PUBLIC_SBT_ADDRESS",
        abiDefinition: MEMBERSHIP_SBT_ABI,
        functionName: "setTier",
        args: [tokenId, tier],
        message: `Updated token ${tokenId.toString()} to ${TIER_NAMES[Number(tier)] ?? "Bronze"}`,
      });
    });
  }

  async function onSetReputation() {
    await runAdminAction("set reputation", async () => {
      const rewardsAddress = assertConfiguredAddress(getAddresses().rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      const tokenId = parseBigIntInput(adminTokenId, "token id");
      const reputation = parseBigIntInput(adminReputation, "reputation score");
      await writeContractAction({
        title: "set reputation",
        address: rewardsAddress,
        addressLabel: "NEXT_PUBLIC_REWARDS_ADDRESS",
        abiDefinition: REWARDS_ABI,
        functionName: "setReputation",
        args: [tokenId, reputation],
        message: `Set reputation for token ${tokenId.toString()} to ${reputation.toString()}`,
      });
    });
  }

  async function onSetTierBps() {
    await runAdminAction("set tier bps", async () => {
      const rewardsAddress = assertConfiguredAddress(getAddresses().rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      const bps = parseBigIntInput(adminTierBps, "tier bps");
      await writeContractAction({
        title: "set tier bps",
        address: rewardsAddress,
        addressLabel: "NEXT_PUBLIC_REWARDS_ADDRESS",
        abiDefinition: REWARDS_ABI,
        functionName: "setTierBps",
        args: [BigInt(adminTierBpsTier), bps],
        message: `Updated ${TIER_NAMES[Number(adminTierBpsTier)] ?? "Bronze"} tier allocation to ${bps.toString()} bps`,
      });
    });
  }

  async function onSetTreasurySplit() {
    await runAdminAction("set treasury split", async () => {
      const rewardsAddress = assertConfiguredAddress(getAddresses().rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      const rewards = parseBigIntInput(adminTreasuryRewards, "rewards bps");
      const ops = parseBigIntInput(adminTreasuryOps, "ops bps");
      const burn = parseBigIntInput(adminTreasuryBurn, "burn bps");
      await writeContractAction({
        title: "set treasury split",
        address: rewardsAddress,
        addressLabel: "NEXT_PUBLIC_REWARDS_ADDRESS",
        abiDefinition: REWARDS_ABI,
        functionName: "setTreasurySplit",
        args: [rewards, ops, burn],
        message: `Treasury split updated to ${rewards.toString()} / ${ops.toString()} / ${burn.toString()} bps`,
      });
    });
  }

  async function onSetBurnSink() {
    await runAdminAction("set burn sink", async () => {
      const rewardsAddress = assertConfiguredAddress(getAddresses().rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      const burnSink = assertConfiguredAddress(adminBurnSink, "burn sink address");
      await writeContractAction({
        title: "set burn sink",
        address: rewardsAddress,
        addressLabel: "NEXT_PUBLIC_REWARDS_ADDRESS",
        abiDefinition: REWARDS_ABI,
        functionName: "setBurnSink",
        args: [burnSink],
        message: `Burn sink updated to ${burnSink}`,
      });
    });
  }

  async function onFundPaymaster() {
    await runAdminAction("fund paymaster", async () => {
      const paymasterAddress = assertConfiguredAddress(getAddresses().paymaster, "NEXT_PUBLIC_PAYMASTER_ADDRESS");
      const depositAmount = parseEther(paymasterDepositAmount || "0");
      if (depositAmount <= 0n) {
        throw new Error("Enter a positive ETH amount first.");
      }

      await writeContractAction({
        title: "fund paymaster",
        address: paymasterAddress,
        addressLabel: "NEXT_PUBLIC_PAYMASTER_ADDRESS",
        abiDefinition: PAYMASTER_ABI,
        functionName: "deposit",
        args: [],
        value: depositAmount,
        message: `Deposited ${paymasterDepositAmount} ETH into the paymaster`,
      });
    });
  }

  async function onToggleSbtV2(nextValue: boolean) {
    await runAdminAction("set sbt v2", async () => {
      const rewardsAddress = assertConfiguredAddress(getAddresses().rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      await writeContractAction({
        title: "set sbt v2",
        address: rewardsAddress,
        addressLabel: "NEXT_PUBLIC_REWARDS_ADDRESS",
        abiDefinition: REWARDS_ABI,
        functionName: "setSbtIsV2",
        args: [nextValue],
        message: `SBT v2 mode ${nextValue ? "enabled" : "disabled"}`,
      });
    });
  }

  async function onCloseEpoch() {
    await runAdminAction("close epoch", async () => {
      const rewardsAddress = assertConfiguredAddress(getAddresses().rewards, "NEXT_PUBLIC_REWARDS_ADDRESS");
      const tokenIds = parseTokenIdList(closeEpochTokenIds);
      await writeContractAction({
        title: "close epoch",
        address: rewardsAddress,
        addressLabel: "NEXT_PUBLIC_REWARDS_ADDRESS",
        abiDefinition: REWARDS_ABI,
        functionName: "closeEpoch",
        args: [tokenIds],
        message: tokenIds.length > 0
          ? `Closed the epoch with ${tokenIds.length} token snapshots`
          : "Closed the epoch with no token snapshots",
      });
    });
  }

  async function grantRoleAction(roleLabel: string, role: string) {
    await runAdminAction(`grant ${roleLabel}`, async () => {
      const sbtAddress = assertConfiguredAddress(getAddresses().sbt, "NEXT_PUBLIC_SBT_ADDRESS");
      const addressToGrant = assertConfiguredAddress(minterAddress, "address");
      console.log(`[grant ${roleLabel}] role=${role} on SBT ${sbtAddress} to ${addressToGrant}`);
      await writeContractAction({
        title: `grant ${roleLabel}`,
        address: sbtAddress,
        addressLabel: "NEXT_PUBLIC_SBT_ADDRESS",
        abiDefinition: [
          "function grantRole(bytes32 role, address account)",
        ],
        functionName: "grantRole",
        args: [role, addressToGrant],
        message: `Granted ${roleLabel} to ${addressToGrant}`,
      });
    });
  }

  async function onGrantMinterRole() {
    await grantRoleAction("MINTER_ROLE", MINTER_ROLE);
  }

  async function onGrantRevokerRole() {
    await grantRoleAction("REVOKER_ROLE", REVOKER_ROLE);
  }

  async function onGrantDistributorRole() {
    await grantRoleAction("DISTRIBUTOR_ROLE", DISTRIBUTOR_ROLE);
  }

  async function onRevokeMember() {
    await runAdminAction("revoke membership", async () => {
      const sbtAddress = assertConfiguredAddress(getAddresses().sbt, "NEXT_PUBLIC_SBT_ADDRESS");
      const holder = assertConfiguredAddress(revokeHolder, "holder address");
      console.log("[revoke] calling revoke(holder) on SBT", { sbt: sbtAddress, holder });
      await writeContractAction({
        title: "revoke membership",
        address: sbtAddress,
        addressLabel: "NEXT_PUBLIC_SBT_ADDRESS",
        abiDefinition: MEMBERSHIP_SBT_ABI,
        functionName: "revoke",
        args: [holder],
        message: `Revoked membership for ${holder}`,
      });
    });
  }

  async function onMarkDistributed() {
    await runAdminAction("mark distributed", async () => {
      const sbtAddress = assertConfiguredAddress(getAddresses().sbt, "NEXT_PUBLIC_SBT_ADDRESS");
      const tokenId = parseBigIntInput(distributeTokenId, "token id");
      const epoch = parseBigIntInput(distributeEpoch, "epoch");
      console.log("[markClaimed] calling markClaimed(tokenId, epoch) on SBT", {
        sbt: sbtAddress,
        tokenId: tokenId.toString(),
        epoch: epoch.toString(),
      });
      await writeContractAction({
        title: "mark distributed",
        address: sbtAddress,
        addressLabel: "NEXT_PUBLIC_SBT_ADDRESS",
        abiDefinition: MEMBERSHIP_SBT_ABI,
        functionName: "markClaimed",
        args: [tokenId, epoch],
        message: `Marked token ${tokenId.toString()} as distributed for epoch ${epoch.toString()}`,
      });
    });
  }

  useEffect(() => {
    if (walletAddress && isConnected) {
      void refresh();
    }
  }, [walletAddress, isConnected, salt]);

  const activeTokenId = state.tokenId;
  const activeEpoch =
    state.currentEpoch && state.currentEpoch !== "—" && BigInt(state.currentEpoch) > 0n
      ? (BigInt(state.currentEpoch) - 1n).toString()
      : state.currentEpoch;
  const digestPreview = previewDigest(smartAccount, activeTokenId, activeEpoch);

  return (
    <main className="app-shell">
      <div className="noise" />
      <div className="wrap">

        {/* ── 00 HERO ─────────────────────────────────────────────────── */}
        <section className="hero-stage" id="top">
          <div className="hero-eyebrow-row">
            <span className="section-index">00</span>
            <span className="section-label">membership protocol</span>
            <span className="section-kicker">epoch-based · sepolia</span>
          </div>

          <div className="hero-grid">
            <div className="hero-copy">
              <p className="overline">The protocol</p>
              <h1>
                On-chain reputation,
                <span> rewarded fairly.</span>
              </h1>
              <p className="lede">
                Hold a soulbound membership token. Earn reputation each epoch. Claim your pro-rata share of the rewards
                pool — gaslessly, through ERC-4337, with the paymaster covering the fee.
              </p>

              <div className="hero-actions">
                <a className="button primary" href="#wallets">
                  view your tier
                </a>
                <a className="button secondary" href="#compute">
                  mint membership
                </a>
                <a className="button ghost" href="#implement">
                  how it works
                </a>
              </div>
            </div>

            <aside className="hero-panel">
              <div className="hero-panel-head">
                <span>your membership</span>
                <span className={backendHealth.ok ? "panel-dot good" : "panel-dot warn"}>
                  {backendHealth.ok ? "backend ready" : "backend check"}
                </span>
              </div>

              <div className="hero-metric-grid">
                <div className="metric-card">
                  <span>wallet</span>
                  <strong>{formatShortAddress(walletAddress)}</strong>
                </div>
                <div className="metric-card">
                  <span>smart account</span>
                  <strong>{formatShortAddress(state.smartAccount)}</strong>
                </div>
                <div className="metric-card">
                  <span>member tier</span>
                  <strong>{state.tier}</strong>
                </div>
                <div className="metric-card">
                  <span>reputation</span>
                  <strong>{state.reputation}</strong>
                </div>
                <div className="metric-card">
                  <span>current epoch</span>
                  <strong>{formatEpoch(state.currentEpoch)}</strong>
                </div>
              </div>
            </aside>
          </div>
        </section>

        {/* ── 01 OVERVIEW ─────────────────────────────────────────────── */}
        <section className="comparison-stage section" id="wallets">
          <div className="section-header">
            <span className="section-index">01</span>
            <div>
              <p className="overline">overview</p>
              <h2>Your membership.</h2>
              <p className="section-subtitle">Live snapshot of your SBT, tier, reputation, and current epoch.</p>
            </div>
          </div>

          <div className="comparison-grid" id="verify">
            {/* claim digest */}
            <article className="comparison-card comparison-card-digest">
              <div className="card-head">
                <span>claim authorization digest</span>
                <span className="card-badge good">canonical</span>
              </div>

              <p className="digest-label">claim digest</p>
              <p className="digest-copy">
                Sign this digest to authorize a gasless claim. The backend recovers the signer and verifies it matches
                your smart account owner — no key ever leaves the browser.
              </p>

              <div className="status-summary compact-summary">
                <div className="summary-item">
                  <span>token id</span>
                  <strong>{formatTokenId(activeTokenId)}</strong>
                </div>
                <div className="summary-item">
                  <span>epoch</span>
                  <strong>{formatEpoch(activeEpoch)}</strong>
                </div>
                <div className="summary-item">
                  <span>claim digest</span>
                  <strong
                    className="copyable-digest"
                    title="Click to copy full digest"
                    onClick={async () => {
                      if (!digestPreview || digestPreview === "—") return;
                      await navigator.clipboard.writeText(digestPreview);
                      setCopiedDigest(true);
                      setTimeout(() => setCopiedDigest(false), 1500);
                    }}
                  >
                    {copiedDigest ? "copied!" : shortenHex(digestPreview)}
                  </strong>
                </div>
                <div className="summary-item">
                  <span>contract</span>
                  <strong>{formatShortAddress(getAddresses().sbt)}</strong>
                </div>
              </div>
            </article>

            {/* mint / claim */}
            <article className="comparison-card comparison-card-actions">
              <div className="card-head">
                <span>mint or claim</span>
                <span className="card-badge good">live</span>
              </div>

              <p className="section-copy">
                Enter any EOA — we mint the SBT to that EOA&apos;s smart account so claims stay gasless. Leave blank to mint to your own
                smart account ({smartAccount ? formatShortAddress(smartAccount) : "—"}). Claim auto-uses your token ID and the previous epoch
                ({formatEpoch(activeEpoch)}).
              </p>

              <div className="form-grid" style={{ gridTemplateColumns: "1fr", marginTop: 0 }}>
                <div className="field">
                  <label htmlFor="mintRecipientEoa">Recipient EOA</label>
                  <input
                    id="mintRecipientEoa"
                    value={mintRecipientEoa}
                    onChange={(event) => setMintRecipientEoa(event.target.value)}
                    placeholder={walletAddress || "0x..."}
                  />
                  <p className="hint" style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
                    The SBT will be minted to <code>factory.getAddress(EOA, salt)</code>, not to the EOA itself.
                  </p>
                </div>
              </div>

              <div className="actions">
                <button className="button primary" type="button" onClick={onMint} disabled={loading || !walletAddress}>
                  Mint membership
                </button>
                <button className="button secondary" type="button" onClick={onClaim} disabled={loading || !walletAddress}>
                  Claim rewards
                </button>
                <button className="button ghost" type="button" onClick={() => refresh()} disabled={loading || !walletAddress}>
                  Refresh state
                </button>
              </div>

            </article>
          </div>
        </section>        

        {/* ── 03 ACTIONS + 04 LOG ─────────────────────────────────────── */}
        <section className="actions-stage section" id="compute">
          <div className="admin-cards-group">
          {/* membership admin */}
          <article className="action-card action-card-admin admin-card-horizontal">
            <div className="section-header compact">
              <span className="section-index">03A</span>
              <div>
                <p className="overline">membership admin</p>
                <h2>Membership controls</h2>
                <p className="section-subtitle">
                  Update a member&apos;s tier, reputation, and minter permissions. Role-gated on-chain.
                </p>
              </div>
            </div>

            <div className="admin-card-body">
              <div className="status-summary compact-top">
                <div className="summary-item">
                  <span>rewards pool</span>
                  <strong>{state.rewardsPoolAccrued}</strong>
                </div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="adminTokenId">Token ID</label>
                  <input
                    id="adminTokenId"
                    value={adminTokenId}
                    onChange={(event) => setAdminTokenId(event.target.value)}
                    placeholder={state.tokenId === "0" ? "No token yet" : state.tokenId}
                  />
                </div>
                <div className="field">
                  <label htmlFor="adminTier">Membership tier</label>
                  <select id="adminTier" value={adminTier} onChange={(event) => setAdminTier(event.target.value)}>
                    {TIER_NAMES.map((tierName, index) => (
                      <option key={tierName} value={index}>
                        {tierName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="adminReputation">Reputation score</label>
                  <input
                    id="adminReputation"
                    value={adminReputation}
                    onChange={(event) => setAdminReputation(event.target.value)}
                    placeholder={state.reputation}
                  />
                </div>
                <div className="field">
                  <label htmlFor="minterAddress">Grant role to address</label>
                  <input
                    id="minterAddress"
                    value={minterAddress}
                    onChange={(event) => setMinterAddress(event.target.value)}
                    placeholder={walletAddress || "0x..."}
                  />
                </div>
              </div>

              <div className="actions">
                <button className="button primary" type="button" onClick={onSetTier} disabled={loading || !walletAddress}>
                  Set membership tier
                </button>
                <button className="button secondary" type="button" onClick={onSetReputation} disabled={loading || !walletAddress}>
                  Set reputation
                </button>
                <button className="button ghost" type="button" onClick={onGrantRevokerRole} disabled={loading || !walletAddress}>
                  Grant REVOKER_ROLE
                </button>
                <button className="button ghost" type="button" onClick={onGrantDistributorRole} disabled={loading || !walletAddress}>
                  Grant DISTRIBUTOR_ROLE
                </button>
              </div>
            </div>
          </article>

          <div className="admin-cards-row">
          {/* tier allocation admin */}
          <article className="action-card action-card-admin action-card-rewards compact-card">
            <div className="section-header compact">
              <span className="section-index">03B</span>
              <div>
                <p className="overline">rewards admin</p>
                <h2>Tier allocation</h2>
                <p className="section-subtitle">
                  Configure tier BPS and manage epoch cadence.
                </p>
              </div>
            </div>

            <div className="form-grid">
              <div className="field">
                <label htmlFor="adminTierBps">Tier BPS</label>
                <input
                  id="adminTierBps"
                  value={adminTierBps}
                  onChange={(event) => setAdminTierBps(event.target.value)}
                  placeholder={rewardsConfig.tierBpsByTier[Number(adminTierBpsTier)] ?? "0"}
                />
              </div>
              <div className="field">
                <label htmlFor="closeEpochTokenIds">Close epoch token IDs</label>
                <input
                  id="closeEpochTokenIds"
                  value={closeEpochTokenIds}
                  onChange={(event) => setCloseEpochTokenIds(event.target.value)}
                  placeholder="1, 2, 3"
                />
              </div>
            </div>

            <div className="actions">
              <button className="button primary" type="button" onClick={onSetTierBps} disabled={loading || !walletAddress}>
                Set tier BPS
              </button>
              <button className="button ghost" type="button" onClick={onCloseEpoch} disabled={loading || !walletAddress}>
                Close epoch
              </button>
            </div>

          </article>

          {/* treasury & burn admin */}
          <article className="action-card action-card-admin">
            <div className="section-header compact">
              <span className="section-index">03C</span>
              <div>
                <p className="overline">rewards admin</p>
                <h2>Treasury &amp; burn</h2>
                <p className="section-subtitle">
                  Configure treasury split and burn sink.
                </p>
              </div>
            </div>

            <div className="form-grid">
              <div className="field">
                <label htmlFor="adminTreasuryRewards">Treasury rewards BPS</label>
                <input
                  id="adminTreasuryRewards"
                  value={adminTreasuryRewards}
                  onChange={(event) => setAdminTreasuryRewards(event.target.value)}
                  placeholder={rewardsConfig.rewardsBps}
                />
              </div>
              <div className="field">
                <label htmlFor="adminTreasuryOps">Treasury ops BPS</label>
                <input
                  id="adminTreasuryOps"
                  value={adminTreasuryOps}
                  onChange={(event) => setAdminTreasuryOps(event.target.value)}
                  placeholder={rewardsConfig.opsBps}
                />
              </div>
              <div className="field">
                <label htmlFor="adminTreasuryBurn">Treasury burn BPS</label>
                <input
                  id="adminTreasuryBurn"
                  value={adminTreasuryBurn}
                  onChange={(event) => setAdminTreasuryBurn(event.target.value)}
                  placeholder={rewardsConfig.burnBps}
                />
              </div>
              <div className="field">
                <label htmlFor="adminBurnSink">Burn sink address</label>
                <input
                  id="adminBurnSink"
                  value={adminBurnSink}
                  onChange={(event) => setAdminBurnSink(event.target.value)}
                  placeholder={rewardsConfig.burnSink}
                />
              </div>
            </div>

            <div className="actions">
              <button className="button primary" type="button" onClick={onSetTreasurySplit} disabled={loading || !walletAddress}>
                Set treasury split
              </button>
              <button className="button secondary" type="button" onClick={onSetBurnSink} disabled={loading || !walletAddress}>
                Set burn sink
              </button>
            </div>

          </article>
          </div>

          {/* paymaster + SBT v2 */}
          <article className="action-card action-card-admin action-card-paymaster compact-card admin-card-horizontal">
            <div className="section-header compact">
              <span className="section-index">03D</span>
              <div>
                <p className="overline">protocol switches up</p>
                <h2>Paymaster</h2>
                <p className="section-subtitle">
                  Top up gas sponsorship.
                </p>
              </div>
            </div>

            <div className="admin-card-body">
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="paymasterDepositAmount">Paymaster deposit ETH</label>
                  <input
                    id="paymasterDepositAmount"
                    value={paymasterDepositAmount}
                    onChange={(event) => setPaymasterDepositAmount(event.target.value)}
                    placeholder="0.2"
                  />
                </div>
              </div>

              <div className="actions">
                <button className="button primary" type="button" onClick={onFundPaymaster} disabled={loading || !walletAddress}>
                  Deposit to paymaster
                </button>
              </div>
            </div>
          </article>
          </div>

          {/* v2 admin — distribute & revoke (available after upgrading SBT to v2) */}
          <article className="action-card action-card-admin action-card-v2">
            <div className="section-header compact">
              <span className="section-index">03E</span>
              <div>
                <p className="overline">v2 admin</p>
                <h2>Distribute &amp; revoke</h2>
                <p className="section-subtitle">
                  Available once the SBT contract is upgraded to v2.
                  {" "}<code>markClaimed</code> records a holder&apos;s claimed epoch (DISTRIBUTOR_ROLE);
                  {" "}<code>revoke</code> burns a holder&apos;s SBT (REVOKER_ROLE).
                  {" "}<strong>The holder is the wallet (EOA) that was passed to <code>mint(to)</code></strong> — it&apos;s the address keyed in <code>tokenIdOf</code>.
                </p>
              </div>
            </div>

            <div className="form-grid">
              <div className="field">
                <label htmlFor="distributeTokenId">Token ID (distribute)</label>
                <input
                  id="distributeTokenId"
                  value={distributeTokenId}
                  onChange={(event) => setDistributeTokenId(event.target.value)}
                  placeholder={state.tokenId === "0" ? "Token id" : state.tokenId}
                />
              </div>
              <div className="field">
                <label htmlFor="distributeEpoch">Epoch (distribute)</label>
                <input
                  id="distributeEpoch"
                  value={distributeEpoch}
                  onChange={(event) => setDistributeEpoch(event.target.value)}
                  placeholder={state.currentEpoch !== "—" ? state.currentEpoch : "0"}
                />
              </div>
              <div className="field">
                <label htmlFor="revokeHolder">Holder EOA (revoke)</label>
                <input
                  id="revokeHolder"
                  value={revokeHolder}
                  onChange={(event) => setRevokeHolder(event.target.value)}
                  placeholder={walletAddress || "0x... (the EOA passed to mint)"}
                />
              </div>
            </div>

            <div className="actions">
              <button
                className="button primary"
                type="button"
                onClick={onMarkDistributed}
                disabled={loading || !walletAddress || !rewardsConfig.sbtIsV2}
                title={rewardsConfig.sbtIsV2 ? undefined : "Enable SBT v2 sync first"}
              >
                Mark distributed
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={onRevokeMember}
                disabled={loading || !walletAddress || !rewardsConfig.sbtIsV2}
                title={rewardsConfig.sbtIsV2 ? undefined : "Enable SBT v2 sync first"}
              >
                Revoke membership
              </button>
            </div>

            <div className="card-foot">
              <span>
                {rewardsConfig.sbtIsV2
                  ? "SBT v2 sync enabled — v2 functions are reachable"
                  : "SBT v2 sync disabled — these calls will revert until the contract is upgraded"}
              </span>
            </div>
          </article>

          {/* execution log */}
          <article className="action-card action-card-log" id="log">
            <div className="section-header compact">
              <span className="section-index">05</span>
              <div>
                <p className="overline">log</p>
                <h2>UserOp trace</h2>
              </div>
            </div>

            <p className="section-copy">
              Each mint and claim is submitted as a UserOp through ERC-4337. The paymaster signs the gas approval
              server-side; you sign the operation itself before it goes to the bundler.
            </p>

            <div className="output-panel">
              {result ? (
                <>
                  <div className={result.ok ? "success" : "error"}>
                    {result.title}: {result.message}
                  </div>
                  {result.tenderlyUrl ? (
                    <a className="chip" href={result.tenderlyUrl} target="_blank" rel="noreferrer">
                      tenderly simulation
                    </a>
                  ) : null}
                  {result.txHash ? <div className="code">bundler response: {result.txHash}</div> : null}
                  {result.userOp ? <pre className="code">{asPrettyJson(result.userOp)}</pre> : null}
                </>
              ) : (
                <span className="muted">
                  No action yet. Mint a membership or claim an epoch to see the full UserOp.
                </span>
              )}
            </div>

            <div className="footer-note">
              The claim digest is <span className="code">keccak256(abi.encode(smartAccount, tokenId, epoch))</span>.
              Your wallet signs it to prove ownership; the backend verifies against your smart account&apos;s on-chain
              owner before building the UserOp.
            </div>
          </article>
        </section>

      </div>
    </main>
  );
}
