import * as net from "net";

function newConn(socket: net.Socket): void {
  console.log("new connection", socket.remoteAddress, socket.remotePort);

  socket.on("end", () => {
    console.log("EOF.");
  });

  socket.on("data", (data: Buffer) => {
    console.log("data:", data.toString());
    socket.write(data); 

    if (data.includes("q")) {
      console.log("closing.");
      socket.end();
    }
  });
}

const server = net.createServer();

server.on("error", (err: Error) => {
  console.error("Server error:", err);
  throw err;
});

server.on("connection", newConn);

server.listen({ host: "127.0.0.1", port: 1234 }, () => {
  console.log("Server listening on 127.0.0.1:1234");
});
