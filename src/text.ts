import * as net from "net";

// ----------------------------------------
// TCP Connection Wrapper Type
// ----------------------------------------
type TCPConn = {
  socket: net.Socket;

  // track connection state
  err: Error | null;
  ended: boolean;

  // pending reader (promise resolve/reject)
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

// ----------------------------------------
// soInit() — create a promise-aware wrapper around net.Socket
// ----------------------------------------
function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = {
    socket,
    err: null,
    ended: false,
    reader: null,
  };

  // handle data arrival
  socket.on("data", (data: Buffer) => {
    if (!conn.reader) return; // no one awaiting read
    // pause further 'data' events until next read
    conn.socket.pause();
    // fulfill the current read promise
    conn.reader.resolve(data);
    conn.reader = null;
  });

  // handle EOF (client half-close)
  socket.on("end", () => {
    conn.ended = true;
    if (conn.reader) {
      // empty Buffer signals EOF
      conn.reader.resolve(Buffer.from(""));
      conn.reader = null;
    }
  });

  // handle errors
  socket.on("error", (err: Error) => {
    conn.err = err;
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });

  return conn;
}

// ----------------------------------------
// soRead() — promise-based read
// ----------------------------------------
function soRead(conn: TCPConn): Promise<Buffer> {
  console.assert(!conn.reader, "Concurrent reads are not allowed");

  return new Promise((resolve, reject) => {
    // if socket already errored or ended, handle immediately
    if (conn.err) {
      reject(conn.err);
      return;
    }
    if (conn.ended) {
      resolve(Buffer.from("")); // EOF
      return;
    }

    // store promise callbacks
    conn.reader = { resolve, reject };
    // resume the 'data' event to allow new data
    conn.socket.resume();
  });
}

// ----------------------------------------
// soWrite() — promise-based write
// ----------------------------------------
function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
  console.assert(data.length > 0, "Cannot write empty buffer");

  return new Promise((resolve, reject) => {
    if (conn.err) {
      reject(conn.err);
      return;
    }

    conn.socket.write(data, (err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ----------------------------------------
// serveClient() — echo loop for one connection
// ----------------------------------------
async function serveClient(socket: net.Socket): Promise<void> {
  const conn = soInit(socket);

  while (true) {
    const data = await soRead(conn);

    if (data.length === 0) {
      console.log("end connection");
      break;
    }

    console.log("data:", data.toString());
    await soWrite(conn, data); // echo back
  }
}

// ----------------------------------------
// newConn() — async connection handler
// ----------------------------------------
async function newConn(socket: net.Socket): Promise<void> {
  console.log("new connection", socket.remoteAddress, socket.remotePort);
  try {
    await serveClient(socket);
  } catch (exc) {
    console.error("exception:", exc);
  } finally {
    socket.destroy(); // ensure closed
  }
}

// ----------------------------------------
// Main TCP Server
// ----------------------------------------
const server = net.createServer(
  { pauseOnConnect: true }, // required for controlled reading
  (socket) => {
    // don't await — handle connections concurrently
    newConn(socket);
  }
);

server.on("error", (err) => console.error("Server error:", err));

server.listen({ host: "127.0.0.1", port: 1234 }, () => {
  console.log("Promise-based Echo Server listening on 127.0.0.1:1234");
});
