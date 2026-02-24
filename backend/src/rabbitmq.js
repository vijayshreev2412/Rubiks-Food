"use strict";

const amqp = require("amqplib");
const tracer = require("dd-trace");

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

  const headers = {};
  const activeSpan = tracer.scope().active();
  if (activeSpan) {
    tracer.inject(activeSpan.context(), "text_map", headers);
  }

  const buffer = Buffer.from(JSON.stringify(payload));
  channel.sendToQueue(queueName, buffer, { persistent: true, headers });
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

      const parentContext = tracer.extract(
        "text_map",
        msg.properties.headers || {}
      );

      const content = JSON.parse(msg.content.toString());

      const span = tracer.startSpan("worker.handle_task_event", {
        childOf: parentContext || undefined,
        resource: content?.type ?? "unknown",
        tags: { "task.id": content?.payload?.id },
      });

      tracer.scope().activate(span, async () => {
        try {
          await handler(content);
        } catch (error) {
          span.setTag("error", error);
          console.error("[queue] Failed to handle event", content, error);
        } finally {
          span.finish();
          channel.ack(msg);
        }
      });
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
