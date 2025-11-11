import * as net from "net";

type TCPprops = {
  socket: net.Socket;
  err: Error | null;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

function InitializeConnection(socket: net.Socket): TCPprops {
  const connection: TCPprops = {
    socket,
    err: null,
    ended: false,
    reader: null,
  };

  socket.on("data", (data: Buffer) => {
    if (!connection.reader) return;
    connection.socket.pause();
    connection.reader.resolve(data);
    connection.reader = null;
  });

  socket.on("end", () => {
    connection.ended = true;
    if (connection.reader) {
      connection.reader.resolve(Buffer.from(""));
      connection.reader = null;
    }
  });

  socket.on("error", (err: Error) => {
    connection.err = err;
    if (connection.reader) {
      connection.reader.reject(err);
      connection.reader = null;
    }
  });

  return connection;
}

function ReadConnection(connection: TCPprops): Promise<Buffer> {
  console.assert(!connection.reader, "Concurrent reads are not allowed");
  return new Promise((resolve, reject) => {
    if (connection.ended) return resolve(Buffer.from(""));
    if (connection.err) return reject(connection.err);
    connection.reader = { resolve, reject };
    connection.socket.resume();
  });
}

function WriteConnection(connection: TCPprops, data: Buffer): Promise<void> {
  console.assert(data.length > 0, "Cannot write empty buffer");
  return new Promise((resolve, reject) => {
    if (connection.err) return reject(connection.err);
    connection.socket.write(data, (err: Error | null | undefined) =>
      err ? reject(err) : resolve()
    );
  });
}

async function newConn(socket: net.Socket): Promise<void> {
  const connection = InitializeConnection(socket);
  while (true) {
    const data = await ReadConnection(connection);
    if (data.length === 0) {
      console.log("end connection");
      socket.destroy();
      break;
    }
    console.log("data:", data.toString());
    await WriteConnection(connection, data);
  }
}

const server = net.createServer({ pauseOnConnect: true }, newConn);
server.on("error", (err: Error) => console.error("Server error:", err));
server.listen({ host: "127.0.0.1", port: 1234 }, () =>
  console.log("Promise-based Echo Server listening on 127.0.0.1:1234")
);
