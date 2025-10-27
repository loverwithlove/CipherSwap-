import { ethers } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk";

const PRIVACY_ROUTER_ADDRESS = process.env.PRIVACY_ROUTER || "0xYourRouterAddress";
const PROVIDER_URL = process.env.RPC || "http://localhost:8545";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const RELAYER_URL = process.env.RELAYER_URL || SepoliaConfig.relayerUrl;

const privacyRouterAbi = [
  "function swapBatches(uint256) view returns (address tokenIn, address tokenOut, uint256 totalAmountIn, uint256 totalAmountOut, uint256[] requestIds, bool executed, bool unwrapRequested, uint256 timestamp)",
  "function swapRequests(uint256) view returns (address user, address tokenIn, address tokenOut, bytes32 encryptedAmountIn, bytes32 encryptedMinAmountOut, uint256 timestamp)",
  "function distributeEncryptedOutputs(uint256, bytes32[], bytes[]) external",
];

function toHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

async function main() {
  if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY env var for the relayer/owner account");

  const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const router = new ethers.Contract(PRIVACY_ROUTER_ADDRESS, privacyRouterAbi, wallet);
  const batchId = Number(process.env.BATCH_ID || "0");
  if (isNaN(batchId)) throw new Error("Set BATCH_ID to process");

  const batch = await router.swapBatches(batchId);
  console.log("Batch:", batch);
  if (!batch.executed) {
    console.log(
      "Batch not executed yet. Must call executeBatchSwap first and ensure wrapper.finalizeUnwrap completed.",
    );
    return;
  }

  interface Batch {
    tokenIn: string;
    tokenOut: string;
    totalAmountIn: bigint;
    totalAmountOut: bigint;
    requestIds: bigint[];
    executed: boolean;
    unwrapRequested: boolean;
    timestamp: bigint;
  }

  const requestIds: number[] = (batch as Batch).requestIds.map((r: bigint): number => Number(r));
  const handles: string[] = [];
  const users: string[] = [];
  for (const id of requestIds) {
    const req = await router.swapRequests(id);
    const handle = req.encryptedAmountIn || req[3];
    handles.push(handle);
    const user = req.user || req[0];
    users.push(user);
  }

  console.log(`Collected ${handles.length} encrypted handles`);
  const config = { ...SepoliaConfig, relayerUrl: RELAYER_URL };
  const fhe = await createInstance(config);
  console.log("Requesting public decryption for inputs...");
  const decrypted = await fhe.publicDecrypt(handles);

  const inputAmounts: bigint[] = handles.map((h) => {
    const v = decrypted[h];
    if (v === undefined) throw new Error(`Missing decrypted value for handle ${h}`);
    return BigInt(v);
  });

  const sumInputs = inputAmounts.reduce((a, b) => a + b, BigInt(0));
  if (sumInputs === BigInt(0)) throw new Error("Sum of inputs is zero");

  const totalOutput = BigInt(batch.totalAmountOut || 0);
  if (totalOutput === BigInt(0)) {
    console.log("Router totalAmountOut is zero; ensure executeBatchSwap has wrapped outputs.");
    return;
  }

  const outputs: bigint[] = inputAmounts.map((amt) => (totalOutput * amt) / sumInputs);
  const encryptedOutputs: string[] = [];
  const proofs: string[] = [];
  const wrapperOutAddress = batch.tokenOut;

  for (let i = 0; i < requestIds.length; i++) {
    const recipient = users[i];
    const outAmount = outputs[i];
    const builder = fhe.createEncryptedInput(wrapperOutAddress, recipient);
    builder.add64(outAmount);
    const { handles: outHandles, inputProof } = await builder.encrypt();

    if (!outHandles || outHandles.length === 0) throw new Error("encrypt() returned no handles");

    encryptedOutputs.push(toHex(outHandles[0]));
    proofs.push(toHex(inputProof));
  }

  console.log("Submitting encrypted outputs to router...");
  const tx = await router.distributeEncryptedOutputs(batchId, encryptedOutputs, proofs);
  console.log("distributeEncryptedOutputs tx:", tx.hash);
  await tx.wait();
  console.log("Submitted encrypted outputs for batch", batchId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
