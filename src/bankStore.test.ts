import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BankStore, BankingError } from "./bankStore.js";

async function createStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sample-bank-"));
  await writeFile(
    path.join(directory, "customers.json"),
    JSON.stringify([{ first: "Test", last: "Customer", customerId: "C001" }])
  );
  await writeFile(
    path.join(directory, "accounts.json"),
    JSON.stringify([
      {
        type: "checking",
        dateOpened: "2025-01-01T00:00:00.000Z",
        balance: 100,
        status: "active",
        customerId: "C001",
        accountId: "A001",
      },
      {
        type: "savings",
        dateOpened: "2025-01-01T00:00:00.000Z",
        balance: 50,
        status: "frozen",
        customerId: "C001",
        accountId: "A002",
      },
    ])
  );
  await writeFile(path.join(directory, "transactions.json"), "[]");
  return { directory, store: new BankStore(directory) };
}

test("deposits update the balance and transaction log", async () => {
  const { directory, store } = await createStore();
  try {
    const transaction = await store.deposit("A001", 25.555, "Cash deposit");
    assert.equal(transaction.amount, 25.56);
    assert.equal(transaction.balanceAfter, 125.56);
    assert.equal((await store.getAccount("A001")).balance, 125.56);
    assert.equal((await store.getTransactions({ accountId: "A001" })).length, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("withdrawals reject insufficient funds without changing data", async () => {
  const { directory, store } = await createStore();
  try {
    await assert.rejects(
      store.withdraw("A001", 100.01),
      (error: unknown) =>
        error instanceof BankingError &&
        error.code === "INSUFFICIENT_FUNDS"
    );
    assert.equal((await store.getAccount("A001")).balance, 100);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(directory, "transactions.json"), "utf8")
      ),
      []
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("transactions reject frozen accounts", async () => {
  const { directory, store } = await createStore();
  try {
    await assert.rejects(
      store.withdraw("A002", 10),
      (error: unknown) =>
        error instanceof BankingError &&
        error.code === "ACCOUNT_NOT_ACTIVE"
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("concurrent withdrawals are serialized", async () => {
  const { directory, store } = await createStore();
  try {
    const results = await Promise.allSettled([
      store.withdraw("A001", 60),
      store.withdraw("A001", 60),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.equal((await store.getAccount("A001")).balance, 40);
  } finally {
    await rm(directory, { recursive: true });
  }
});
