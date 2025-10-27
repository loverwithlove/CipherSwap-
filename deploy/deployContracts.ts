import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers, network } = hre;
  const { deploy, log } = deployments;
  const { deployer } = await getNamedAccounts();

  let uniswapRouterAddress: string | undefined;

  const localNets = ["hardhat", "localhost", "dev"];
  if (localNets.includes(network.name)) {
    log(`Local network detected (${network.name}) - deploying MockUniswapV2Router`);
    const mock = await deploy("MockUniswapV2Router", {
      from: deployer,
      log: true,
    });
    uniswapRouterAddress = mock.address;
  } else {
    uniswapRouterAddress = process.env.UNISWAP_ROUTER_ADDRESS;
    if (!uniswapRouterAddress) {
      throw new Error("UNISWAP_ROUTER_ADDRESS is not set");
    }
  }

  let wbtcAddress: string;
  if (localNets.includes(network.name)) {
    log("Deploying WBTC token (mock)");
    const wbtc = await deploy("WBTC", {
      from: deployer,
      args: [ethers.parseUnits("1000000", 8)],
      log: true,
    });
    wbtcAddress = wbtc.address;
  } else {
    wbtcAddress = process.env.WBTC_ADDRESS as string;
    if (!wbtcAddress) throw new Error("WBTC_ADDRESS env var not set");
  }

  const encrypted = await deploy("EncryptedWBTC", {
    from: deployer,
    args: [wbtcAddress],
    log: true,
  });

  const router = await deploy("PrivacyRouter", {
    from: deployer,
    args: [uniswapRouterAddress],
    log: true,
  });

  log("Deployed contracts:");
  log("PrivacyRouter:", router.address);
  log("EncryptedWBTC:", encrypted.address);
  log("WBTC (underlying):", wbtcAddress);
  log("Uniswap router:", uniswapRouterAddress);

  try {
    const routerContract = await ethers.getContractAt("PrivacyRouter", router.address);
    const tx = await routerContract
      .connect(await ethers.getSigner(deployer))
      .registerTokenWrapper(wbtcAddress, encrypted.address);
    await tx.wait();
    log(`Registered EncryptedWBTC wrapper (${encrypted.address}) for WBTC (${wbtcAddress}) on PrivacyRouter`);
  } catch (err) {
    log("Warning: failed to auto-register token wrapper:", (err as Error).message);
  }
};

export default func;
func.id = "deploy_privacy_and_encrypted_wbtc";
func.tags = ["PrivacyRouter", "EncryptedWBTC"];
