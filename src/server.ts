import * as net from "net";

let server = net.createServer();

server.listen({ host: "127.0.0.1", port: 3000 }, () => {
  console.log("Server is running on port 8080");
});
