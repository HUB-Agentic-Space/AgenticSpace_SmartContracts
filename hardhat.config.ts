import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import dotenv from "dotenv";

dotenv.config();

const {
  POLYGON_AMOY_RPC_URL = "https://rpc-amoy.polygon.technology",
  POLYGON_RPC_URL = "https://polygon.drpc.org",
  BSC_RPC_URL = "https://bsc-dataseed.binance.org",
  BSC_TESTNET_RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545",
  ANKR_API_KEY = "",
  POLYGON_AMOY_PRIVATE_KEY = "",
  POLYGON_PRIVATE_KEY = "",
  BSC_PRIVATE_KEY = "",
  POLYGONSCAN_API_KEY = "",
  BSCSCAN_API_KEY = "",
} = process.env;

const polygonUrl = POLYGON_RPC_URL || (ANKR_API_KEY
  ? `https://rpc.ankr.com/polygon/${ANKR_API_KEY}`
  : "https://polygon.drpc.org");
const polygonAmoyUrl = POLYGON_AMOY_RPC_URL || (ANKR_API_KEY
  ? `https://rpc.ankr.com/polygon_amoy/${ANKR_API_KEY}`
  : "https://rpc-amoy.polygon.technology");
const bscUrl = BSC_RPC_URL || (ANKR_API_KEY
  ? `https://rpc.ankr.com/bsc/${ANKR_API_KEY}`
  : "https://bsc-dataseed.binance.org");
// BSC usa a mesma EOA do deployer Polygon por padrão (regra: reusar deployer).
const bscPrivateKey = BSC_PRIVATE_KEY || POLYGON_PRIVATE_KEY;

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
    overrides: {
      // Facet CASSwap com oráculo on-chain passou de 24KB com runs=200;
      // runs=1 mantém o bytecode abaixo de EIP-170 sem mudar a ABI.
      "contracts/facets/CASSwapUSDCPOLFacet.sol": {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 1,
          },
          evmVersion: "cancun",
        },
      },
      "contracts/certificate/RapportCertificateUpgradeable.sol": {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 1,
          },
          evmVersion: "cancun",
        },
      },
      "contracts/certificate/RapportCertificatePhaseAdminFacet.sol": {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 1,
          },
          evmVersion: "cancun",
        },
      },
      // Test-only fixture mirroring the real mainnet-verified bytecode
      // settings (Polygonscan: v0.8.28, optimizer enabled, 1 run, cancun) —
      // needed so it fits under EIP-170 for upgrade-safety tests.
      "contracts/test-fixtures/RapportCertificateUpgradeableDeployedV0.sol": {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 1,
          },
          evmVersion: "cancun",
        },
      },
    },
  },
  networks: {
    hardhat: {
      chainId: process.env.HARDHAT_FORK_URL ? 137 : 31337,
      // EndpointV2Mock da LayerZero excede o limite de 24KB — apenas testes locais.
      allowUnlimitedContractSize: true,
      forking: process.env.HARDHAT_FORK_URL
        ? { url: process.env.HARDHAT_FORK_URL }
        : undefined,
      chains: {
        137: {
          hardforkHistory: {
            shanghai: 0,
            cancun: 0,
            prague: 0,
          },
        },
      },
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
    // BNB Smart Chain Mainnet — destino do bridge CAS via LayerZero OFT.
    // BNB e a moeda nativa para gas. Deployer = mesma EOA do Polygon
    // (BSC_PRIVATE_KEY pode sobrescrever se uma chave dedicada for usada).
    bsc: {
      url: bscUrl,
      accounts: bscPrivateKey ? [bscPrivateKey] : [],
      chainId: 56,
    },
    // BNB Smart Chain Testnet (Chapel) — para validacao end-to-end.
    bscTestnet: {
      url: BSC_TESTNET_RPC_URL,
      accounts: bscPrivateKey ? [bscPrivateKey] : [],
      chainId: 97,
    },
  },
  etherscan: {
    apiKey: {
      polygon: POLYGONSCAN_API_KEY,
      polygonAmoy: POLYGONSCAN_API_KEY,
      bsc: BSCSCAN_API_KEY || POLYGONSCAN_API_KEY,
      bscTestnet: BSCSCAN_API_KEY || POLYGONSCAN_API_KEY,
    },
    customChains: [
      {
        network: "bsc",
        chainId: 56,
        urls: {
          apiURL: "https://api.bscscan.com/api",
          browserURL: "https://bscscan.com",
        },
      },
      {
        network: "bscTestnet",
        chainId: 97,
        urls: {
          apiURL: "https://api-testnet.bscscan.com/api",
          browserURL: "https://testnet.bscscan.com",
        },
      },
    ],
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
