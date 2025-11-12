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

type DynamicBuffer = {
  data: Buffer;
  length: number;
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

function GrowBuffer(buf: DynamicBuffer, data: Buffer): void {
  const newLenght = buf.length + data.length;
  if (buf.data.length < newLenght) {
    let capacity = Math.max(buf.data.length, 32);
    //same trick used in dynamic arrays like C++’s std::vector.
    while (capacity < newLenght) capacity *= 2;
    const newBuf = Buffer.alloc(capacity);
    buf.data.copy(newBuf, 0, 0, buf.length);
    buf.data = newBuf;
  }
  data.copy(buf.data, buf.length, 0, data.length);
  buf.length = newLenght;
}

function CutMessage(buf: DynamicBuffer): null | Buffer {
  const idx = buf.data.subarray(0, buf.length).indexOf("\n");
  if (idx < 0) return null;
  const msg = Buffer.from(buf.data.subarray(0, idx + 1));
  bufPop(buf, idx + 1);

  return msg;
}

function bufPop(buf: DynamicBuffer, len: number): void {
  buf.data.copyWithin(0, len, buf.length);
  buf.length -= len;
}


async function newConn(socket: net.Socket): Promise<void> {
  const connection = InitializeConnection(socket);
  const buf: DynamicBuffer = { data: Buffer.alloc(0), length: 0 };

  console.log("New connection from", socket.remoteAddress, socket.remotePort);

  while (true) {
    const msg = CutMessage(buf);
    if (!msg) {
      const data = await ReadConnection(connection);
      GrowBuffer(buf, data);

      if (data.length === 0) {
        console.log("Client closed connection");
        socket.destroy();
        return;
      }
      continue;
    }

    const text = msg.toString().trim();
    if (text === "quit") {
      console.log("Received quit → closing connection");
      await WriteConnection(connection, Buffer.from("Bye.\n"));
      socket.destroy();
      return;
    } else {
      console.log("Received:", text);
      const reply = Buffer.concat([Buffer.from("Echo: "), msg]);
      await WriteConnection(connection, reply);
    }
  }
}


const server = net.createServer({ pauseOnConnect: true }, newConn);
server.on("error", (err: Error) => console.error("Server error:", err));
server.listen({ host: "127.0.0.1", port: 1234 }, () =>
  console.log("Promise-based Echo Server listening on 127.0.0.1:1234")
);
