const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, frontend1, frontend2] = await hre.ethers.getSigners();

  // Deploy MockPriceFeed
  const MockPriceFeed = await hre.ethers.getContractFactory("MockPriceFeed");
  const priceFeed = await MockPriceFeed.deploy();
  await priceFeed.waitForDeployment();

  // Deploy Mock ERC20 tokens
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Mock USDC", "USDC", 6);
  const dai = await MockERC20.deploy("Mock DAI", "DAI", 18);
  const weth = await MockERC20.deploy("Mock WETH", "WETH", 18);
  await usdc.waitForDeployment();
  await dai.waitForDeployment();
  await weth.waitForDeployment();

  // Set prices in MockPriceFeed (8 decimals)
  await (await priceFeed.setPrice(await usdc.getAddress(), hre.ethers.parseUnits("1", 8))).wait();      // 1 USDC = $1
  await (await priceFeed.setPrice(await dai.getAddress(), hre.ethers.parseUnits("1", 8))).wait();       // 1 DAI = $1
  await (await priceFeed.setPrice(await weth.getAddress(), hre.ethers.parseUnits("2000", 8))).wait();   // 1 WETH = $2000

  // Deploy Lend contract
  const Lend = await hre.ethers.getContractFactory("Lend");
  const lend = await Lend.deploy(
    await usdc.getAddress(),
    await dai.getAddress(),
    await weth.getAddress(),
    await priceFeed.getAddress()
  );
  await lend.waitForDeployment();

  // Mint tokens to all demo accounts
  const mintAmountUSDC = hre.ethers.parseUnits("1000000", 6);
  const mintAmountDAI = hre.ethers.parseUnits("1000000", 18);
  const mintAmountWETH = hre.ethers.parseUnits("1000000", 18);

  for (const user of [deployer, frontend1, frontend2]) {
    await (await usdc.mint(user.address, mintAmountUSDC)).wait();
    await (await dai.mint(user.address, mintAmountDAI)).wait();
    await (await weth.mint(user.address, mintAmountWETH)).wait();
  }

  // Approve and supply initial liquidity from deployer only
  await (await usdc.approve(await lend.getAddress(), hre.ethers.parseUnits("500000", 6))).wait();
  await (await dai.approve(await lend.getAddress(), hre.ethers.parseUnits("500000", 18))).wait();
  await (await weth.approve(await lend.getAddress(), hre.ethers.parseUnits("500000", 18))).wait();

  await (await lend.supply(await usdc.getAddress(), hre.ethers.parseUnits("500000", 6), deployer.address)).wait();
  await (await lend.supply(await dai.getAddress(), hre.ethers.parseUnits("500000", 18), deployer.address)).wait();
  await (await lend.supply(await weth.getAddress(), hre.ethers.parseUnits("500000", 18), deployer.address)).wait();

  // Prepare frontend config
  const artifactsDir = path.join(__dirname, "../frontend/src/contracts");
  if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

  const lendArtifact = await hre.artifacts.readArtifact("Lend");
  const mockERC20Artifact = await hre.artifacts.readArtifact("MockERC20");

  const contractsConfig = {
    chainId: 31337,
    contracts: {
      LendingProtocol: {
        address: await lend.getAddress(),
        abi: lendArtifact.abi,
      },
      MockERC20: {
        abi: mockERC20Artifact.abi,
      },
    },
    tokens: {
      USDC: { address: await usdc.getAddress(), symbol: "USDC", decimals: 6, abi: mockERC20Artifact.abi },
      DAI: { address: await dai.getAddress(), symbol: "DAI", decimals: 18, abi: mockERC20Artifact.abi },
      WETH: { address: await weth.getAddress(), symbol: "WETH", decimals: 18, abi: mockERC20Artifact.abi },
    },
    accounts: {
      frontend1: frontend1.address,
      frontend2: frontend2.address,
      deployer: deployer.address,
    },
  };

  fs.writeFileSync(
    path.join(artifactsDir, "index.ts"),
    `export interface TokenConfig {
  address: \`0x\${string}\`;
  symbol: string;
  decimals: number;
  abi: any[];
}

export interface ContractsConfig {
  chainId: number;
  contracts: {
    LendingProtocol: {
      address: \`0x\${string}\`;
      abi: any[];
    };
    MockERC20: {
      abi: any[];
    };
  };
  tokens: {
    USDC: TokenConfig;
    DAI: TokenConfig;
    WETH: TokenConfig;
  };
  accounts: {
    frontend1: string;
    frontend2: string;
    deployer: string;
  };
}

export const CONTRACTS_CONFIG: ContractsConfig = ${JSON.stringify(contractsConfig, null, 2)};
`
  );

  console.log("Deployment complete. Frontend config written to frontend/src/contracts/index.ts");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});