import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { IrcService } from "./service.js";

const services: IrcService[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function waitForConnection(server: net.Server): Promise<net.Socket> {
  return new Promise((resolve) => server.once("connection", resolve));
}

function waitForText(socket: net.Socket, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}; received ${received}`)), 1_000);
    socket.on("data", (data) => {
      received += data.toString();
      if (received.includes(expected)) {
        clearTimeout(timeout);
        resolve(received);
      }
    });
  });
}

describe("IrcService", () => {
  it("holds application messages until registration completes", async () => {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const connection = waitForConnection(server);
    const service = new IrcService(
      { host: "127.0.0.1", port: address.port, tls: false, nick: "yoplai", channels: [] },
      () => {},
      { info: () => {}, warn: () => {}, error: () => {} }
    );
    services.push(service);
    service.start();

    const socket = await connection;
    await waitForText(socket, "USER yoplai 0 * :yoplai\r\n");
    service.send("#room", "too early");

    const early = await new Promise<string>((resolve) => {
      let received = "";
      const onData = (data: Buffer) => { received += data.toString(); };
      socket.on("data", onData);
      setTimeout(() => {
        socket.off("data", onData);
        resolve(received);
      }, 20);
    });
    expect(early).not.toContain("PRIVMSG #room :too early");

    const delivered = waitForText(socket, "PRIVMSG #room :too early\r\n");
    socket.write(":server 001 yoplai :welcome\r\n");
    await expect(delivered).resolves.toContain("PRIVMSG #room :too early\r\n");
  });
});
