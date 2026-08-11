import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BankStore, BankingError } from "./bankStore.js";

const bank = new BankStore(process.env.BANK_DATA_DIRECTORY);

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toolError(error: unknown) {
  const message =
    error instanceof BankingError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Unknown banking error.";

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "sample-banking-mcp",
    version: "1.0.0",
  });

  server.tool(
    "list-customers",
    "List all customers in the sample bank",
    async () => toolResult(await bank.listCustomers())
  );

  server.tool(
    "get-customer",
    "Get a customer by customer ID",
    { customerId: z.string().min(1).describe("Customer ID") },
    async ({ customerId }) => {
      try {
        return toolResult(await bank.getCustomer(customerId));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "list-accounts",
    "List bank accounts, optionally filtered by customer ID",
    {
      customerId: z
        .string()
        .min(1)
        .optional()
        .describe("Optional customer ID filter"),
    },
    async ({ customerId }) => toolResult(await bank.listAccounts(customerId))
  );

  server.tool(
    "balance-inquiry",
    "Get the current balance and status for an account",
    { accountId: z.string().min(1).describe("Account ID") },
    async ({ accountId }) => {
      try {
        const account = await bank.getAccount(accountId);
        return toolResult({
          accountId: account.accountId,
          customerId: account.customerId,
          type: account.type,
          status: account.status,
          balance: account.balance,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  const transactionInput = {
    accountId: z.string().min(1).describe("Account ID"),
    amount: z.number().positive().describe("Positive amount in dollars"),
    description: z
      .string()
      .max(200)
      .optional()
      .describe("Optional transaction description"),
  };

  server.tool(
    "deposit",
    "Deposit funds into an active account",
    transactionInput,
    async ({ accountId, amount, description }) => {
      try {
        return toolResult(await bank.deposit(accountId, amount, description));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "withdraw",
    "Withdraw funds from an active account; rejects withdrawals that exceed the available balance",
    transactionInput,
    async ({ accountId, amount, description }) => {
      try {
        return toolResult(await bank.withdraw(accountId, amount, description));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "transaction-history",
    "Get the detailed transaction log, optionally filtered by account or customer",
    {
      accountId: z.string().min(1).optional().describe("Optional account ID"),
      customerId: z.string().min(1).optional().describe("Optional customer ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum transactions to return"),
    },
    async (query) => toolResult(await bank.getTransactions(query))
  );

  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "sample-banking-mcp" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

app
  .listen(port, host, () => {
    console.log(`Sample Banking MCP server listening at http://${host}:${port}`);
  })
  .on("error", (error) => {
    console.error("Failed to start the server:", error);
    process.exitCode = 1;
  });
