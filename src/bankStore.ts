import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const customerSchema = z.object({
  first: z.string().min(1),
  last: z.string().min(1),
  customerId: z.string().min(1),
});

const accountSchema = z.object({
  type: z.enum(["checking", "savings"]),
  dateOpened: z.string().datetime(),
  balance: z.number().nonnegative(),
  status: z.enum(["closed", "active", "frozen"]),
  customerId: z.string().min(1),
  accountId: z.string().min(1),
});

const transactionSchema = z.object({
  transactionId: z.string().min(1),
  accountId: z.string().min(1),
  customerId: z.string().min(1),
  type: z.enum(["deposit", "withdrawal"]),
  amount: z.number().positive(),
  balanceBefore: z.number().nonnegative(),
  balanceAfter: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  description: z.string(),
});

export type Customer = z.infer<typeof customerSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionType = Transaction["type"];

export class BankingError extends Error {
  constructor(
    public readonly code:
      | "ACCOUNT_NOT_FOUND"
      | "CUSTOMER_NOT_FOUND"
      | "ACCOUNT_NOT_ACTIVE"
      | "INSUFFICIENT_FUNDS"
      | "INVALID_AMOUNT",
    message: string
  ) {
    super(message);
    this.name = "BankingError";
  }
}

export interface TransactionQuery {
  accountId?: string;
  customerId?: string;
  limit?: number;
}

export class BankStore {
  private readonly customersPath: string;
  private readonly accountsPath: string;
  private readonly transactionsPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDirectory = path.join(process.cwd(), "data")) {
    this.customersPath = path.join(dataDirectory, "customers.json");
    this.accountsPath = path.join(dataDirectory, "accounts.json");
    this.transactionsPath = path.join(dataDirectory, "transactions.json");
  }

  async listCustomers(): Promise<Customer[]> {
    return this.readJson(this.customersPath, z.array(customerSchema));
  }

  async getCustomer(customerId: string): Promise<Customer> {
    const customer = (await this.listCustomers()).find(
      (item) => item.customerId === customerId
    );
    if (!customer) {
      throw new BankingError(
        "CUSTOMER_NOT_FOUND",
        `Customer '${customerId}' was not found.`
      );
    }
    return customer;
  }

  async listAccounts(customerId?: string): Promise<Account[]> {
    const accounts = await this.readJson(
      this.accountsPath,
      z.array(accountSchema)
    );
    return customerId
      ? accounts.filter((account) => account.customerId === customerId)
      : accounts;
  }

  async getAccount(accountId: string): Promise<Account> {
    const account = (await this.listAccounts()).find(
      (item) => item.accountId === accountId
    );
    if (!account) {
      throw new BankingError(
        "ACCOUNT_NOT_FOUND",
        `Account '${accountId}' was not found.`
      );
    }
    return account;
  }

  async getTransactions(query: TransactionQuery = {}): Promise<Transaction[]> {
    const transactions = await this.readJson(
      this.transactionsPath,
      z.array(transactionSchema)
    );
    const filtered = transactions
      .filter(
        (transaction) =>
          (!query.accountId || transaction.accountId === query.accountId) &&
          (!query.customerId || transaction.customerId === query.customerId)
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return filtered.slice(0, query.limit ?? 100);
  }

  async deposit(
    accountId: string,
    amount: number,
    description = "Deposit"
  ): Promise<Transaction> {
    return this.enqueueMutation(() =>
      this.recordTransaction(accountId, amount, "deposit", description)
    );
  }

  async withdraw(
    accountId: string,
    amount: number,
    description = "Withdrawal"
  ): Promise<Transaction> {
    return this.enqueueMutation(() =>
      this.recordTransaction(accountId, amount, "withdrawal", description)
    );
  }

  private async recordTransaction(
    accountId: string,
    amount: number,
    type: TransactionType,
    description: string
  ): Promise<Transaction> {
    const normalizedAmount = this.normalizeAmount(amount);
    const accounts = await this.listAccounts();
    const accountIndex = accounts.findIndex(
      (account) => account.accountId === accountId
    );

    if (accountIndex === -1) {
      throw new BankingError(
        "ACCOUNT_NOT_FOUND",
        `Account '${accountId}' was not found.`
      );
    }

    const account = accounts[accountIndex];
    if (account.status !== "active") {
      throw new BankingError(
        "ACCOUNT_NOT_ACTIVE",
        `Account '${accountId}' is ${account.status}; transactions require an active account.`
      );
    }

    if (type === "withdrawal" && normalizedAmount > account.balance) {
      throw new BankingError(
        "INSUFFICIENT_FUNDS",
        `Insufficient funds: account balance is ${account.balance.toFixed(2)}, but the requested withdrawal is ${normalizedAmount.toFixed(2)}.`
      );
    }

    const balanceBefore = account.balance;
    const balanceAfter = this.toCurrency(
      type === "deposit"
        ? balanceBefore + normalizedAmount
        : balanceBefore - normalizedAmount
    );
    const transaction: Transaction = {
      transactionId: randomUUID(),
      accountId,
      customerId: account.customerId,
      type,
      amount: normalizedAmount,
      balanceBefore,
      balanceAfter,
      timestamp: new Date().toISOString(),
      description: description.trim() || (type === "deposit" ? "Deposit" : "Withdrawal"),
    };

    accounts[accountIndex] = { ...account, balance: balanceAfter };
    const transactions = await this.readJson(
      this.transactionsPath,
      z.array(transactionSchema)
    );

    await this.writeJson(this.accountsPath, accounts);
    try {
      await this.writeJson(this.transactionsPath, [...transactions, transaction]);
    } catch (error) {
      await this.writeJson(this.accountsPath, accounts.map((item, index) =>
        index === accountIndex ? account : item
      ));
      throw error;
    }

    return transaction;
  }

  private normalizeAmount(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BankingError(
        "INVALID_AMOUNT",
        "Transaction amount must be a positive number."
      );
    }

    const normalized = this.toCurrency(amount);
    if (normalized <= 0) {
      throw new BankingError(
        "INVALID_AMOUNT",
        "Transaction amount must be at least 0.01."
      );
    }
    return normalized;
  }

  private toCurrency(amount: number): number {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
    const contents = await readFile(filePath, "utf8");
    return schema.parse(JSON.parse(contents));
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  }
}
