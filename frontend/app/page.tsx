"use client";

import { useEffect, useState, useCallback } from "react";
import {
  BrowserProvider,
  Contract,
  formatUnits,
  parseUnits,
  EventLog,
} from "ethers";
import {
  CONTRACTS_CONFIG,
  type TokenConfig,
} from "../src/contracts";

const { contracts, tokens } = CONTRACTS_CONFIG;

function formatTokenUnits(amount: bigint | number, decimals: number, precision = 4) {
  if (typeof amount === "bigint") {
    return Number(formatUnits(amount, decimals)).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: precision,
    });
  }
  return Number(amount).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}

// Helper to get provider only on client
function getProvider() {
  if (typeof window !== "undefined" && window.ethereum) {
    return new BrowserProvider(window.ethereum);
  }
  return undefined;
}

export default function LendingDemo() {
  const [address, setAddress] = useState<string>("");
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState<string>("");
  const [selectedToken, setSelectedToken] = useState<TokenConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [accountData, setAccountData] = useState<any>(null);
  const [txStatus, setTxStatus] = useState<string>("");
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [txHistory, setTxHistory] = useState<any[]>([]);

  // Fetch token prices from the price feed contract
  async function fetchPrices() {
    const provider = getProvider();
    if (!provider) return;
    try {
      const lend = new Contract(
        contracts.LendingProtocol.address,
        contracts.LendingProtocol.abi ?? [],
        provider
      );
      const priceFeedAddr = await lend.priceFeed();
      const priceFeed = new Contract(
        priceFeedAddr,
        ["function latestAnswer(address asset) view returns (uint256)"],
        provider
      );
      const newPrices: Record<string, number> = {};
      for (const symbol of Object.keys(tokens) as (keyof typeof tokens)[]) {
        const token = tokens[symbol];
        const priceRaw = await priceFeed.latestAnswer(token.address);
        newPrices[symbol] = Number(priceRaw) / 1e8; // 8 decimals
      }
      setPrices(newPrices);
    } catch (e) {
      setPrices({});
    }
  }

  async function connectWallet() {
    setError("");
    const provider = getProvider();
    try {
      if (!provider) throw new Error("No provider found. Please install MetaMask.");
      const accounts = await provider.send("eth_requestAccounts", []);
      setAddress(accounts[0]);
      // Immediately refresh after connecting
      setTimeout(() => refreshAll(accounts[0]), 0);
    } catch (e: any) {
      setError(e.message || "Failed to connect wallet.");
    }
  }

  async function fetchBalances(addr: string) {
    setError("");
    const provider = getProvider();
    try {
      if (!provider) return;
      const bals: Record<string, string> = {};
      for (const symbol of Object.keys(tokens) as (keyof typeof tokens)[]) {
        const token = tokens[symbol];
        const erc20 = new Contract(token.address, token.abi ?? [], provider);
        const bal = await erc20.balanceOf(addr);
        bals[symbol] = formatTokenUnits(bal, token.decimals);
      }
      setBalances(bals);
    } catch (e: any) {
      setError("Failed to fetch balances.");
    }
  }

  async function fetchAccountData(addr: string) {
    const provider = getProvider();
    try {
      if (!provider) return;
      const lend = new Contract(
        contracts.LendingProtocol.address,
        contracts.LendingProtocol.abi ?? [],
        provider
      );
      const data = await lend.getUserAccountData(addr);
      setAccountData({
        totalCollateralUSD: Number(formatUnits(data.totalCollateralUSD, 18)),
        totalDebtUSD: Number(formatUnits(data.totalDebtUSD, 18)),
        availableBorrowsUSD: Number(formatUnits(data.availableBorrowsUSD, 18)),
        currentLiquidationThreshold: Number(formatUnits(data.currentLiquidationThreshold, 4)),
        ltv: Number(formatUnits(data.ltv, 4)),
        healthFactor: Number(formatUnits(data.healthFactor, 18)),
      });
    } catch (e) {
      setAccountData(null);
    }
  }

  // Fetch transaction history for the connected user
const fetchTxHistory = useCallback(async (addr?: string) => {
  const provider = getProvider();
  const userAddr = addr ?? address;
  if (!provider || !userAddr) return [];
  const lend = new Contract(
    contracts.LendingProtocol.address,
    contracts.LendingProtocol.abi ?? [],
    provider
  );
  const eventNames = [
    "Supply",
    "Borrow",
    "Repay",
    "Withdraw",
    "Liquidation",
  ];
  let events: any[] = [];
  // Get current block number
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 10000);
  const toBlock = currentBlock;
  for (const eventName of eventNames) {
    let filter;
    if (eventName === "Liquidation") {
      filter = lend.filters.Liquidation(userAddr, null, null, null, null);
    } else {
      filter = lend.filters[eventName](userAddr, null, null);
    }
    const logs = await lend.queryFilter(filter, fromBlock, toBlock);
    for (const log of logs) {
      if ("args" in log) {
        events.push({
          event: eventName,
          args: (log as EventLog).args,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        });
      }
    }
  }
    // Sort by blockNumber descending
    events.sort((a, b) => b.blockNumber - a.blockNumber);
    return events;
  }, [address, contracts.LendingProtocol]);

  async function refreshAll(addrOverride?: string) {
    const addr = addrOverride ?? address;
    if (addr) {
      await fetchBalances(addr);
      await fetchAccountData(addr);
      await fetchPrices();
      const txs = await fetchTxHistory(addr);
      setTxHistory(txs);
    }
  }

  useEffect(() => {
    if (typeof window !== "undefined" && address) {
      refreshAll();
    }
    // eslint-disable-next-line
  }, [address]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      fetchPrices();
    }
    // eslint-disable-next-line
  }, []);

  async function supply(token: TokenConfig) {
    setLoading(true);
    setTxStatus("Supplying...");
    setError("");
    const provider = getProvider();
    try {
      if (!provider) throw new Error("No provider found.");
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        setError("Enter a valid amount.");
        setLoading(false);
        setTxStatus("");
        return;
      }
      const signer = await provider.getSigner();
      const erc20 = new Contract(token.address, token.abi ?? [], signer);
      const lend = new Contract(contracts.LendingProtocol.address, contracts.LendingProtocol.abi ?? [], signer);
      const amt = parseUnits(amount, token.decimals);

      const lendAddress = await lend.getAddress();
      const allowance = await erc20.allowance(address, lendAddress);
      if (allowance < amt) {
        setTxStatus("Approving...");
        const tx = await erc20.approve(lendAddress, amt);
        await tx.wait();
      }
      setTxStatus("Supplying...");
      const tx = await lend.supply(token.address, amt, address);
      await tx.wait();
      setAmount("");
      setTxStatus("Supply successful!");
      await refreshAll();
    } catch (e: any) {
      setError(e.message || "Supply failed.");
      setTxStatus("");
    }
    setLoading(false);
  }

  async function borrow(token: TokenConfig) {
    setLoading(true);
    setTxStatus("Borrowing...");
    setError("");
    const provider = getProvider();
    try {
      if (!provider) throw new Error("No provider found.");
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        setError("Enter a valid amount.");
        setLoading(false);
        setTxStatus("");
        return;
      }
      if (balances[token.symbol] && Number(balances[token.symbol]) > 0) {
        setError("Cannot borrow the same asset you supplied as collateral.");
        setLoading(false);
        setTxStatus("");
        return;
      }
      const price = prices[token.symbol] ?? 1;
      const amt = parseUnits(amount, token.decimals);
      const usdValue = Number(amount) * price;
      if (accountData && usdValue > accountData.availableBorrowsUSD) {
        setError("Amount exceeds available borrow limit.");
        setLoading(false);
        setTxStatus("");
        return;
      }
      const signer = await provider.getSigner();
      const lend = new Contract(contracts.LendingProtocol.address, contracts.LendingProtocol.abi ?? [], signer);

      const tx = await lend.borrow(token.address, amt, 0, address);
      await tx.wait();
      setAmount("");
      setTxStatus("Borrow successful!");
      await refreshAll();
    } catch (e: any) {
      setError(e.message || "Borrow failed.");
      setTxStatus("");
    }
    setLoading(false);
  }

  async function repay(token: TokenConfig) {
    setLoading(true);
    setTxStatus("Repaying...");
    setError("");
    const provider = getProvider();
    try {
      if (!provider) throw new Error("No provider found.");
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        setError("Enter a valid amount.");
        setLoading(false);
        setTxStatus("");
        return;
      }
      const signer = await provider.getSigner();
      const erc20 = new Contract(token.address, token.abi ?? [], signer);
      const lend = new Contract(contracts.LendingProtocol.address, contracts.LendingProtocol.abi ?? [], signer);
      const amt = parseUnits(amount, token.decimals);

      const lendAddress = await lend.getAddress();
      const allowance = await erc20.allowance(address, lendAddress);
      if (allowance < amt) {
        setTxStatus("Approving...");
        const tx = await erc20.approve(lendAddress, amt);
        await tx.wait();
      }
      setTxStatus("Repaying...");
      const tx = await lend.repay(token.address, amt, address);
      await tx.wait();
      setAmount("");
      setTxStatus("Repay successful!");
      await refreshAll();
    } catch (e: any) {
      setError(e.message || "Repay failed.");
      setTxStatus("");
    }
    setLoading(false);
  }

  async function withdraw(token: TokenConfig) {
    setLoading(true);
    setTxStatus("Withdrawing...");
    setError("");
    const provider = getProvider();
    try {
      if (!provider) throw new Error("No provider found.");
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        setError("Enter a valid amount.");
        setLoading(false);
        setTxStatus("");
        return;
      }
      const signer = await provider.getSigner();
      const lend = new Contract(contracts.LendingProtocol.address, contracts.LendingProtocol.abi ?? [], signer);
      const amt = parseUnits(amount, token.decimals);

      const tx = await lend.withdraw(token.address, amt, address);
      await tx.wait();
      setAmount("");
      setTxStatus("Withdraw successful!");
      await refreshAll();
    } catch (e: any) {
      setError(e.message || "Withdraw failed.");
      setTxStatus("");
    }
    setLoading(false);
  }

  function handleTokenAction(token: TokenConfig) {
    setSelectedToken(token);
    setAmount("");
    setError("");
    setTxStatus("");
    setTimeout(() => {
      const input = document.getElementById("amount-input");
      if (input) (input as HTMLInputElement).focus();
    }, 100);
  }

  function getMaxBorrowable(token: TokenConfig) {
    if (!accountData || !prices[token.symbol]) return 0;
    if (balances[token.symbol] && Number(balances[token.symbol]) > 0) return 0;
    return accountData.availableBorrowsUSD / prices[token.symbol];
  }

  function getAmountInUSD(token: TokenConfig) {
    if (!amount || !prices[token.symbol]) return 0;
    return Number(amount) * prices[token.symbol];
  }

  // Helper to format event display
  function formatEventRow(tx: any, idx: number) {
    const { event, args, blockNumber, transactionHash } = tx;
    let desc = "";
    if (!args) return null;
    if (event === "Supply")
      desc = `Supplied ${formatTokenUnits(args.amount, tokensByAddress(args.asset)?.decimals ?? 18)} ${symbolByAddress(args.asset)} to protocol.`;
    else if (event === "Borrow")
      desc = `Borrowed ${formatTokenUnits(args.amount, tokensByAddress(args.asset)?.decimals ?? 18)} ${symbolByAddress(args.asset)}.`;
    else if (event === "Repay")
      desc = `Repaid ${formatTokenUnits(args.amount, tokensByAddress(args.asset)?.decimals ?? 18)} ${symbolByAddress(args.asset)}.`;
    else if (event === "Withdraw")
      desc = `Withdrew ${formatTokenUnits(args.amount, tokensByAddress(args.asset)?.decimals ?? 18)} ${symbolByAddress(args.asset)}.`;
    else if (event === "Liquidation")
      desc = `Liquidated: Debt ${formatTokenUnits(args.debtToCover, tokensByAddress(args.debtAsset)?.decimals ?? 18)} ${symbolByAddress(args.debtAsset)}, Collateral ${formatTokenUnits(args.liquidatedCollateralAmount, tokensByAddress(args.collateralAsset)?.decimals ?? 18)} ${symbolByAddress(args.collateralAsset)}.`;
    return (
      <div key={transactionHash + idx} className="mb-2 border-b pb-1">
        <span className="font-bold">{event}</span> | {desc}
        <br />
        <span className="text-gray-500">Block: {blockNumber}</span>
        <span className="ml-2 text-gray-400">Tx: {transactionHash.slice(0, 10)}...</span>
      </div>
    );
  }

  // Helper to get token symbol by address
  function symbolByAddress(addr: string) {
    for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) {
      if (tokens[k].address.toLowerCase() === addr.toLowerCase()) return tokens[k].symbol;
    }
    return "???";
  }
  function tokensByAddress(addr: string) {
    for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) {
      if (tokens[k].address.toLowerCase() === addr.toLowerCase()) return tokens[k];
    }
    return undefined;
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#e0e7ff] to-[#e6fff7] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl p-8 md:p-12 border border-blue-100">
        <h1 className="text-4xl font-extrabold text-center text-blue-700 mb-8 tracking-tight drop-shadow">Lending Protocol Demo</h1>
        {error && (
          <div className="bg-red-100 text-red-700 px-4 py-2 rounded mb-4 text-center font-semibold shadow">{error}</div>
        )}
        {txStatus && (
          <div className="bg-blue-100 text-blue-700 px-4 py-2 rounded mb-4 text-center font-semibold shadow flex items-center justify-center gap-2">
            {loading && <span className="animate-spin inline-block w-4 h-4 border-2 border-blue-700 border-t-transparent rounded-full"></span>}
            {txStatus}
          </div>
        )}
        {!address ? (
          <button
            onClick={connectWallet}
            className="w-full bg-gradient-to-r from-blue-600 to-blue-400 hover:from-blue-700 hover:to-blue-500 text-white font-bold py-3 rounded-xl text-lg shadow transition"
          >
            Connect Wallet
          </button>
        ) : (
          <>
            <div className="mb-6 flex flex-col md:flex-row md:justify-between items-center gap-2">
              <div className="font-semibold text-gray-700 text-lg">
                Connected: <span className="text-blue-700 font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span>
              </div>
              <button
                onClick={() => refreshAll()}
                className="mt-2 md:mt-0 bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-1 rounded shadow text-sm"
              >
                Refresh
              </button>
            </div>
            <div className="mb-8">
              <h2 className="font-semibold mb-2 text-gray-800 text-lg">Balances</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {Object.entries(balances).map(([sym, bal]) => (
                  <div key={sym} className="bg-blue-50 rounded-xl p-4 text-center shadow border border-blue-100">
                    <span className="font-bold text-gray-600">{sym}</span>
                    <div className="text-blue-700 text-2xl font-mono">{bal}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      Price: <span className="font-bold">${prices[sym as keyof typeof prices] ?? "?"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mb-8">
              <h2 className="font-semibold mb-2 text-gray-800 text-lg">Account Data</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-base">
                <div className="bg-gray-50 rounded-xl p-4 shadow-sm">Collateral (USD): <span className="font-bold">{accountData?.totalCollateralUSD ?? 0}</span></div>
                <div className="bg-gray-50 rounded-xl p-4 shadow-sm">Debt (USD): <span className="font-bold">{accountData?.totalDebtUSD ?? 0}</span></div>
                <div className="bg-gray-50 rounded-xl p-4 shadow-sm">Available Borrow (USD): <span className="font-bold">{accountData?.availableBorrowsUSD ?? 0}</span></div>
                <div className="bg-gray-50 rounded-xl p-4 shadow-sm">Health Factor: <span className={`font-bold ${accountData?.healthFactor < 1.1 ? "text-red-600" : "text-green-700"}`}>{accountData?.healthFactor ?? 0}</span></div>
              </div>
            </div>
            <div className="mb-4">
              <h2 className="font-semibold mb-2 text-gray-800 text-lg">Supply / Borrow / Repay / Withdraw</h2>
              <div className="flex flex-wrap gap-3 mb-4">
                {Object.entries(tokens).map(([sym, token]) => (
                  <button
                    key={sym}
                    disabled={loading}
                    onClick={() => handleTokenAction(token)}
                    className={`px-5 py-2 rounded-xl shadow transition font-semibold text-base ${
                      selectedToken?.symbol === sym
                        ? "bg-blue-700 text-white"
                        : "bg-green-600 hover:bg-green-700 text-white"
                    }`}
                  >
                    {selectedToken?.symbol === sym ? "Selected" : `Select ${sym}`}
                  </button>
                ))}
              </div>
              {selectedToken && (
                <div className="flex flex-col gap-3">
                  <input
                    id="amount-input"
                    type="number"
                    min="0"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="border border-gray-300 rounded-xl px-4 py-3 flex-1 text-lg font-mono shadow"
                    placeholder={`Amount of ${selectedToken.symbol}`}
                    disabled={loading}
                  />
                  <div className="text-xs text-gray-500 mb-2">
                    {amount && prices[selectedToken.symbol as keyof typeof prices] && (
                      <>≈ ${(getAmountInUSD(selectedToken)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD</>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      disabled={loading || !amount || Number(amount) <= 0}
                      onClick={() => supply(selectedToken)}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-xl shadow font-bold text-base"
                    >
                      {loading && txStatus.startsWith("Supplying") ? (
                        <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></span>
                      ) : null}
                      Supply
                    </button>
                    <button
                      disabled={
                        loading ||
                        !amount ||
                        Number(amount) <= 0 ||
                        getMaxBorrowable(selectedToken) === 0 ||
                        Number(amount) > getMaxBorrowable(selectedToken)
                      }
                      onClick={() => borrow(selectedToken)}
                      className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-xl shadow font-bold text-base"
                    >
                      {loading && txStatus.startsWith("Borrowing") ? (
                        <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></span>
                      ) : null}
                      Borrow
                    </button>
                    <button
                      disabled={loading || !amount || Number(amount) <= 0}
                      onClick={() => repay(selectedToken)}
                      className="bg-yellow-500 hover:bg-yellow-600 text-white px-6 py-2 rounded-xl shadow font-bold text-base"
                    >
                      {loading && txStatus.startsWith("Repaying") ? (
                        <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></span>
                      ) : null}
                      Repay
                    </button>
                    <button
                      disabled={loading || !amount || Number(amount) <= 0}
                      onClick={() => withdraw(selectedToken)}
                      className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-xl shadow font-bold text-base"
                    >
                      {loading && txStatus.startsWith("Withdrawing") ? (
                        <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></span>
                      ) : null}
                      Withdraw
                    </button>
                  </div>
                  <div className="text-xs text-gray-500 mt-1 flex flex-col gap-1">
                    {accountData && (
                      <>
                        <span>
                          Max borrowable {selectedToken.symbol}:{" "}
                          <span className="font-bold">
                            {formatTokenUnits(getMaxBorrowable(selectedToken), selectedToken.decimals)}
                          </span>
                        </span>
                        <span>
                          Token price: <span className="font-bold">${prices[selectedToken.symbol as keyof typeof prices] ?? "?"}</span>
                        </span>
                        {balances[selectedToken.symbol] && Number(balances[selectedToken.symbol]) > 0 && (
                          <span className="text-red-600 font-semibold">
                            You cannot borrow the same asset you supplied as collateral.
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="mb-8">
              <h2 className="font-semibold mb-2 text-gray-800 text-lg">Transaction History</h2>
              <div className="bg-gray-50 rounded-xl p-4 shadow-sm max-h-64 overflow-y-auto text-xs">
                {txHistory.length === 0 && <div>No transactions yet.</div>}
                {txHistory.map(formatEventRow)}
              </div>
            </div>
          </>
        )}
        <div className="mt-8 text-xs text-gray-400 text-center">
          Powered by ethers.js, Next.js, and Hardhat.<br />
          For demo purposes only.
        </div>
      </div>
    </main>
  );
}