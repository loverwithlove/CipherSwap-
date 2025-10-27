import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Tasks for interacting with PrivacyRouter contract
 * - task:router:address
 * - task:router:batch-info --batchId <id>
 * - task:router:create-swap-request-plain --tokenIn <addr> --tokenOut <addr> --amount <n> --minOut <n>
 * - task:router:trigger-batch --tokenIn <addr> --tokenOut <addr>
 * - task:router:set-batch-finalized --batchId <id> --amount <n>  (owner-only, test helper)
 * - task:router:execute-batch --batchId <id>
 */

task("router:address", "Prints deployed PrivacyRouter address").setAction(async function (
  _taskArguments: TaskArguments,
  hre,
) {
  const { deployments } = hre;
  const deploy = await deployments.get("PrivacyRouter");
  console.log("PrivacyRouter address:", deploy.address);
});

task("router:batch-info", "Print a batch by id")
  .addParam("batchId", "Batch id")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments } = hre;
    const routerDeployment = await deployments.get("PrivacyRouter");
    const router = await ethers.getContractAt("PrivacyRouter", routerDeployment.address);
    const batchId = Number(taskArguments.batchId);
    const batch = await router.swapBatches(batchId);
    const tokenIn = batch.tokenIn ?? batch[0];
    const tokenOut = batch.tokenOut ?? batch[1];
    const totalAmountIn = batch.totalAmountIn ?? batch[2];
    const totalAmountOut = batch.totalAmountOut ?? batch[3];
    const executed = batch.executed ?? batch[5];
    const unwrapRequested = batch.unwrapRequested ?? batch[6];

    console.log(`batch ${batchId}:`);
    console.log(`tokenIn: ${tokenIn}`);
    console.log(`tokenOut: ${tokenOut}`);
    console.log(`totalAmountIn: ${totalAmountIn}`);
    console.log(`totalAmountOut: ${totalAmountOut}`);
    console.log(`executed: ${executed}`);
    console.log(`unwrapRequested: ${unwrapRequested}`);
  });

task("router:create-swap-request-plain", "Create a plain swap request (test helper)")
  .addParam("tokenIn", "Underlying token in address")
  .addParam("tokenOut", "Underlying token out address")
  .addParam("amount", "Plain amount in")
  .addOptionalParam("minOut", "Plain min out", "0")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments } = hre;
    const routerDeployment = await deployments.get("PrivacyRouter");
    const router = await ethers.getContractAt("PrivacyRouter", routerDeployment.address);
    const signers = await ethers.getSigners();
    const tx = await router
      .connect(signers[0])
      .createSwapRequestPlain(
        taskArguments.tokenIn,
        taskArguments.tokenOut,
        Number(taskArguments.amount),
        Number(taskArguments.minOut),
      );

    console.log("tx:", tx.hash);
    await tx.wait();
    console.log("created plain swap request");
  });

task("router:trigger-batch", "Trigger batch creation for a token pair (owner)")
  .addParam("tokenIn", "Underlying token in address")
  .addParam("tokenOut", "Underlying token out address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments } = hre;
    const routerDeployment = await deployments.get("PrivacyRouter");
    const router = await ethers.getContractAt("PrivacyRouter", routerDeployment.address);
    const signers = await ethers.getSigners();
    const tx = await router.connect(signers[0]).triggerBatch(taskArguments.tokenIn, taskArguments.tokenOut);
    console.log("tx:", tx.hash);
    await tx.wait();
    console.log("triggered batch");
  });

task("router:set-batch-finalized", "Test-only: mark a batch as finalized and set amount (owner)")
  .addParam("batchId", "Batch id")
  .addParam("amount", "Finalized amount")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments } = hre;
    const routerDeployment = await deployments.get("PrivacyRouter");
    const router = await ethers.getContractAt("PrivacyRouter", routerDeployment.address);
    const signers = await ethers.getSigners();
    const tx = await router
      .connect(signers[0])
      .setBatchFinalized(Number(taskArguments.batchId), Number(taskArguments.amount));
    console.log("tx:", tx.hash);
    await tx.wait();
    console.log("batch finalized (test-only)");
  });

task("router:execute-batch", "Execute a finalized batch swap (owner)")
  .addParam("batchId", "Batch id")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments } = hre;
    const routerDeployment = await deployments.get("PrivacyRouter");
    const router = await ethers.getContractAt("PrivacyRouter", routerDeployment.address);
    const signers = await ethers.getSigners();
    const tx = await router.connect(signers[0]).executeBatchSwap(Number(taskArguments.batchId));
    console.log("tx:", tx.hash);
    await tx.wait();
    console.log("executed batch");
  });
