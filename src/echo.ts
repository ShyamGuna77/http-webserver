import { Socket } from "dgram";
import * as net from "net";
import { devNull } from "os";

type TCPprops = {
  socket: net.Socket;
  err: Error | null;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

function IntializeConnection(socket: net.Socket): TCPprops {
  const connection: TCPprops = {
    socket,
    err: null,
    ended: false,
    reader: null,
  };
  socket.on("data", (data: Buffer) => {
    if (!connection.reader) return;
    connection.socket.pause();
    connection.reader?.resolve(data);
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
    if (connection.ended) {
      resolve(Buffer.from(""));
      return;
    }

    if (connection.err) {
      reject(connection.err);
      return;
      }
      
      connection.reader = { resolve, reject }
      connection.socket.resume()
      
  });
}


function WriteConnection(connection: TCPprops, data: Buffer): Promise<void> {
  console.assert(data.length > 0, "Cannot write empty buffer");
  return new Promise((resolve, reject) => {
    if (connection.err) {
      reject(connection.err);
      return;
    }
    connection.socket.write(data, (err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });
}


async function ServerClient(socket: net.Socket): Promise<void> {
    const connection = IntializeConnection(socket);
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




const server = net.createServer({
  allowHalfOpen: true,
});

server.on("error", (err: Error) => {
  console.error("Server error:", err);
  throw err;
});

server.listen({ host: "127.0.0.1", port: 1234 }, () => {
  console.log("promised baded echo server ");
});
