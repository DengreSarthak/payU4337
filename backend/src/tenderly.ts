const TENDERLY_BASE = "https://api.tenderly.co/api/v1";

type SimulationArgs = {
  network_id: string;
  from: string;
  to: string;
  input: string;
  value?: string;
  gas?: number;
  save?: boolean;
  save_if_fails?: boolean;
};

export async function simulate(args: SimulationArgs): Promise<{
  ok: boolean;
  url?: string;
  trace?: unknown;
  raw: unknown;
}> {
  const account = process.env.TENDERLY_ACCOUNT;
  const project = process.env.TENDERLY_PROJECT;
  const key = process.env.TENDERLY_ACCESS_KEY;
  if (!account || !project || !key) throw new Error("Tenderly env not set");

  const r = await fetch(
    `${TENDERLY_BASE}/account/${account}/project/${project}/simulate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Key": key },
      body: JSON.stringify({
        save: true,
        save_if_fails: true,
        simulation_type: "full",
        ...args,
      }),
    },
  );
  const json = (await r.json()) as any;
  const ok = json?.transaction?.status === true || json?.simulation?.status === true;
  const id = json?.simulation?.id;
  const url = id
    ? `https://dashboard.tenderly.co/${account}/${project}/simulator/${id}`
    : undefined;
  return { ok, url, trace: json?.transaction?.transaction_info, raw: json };
}
