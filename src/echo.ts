import * as net from "net"




const server = net.createServer({
  allowHalfOpen: true,
});

server.on("error", (err: Error) => {
  console.error("Server error:", err);
  throw err;
});

server.on("connection", (socket: net.Socket) => {
  console.log("promised baded echo connection", socket.remoteAddress, socket.remotePort);
});