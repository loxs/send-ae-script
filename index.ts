import * as sdk from "@aeternity/aepp-sdk"
const {
  AeSdkWallet,
  getHdWalletAccountFromSeed,
  MemoryAccount,
  Node,
  WALLET_TYPE,
  Tag,
  unpackTx, AeSdk
} = sdk;
// const WebSocketClient = require("websocket").client;
import { client as WebSocketClient } from "websocket";
import { z } from "zod";
import { Logger } from "tslog";

export const AccountPubKey = z.custom<`ak_${string}`>(
  (v) => typeof v === "string" && v.startsWith("ak_")
);
export type AccountPubKey = z.infer<typeof AccountPubKey>;

const SELECTED_NETWORK = process.argv[2];
const SENDER_SEED_PHRASE = process.argv[3];
const RECIPIENT_ADDRESS = AccountPubKey.parse(process.argv[4]);

const bip39 = require("bip39");
const fs = require("fs");
const JSONbig = require("json-bigint");

const JSONbigConfigured = JSONbig({
  useNativeBigInt: true,
  storeAsString: false,
  alwaysParseAsBig: true,
});
const startTime = new Date().toISOString();

const logger = new Logger();
logger.attachTransport((logObj) => {
  const logsDir = "ae-sender-logs";
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, "0o777");
  }
  const logFile = `${logsDir}/${startTime}.txt`;
  fs.appendFileSync(
    logFile,
    JSONbigConfigured.stringify(logObj, null, 2) + "\n"
  );
});

const WS_URL = `wss://${SELECTED_NETWORK}.aeternity.io/mdw/websocket`;

function accountFromMnemonic(mnemonic: string) {
  const secret = bip39.mnemonicToSeedSync(mnemonic);
  const acc = getHdWalletAccountFromSeed(secret, 0);
  return {
    mnemonic,
    privKey: acc.secretKey,
    addr: AccountPubKey.parse(acc.publicKey),
  };
}

const aeSdk = new AeSdkWallet({
  compilerUrl: "https://compiler.aepps.com",
  nodes: [
    {
      name: SELECTED_NETWORK,
      instance: new Node(`https://${SELECTED_NETWORK}.aeternity.io`),
    },
  ],
  id: "node",
  type: WALLET_TYPE.extension,
  name: "Wallet Node",
  // Hook for sdk registration
  onConnection(aeppId, params) {
    logger.info("onConnection ::", aeppId, params);
  },
  onDisconnect(msg, client) {
    logger.info("onDisconnect ::", msg, client);
  },
  onSubscription(aeppId) {
    logger.info("onSubscription ::", aeppId);
  },
  async onSign(aeppId, params) {
    logger.info("onSign ::", aeppId, params);
    return params;
  },
  onAskAccounts(aeppId) {
    logger.info("onAskAccounts ::", aeppId);
  },
  async onMessageSign(aeppId, params) {
    logger.info("onMessageSign ::", aeppId, params);
  },
});

async function connectWallet(): Promise<`ak_${string}`> {
  const acc = accountFromMnemonic(SENDER_SEED_PHRASE);
  const account = new MemoryAccount({
    keypair: { publicKey: acc.addr, secretKey: acc.privKey },
  });
  await aeSdk.addAccount(account, { select: true });
  const senderAddr = await account.address();
  logger.info("connected wallet ::", senderAddr);
  return senderAddr
}

async function checkAddressBalance(address: AccountPubKey) {
  const pending = await aeSdk.api.getPendingAccountTransactionsByPubkey(address);
  console.log("pending", pending);
  const balance = await aeSdk.getBalance(address);
  logger.info(`Balance of ${address}: ${balance} aettos`);
  return balance;
}

async function sendCoins(sender: AccountPubKey, receiver: AccountPubKey) {
  const balance = BigInt(await checkAddressBalance(sender));
  logger.info("RECIPIENT_ADDRESS ::", RECIPIENT_ADDRESS);
  if (balance > 0) {
    logger.info("sender", sender, "receiver", receiver, "amount", balance)
    const spendTx = await aeSdk.buildTx(Tag.SpendTx, {
      senderId: sender,
      recipientId: receiver,
      amount: balance.toString(),
    });

    const unpackedTx = unpackTx(spendTx, Tag.SpendTx);
    const fee = Number(unpackedTx.tx.fee);

    const finalAmount = Number(balance) - fee;

    if (finalAmount > 0) {
      const tx = await aeSdk.spend(finalAmount, RECIPIENT_ADDRESS);
      logger.info("final sent amount ::", finalAmount);
      logger.info("Transaction mined ::", tx);
    } else {
      logger.info("no enough balance ::", finalAmount);
    }
  } else {
    logger.info("no balance ::", balance);
  }

  await checkAddressBalance(RECIPIENT_ADDRESS);
}

// listen for new block generation
async function listenForNewBlocGeneration(senderAddr: AccountPubKey) {
  const wsClient = new WebSocketClient();

  wsClient.on("connectFailed", function (error) {
    logger.info("Connect Error: " + error.toString());
  });

  wsClient.on("connect", function (connection) {
    logger.info("WebSocket Client Connected");
    connection.on("error", function (error) {
      logger.info("Connection Error: " + error.toString());
    });
    connection.on("close", function () {
      logger.info("echo-protocol Connection Closed");
    });
    connection.on("message", function (message) {
      if (message.type === "utf8") {
        logger.info("New KeyBlocks Send sendCoins() ::");

        sendCoins(senderAddr, RECIPIENT_ADDRESS);
      }
    });

    connection.sendUTF('{"op":"Subscribe", "payload": "KeyBlocks"}');
  });

  wsClient.connect(WS_URL);
}
async function init() {
  const senderAddr = await connectWallet();
  await listenForNewBlocGeneration(senderAddr);
}

init();
// keep script alive
(function keepProcessRunning() {
  setTimeout(keepProcessRunning, 1 << 30);
})();