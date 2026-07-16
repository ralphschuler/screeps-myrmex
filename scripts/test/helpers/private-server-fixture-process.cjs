"use strict";

const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const process = require("node:process");
const fixture = require("../../../integration/private-server/fixtures/myrmex-fixture.cjs");

const processType = process.env.MYRMEX_TEST_PROCESS_TYPE;
if (processType !== "processor" && processType !== "runner") {
  throw new TypeError("Fixture test process type is invalid.");
}

const engine = new EventEmitter();
const storage = {
  env: {
    get: async () => undefined,
    keys: { GAMETIME: "gameTime" },
    set: async (key, value) => send({ key, processType, type: "receipt", value }),
  },
  pubsub: {
    keys: { RUNTIME_RESTART: "runtimeRestart" },
    publish: async () => undefined,
  },
};

fixture({ engine }, null, storage, process.env, fs);
engine.emit("init", processType);
send({ processType, type: "initialized" });

process.on("disconnect", () => process.exit(0));
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function fail(error) {
  send({ message: error instanceof Error ? error.message : String(error), type: "failure" });
  process.exitCode = 1;
}
