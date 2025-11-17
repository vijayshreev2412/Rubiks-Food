"use strict";

const amqp = require("amqplib");

const queueName = process.env.RABBITMQ_QUEUE || "task_events";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://localhost:5672";

let connection;
let channel;

async function initRabbitmq() {
  if (channel) {
    return channel;
  }

  connection = await amqp.connect(rabbitUrl);
  channel = await connection.createChannel();
  await channel.assertQueue(queueName, { durable: true });

  connection.on("error", (err) => {
    console.error("[rabbitmq] connection error", err);
  });

  connection.on("close", () => {
    console.warn("[rabbitmq] connection closed");
    connection = null;
    channel = null;
  });

  return channel;
}

async function publishTaskEvent(payload) {
  if (!channel) {
    await initRabbitmq();
  }

  const buffer = Buffer.from(JSON.stringify(payload));
  channel.sendToQueue(queueName, buffer, { persistent: true });
}

async function consumeTaskEvents(handler) {
  if (!channel) {
    await initRabbitmq();
  }

  await channel.consume(
    queueName,
    (msg) => {
      if (!msg) {
        return;
      }
      const content = JSON.parse(msg.content.toString());
      handler(content);
      channel.ack(msg);
    },
    { noAck: false }
  );
}

async function closeRabbitmq() {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}

module.exports = {
  initRabbitmq,
  publishTaskEvent,
  consumeTaskEvents,
  closeRabbitmq,
};
