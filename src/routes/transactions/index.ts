import axios from "axios";
import { Router } from "express";

const router = Router();

const getTransactionLink = (chain: string, txHash: string) => {
  switch (chain.toLowerCase()) {
    case "gnosis":
      return `https://gnosisscan.io/tx/${txHash}`;
    case "base":
      return `https://basescan.org/tx/${txHash}`;
    case "mainnet":
      return `https://etherscan.io/tx/${txHash}`;
    default:
      return "";
  }
};

router.get("/", async (req: any, res) => {
  try {
    const graphQLURL =
      "https://agentscan-agentindexing-kx37-uncomment-void.ponder-dev.com";
    const limit = 20;
    const cursor = req.query.cursor || null;
    const chain = req.query.chain?.toLowerCase();
    const instance = req.query.instance;

    if (chain && !["base", "gnosis", "mainnet"].includes(chain)) {
      return res.status(400).json({ message: "Invalid chain parameter" });
    }

    const response = await axios.post(graphQLURL, {
      query: `query getTransactions {
        agentFromTransactions(
          limit: ${limit}${cursor ? `, after: "${cursor}"` : ""}
          where: { agentInstanceId: "${instance}" }
          ${chain ? `, chain: "${chain}"` : ""}
          orderBy: "timestamp"
          orderDirection: "desc"
        ) {
          pageInfo {
            endCursor
          }
          items {
            timestamp
            transactionHash
            chain
            transaction {
              from
              to
              value
              logs {
                items {
                  decodedData
                  eventName
                }
              }
            }
          }
        }
      }`,
    });

    const transactions = response?.data?.data?.agentFromTransactions?.items.map(
      (item: any) => ({
        timestamp: item.timestamp,
        transactionHash: item.transactionHash,
        chain: item.chain,
        transaction: {
          from: item.transaction.from,
          to: item.transaction.to,
          logs: item.transaction.logs.items,
        },
        transactionLink: getTransactionLink(item.chain, item.transactionHash),
      })
    );

    const nextCursor =
      response?.data?.data?.agentFromTransactions?.pageInfo?.endCursor || null;

    if (!transactions || transactions.length === 0) {
      return res.status(200).json({
        transactions: [],
        nextCursor: null,
      });
    }

    return res.status(200).json({ transactions, nextCursor });
  } catch (error: any) {
    if (error.message === "No transactions found") {
      return res.status(404).json({ message: "No transactions found" });
    }
    console.error("Error processing transactions:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
