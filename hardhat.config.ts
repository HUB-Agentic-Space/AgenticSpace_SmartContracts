import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import dotenv from "dotenv";

dotenv.config();

const {
  POLYGON_AMOY_RPC_URL = "https://rpc-amoy.polygon.technology",
  POLYGON_RPC_URL = "https://polygon.drpc.org",
  ANKR_API_KEY = "",
  POLYGON_AMOY_PRIVATE_KEY = "",
  POLYGON_PRIVATE_KEY = "",
  POLYGONSCAN_API_KEY = "",
} = process.env;

const polygonUrl = POLYGON_RPC_URL || (ANKR_API_KEY
  ? `https://rpc.ankr.com/polygon/${ANKR_API_KEY}`
  : "https://polygon.drpc.org");
const polygonAmoyUrl = POLYGON_AMOY_RPC_URL || (ANKR_API_KEY
  ? `https://rpc.ankr.com/polygon_amoy/${ANKR_API_KEY}`
  : "https://rpc-amoy.polygon.technology");

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "cancun",
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    // Polygon PoS — sidechain independente (separada da Ethereum)
    // POL e a moeda nativa para gas. Nao confundir com POL ERC-20 na Ethereum L1.
    polygonAmoy: {
      url: polygonAmoyUrl,
      accounts: POLYGON_AMOY_PRIVATE_KEY ? [POLYGON_AMOY_PRIVATE_KEY] : [],
      chainId: 80002,
      gasPrice: 25000000000,
    },
    // Polygon PoS Mainnet — sidechain independente (separada da Ethereum)
    // POL e a moeda nativa para gas.
    polygon: {
      url: polygonUrl,
      accounts: POLYGON_PRIVATE_KEY ? [POLYGON_PRIVATE_KEY] : [],
      chainId: 137,
    },
  },
  etherscan: {
    apiKey: POLYGONSCAN_API_KEY,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  typechain: {
    outDir: "./typechain-types",
    target: "ethers-v6",
  },
};

export default config;
