"use strict";

const amqp = require("amqplib");

const queueName = process.env.RABBITMQ_QUEUE || "task_events";
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const deadLetterQueueName = `${queueName}.dead_letter`;
const maxRetries = Number.parseInt(process.env.WORKER_MAX_RETRIES || "3", 10);

let connection;
let channel;

async function initRabbitmq() {
  if (channel) {
    return channel;
  }

  connection = await amqp.connect(rabbitUrl);
  channel = await connection.createChannel();
  await channel.assertQueue(queueName, { durable: true });
  await channel.assertQueue(deadLetterQueueName, { durable: true });

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

async function consumeTaskEvents(handler, options = {}) {
  if (!channel) {
    await initRabbitmq();
  }

  const { onRetry, onExhausted } = options;
  await channel.consume(
    queueName,
    async (msg) => {
      if (!msg) {
        return;
      }
      const content = JSON.parse(msg.content.toString());
      const retryCount = Number(msg.properties?.headers?.["x-retry-count"] || 0);
      const metadata = {
        retryCount,
        maxRetries,
      };

      try {
        await handler(content, metadata);
        channel.ack(msg);
      } catch (error) {
        const nextRetryCount = retryCount + 1;

        if (retryCount < maxRetries) {
          channel.sendToQueue(queueName, Buffer.from(JSON.stringify(content)), {
            persistent: true,
            headers: {
              ...msg.properties?.headers,
              "x-retry-count": nextRetryCount,
            },
          });
          channel.ack(msg);
          if (typeof onRetry === "function") {
            await onRetry(content, error, {
              ...metadata,
              nextRetryCount,
            });
          }
          console.warn(
            "[queue-retry] Requeued event",
            content?.type,
            "attempt",
            nextRetryCount,
            "of",
            maxRetries
          );
          return;
        }

        const deadLetterMessage = {
          failed_at: new Date().toISOString(),
          event: content,
          error: {
            message: error?.message || "Unknown worker failure",
          },
          retry_count: retryCount,
          max_retries: maxRetries,
        };

        channel.sendToQueue(
          deadLetterQueueName,
          Buffer.from(JSON.stringify(deadLetterMessage)),
          {
            persistent: true,
          }
        );
        channel.ack(msg);
        console.error(
          "[queue-exhausted] Moved event to dead letter queue",
          content?.type
        );

        if (typeof onExhausted === "function") {
          await onExhausted(content, error, metadata);
        }
      }
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
