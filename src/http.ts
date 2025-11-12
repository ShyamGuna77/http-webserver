import * as net from "net";

type TCPConn = {
  socket: net.Socket;
  err: Error | null;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

type DynBuf = {
  data: Buffer;
  length: number;
};

type HTTPReq = {
  method: string;
  uri: Buffer;
  version: string;
  headers: Buffer[];
};

type BodyReader = {
  length: number;
  read: () => Promise<Buffer>;
};

type HTTPRes = {
  code: number;
  headers: Buffer[];
  body: BodyReader;
};


   //TCP Utility Functions

function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = { socket, err: null, ended: false, reader: null };

  socket.on("data", (data: Buffer) => {
    if (!conn.reader) return;
    conn.socket.pause();
    conn.reader.resolve(data);
    conn.reader = null;
  });

  socket.on("end", () => {
    conn.ended = true;
    if (conn.reader) {
      conn.reader.resolve(Buffer.from(""));
      conn.reader = null;
    }
  });

  socket.on("error", (err: Error) => {
    conn.err = err;
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });

  return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (conn.ended) return resolve(Buffer.from(""));
    if (conn.err) return reject(conn.err);
    conn.reader = { resolve, reject };
    conn.socket.resume();
  });
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.socket.write(data, (err?: Error | null) =>
      err ? reject(err) : resolve()
    );
  });
}

// Dynamic Buffer Helpers

function bufPush(buf: DynBuf, data: Buffer): void {
  const newLen = buf.length + data.length;
  if (buf.data.length < newLen) {
    let cap = Math.max(buf.data.length, 32);
    while (cap < newLen) cap *= 2;
    const grown = Buffer.alloc(cap);
    buf.data.copy(grown, 0, 0, buf.length);
    buf.data = grown;
  }
  data.copy(buf.data, buf.length);
  buf.length = newLen;
}

function bufPop(buf: DynBuf, len: number): void {
  buf.data.copyWithin(0, len, buf.length);
  buf.length -= len;
}

// HTTP Parsing + Encoding

const kMaxHeaderLen = 8 * 1024;

class HTTPError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// parse header if complete
function cutMessage(buf: DynBuf): HTTPReq | null {
  const idx = buf.data.subarray(0, buf.length).indexOf("\r\n\r\n");
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen)
      throw new HTTPError(413, "Header too large");
    return null;
  }

  const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

function splitLines(data: Buffer): Buffer[] {
  return data
    .toString("latin1")
    .split("\r\n")
    .map((l) => Buffer.from(l, "latin1"));
}

function parseRequestLine(line: Buffer): [string, Buffer, string] {
  const parts = line.toString("latin1").split(" ");
  if (parts.length !== 3) throw new HTTPError(400, "Bad request line");
  const [method, rawUri, protocol] = parts as [string, string, string];
  if (!protocol.startsWith("HTTP/")) throw new HTTPError(400, "Bad version");
  const version = protocol.split("/", 2)[1];
  if (!version) throw new HTTPError(400, "Bad version");
  return [method, Buffer.from(rawUri, "latin1"), version];
}

function validateHeader(h: Buffer): boolean {
  if (h.length === 0) return true; // skip blank lines
  return h.includes(":".charCodeAt(0));
}

function parseHTTPReq(data: Buffer): HTTPReq {
  const lines = splitLines(data);
  const requestLine = lines[0];
  if (!requestLine) throw new HTTPError(400, "Missing request line");
  const [method, uri, version] = parseRequestLine(requestLine);
  const headers: Buffer[] = [];
  for (const line of lines.slice(1, -1)) {
    const h = Buffer.from(line);
    if (h.length === 0) continue; // skip blank lines
    if (!validateHeader(h)) throw new HTTPError(400, "Invalid header field");
    headers.push(h);
  }
  return { method, uri, version, headers };
}

function fieldGet(headers: Buffer[], key: string): Buffer | null {
  const lowerKey = key.toLowerCase();
  for (const h of headers) {
    const line = h.toString("latin1");
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (name.toLowerCase() === lowerKey) {
      const value = line.slice(idx + 1).trim();
      return Buffer.from(value, "latin1");
    }
  }
  return null;
}

// HTTP Body Readers

function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async () => {
      if (done) return Buffer.from("");
      done = true;
      return data;
    },
  };
}

function readerFromConnLength(
  conn: TCPConn,
  buf: DynBuf,
  remain: number
): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> => {
      if (remain === 0) return Buffer.from("");
      if (buf.length === 0) {
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0) throw new Error("Unexpected EOF");
      }
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return data;
    },
  };
}

function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
  let bodyLen = -1;
  const contentLen = fieldGet(req.headers, "Content-Length");
  const chunked =
    fieldGet(req.headers, "Transfer-Encoding")?.equals(
      Buffer.from("chunked")
    ) || false;
  const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");

  if (!bodyAllowed) return readerFromMemory(Buffer.from(""));

  if (contentLen) {
    bodyLen = parseInt(contentLen.toString("latin1"), 10);
    if (isNaN(bodyLen)) throw new HTTPError(400, "Bad Content-Length");
    return readerFromConnLength(conn, buf, bodyLen);
  }

  if (chunked) {
    // not yet supported — ignore body
    return readerFromMemory(Buffer.from(""));
  }

  // fallback: no content length, no chunked encoding
  return readerFromMemory(Buffer.from(""));
}

// HTTP Response Writer

async function writeHTTPResp(conn: TCPConn, res: HTTPRes): Promise<void> {
  if (res.body.length < 0) throw new Error("TODO: chunked encoding");

  res.headers.push(Buffer.from(`Content-Length: ${res.body.length}`));
  const header = encodeHTTPResp(res);
  await soWrite(conn, header);

  while (true) {
    const data = await res.body.read();
    if (data.length === 0) break;
    await soWrite(conn, data);
  }
}

function encodeHTTPResp(res: HTTPRes): Buffer {
  const lines: string[] = [];
  lines.push(`HTTP/1.1 ${res.code} OK`);
  res.headers.forEach((h) => lines.push(h.toString("latin1")));
  lines.push("\r\n");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

// Request Handler

async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
  let resp: BodyReader;
  switch (req.uri.toString("latin1")) {
    case "/echo":
      resp = body;
      break;
    default:
      resp = readerFromMemory(Buffer.from("hello world.\n"));
      break;
  }
  return {
    code: 200,
    headers: [Buffer.from("Server: my_first_http_server")],
    body: resp,
  };
}

// Server Loop

async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };

  while (true) {
    const msg = cutMessage(buf);
    if (!msg) {
      const data = await soRead(conn);
      bufPush(buf, data);
      if (data.length === 0 && buf.length === 0) return;
      if (data.length === 0) throw new HTTPError(400, "Unexpected EOF");
      continue;
    }

    const reqBody = readerFromReq(conn, buf, msg);
    const res = await handleReq(msg, reqBody);
    await writeHTTPResp(conn, res);

    if (msg.version === "1.0") return;

    // consume any leftover body data
    while ((await reqBody.read()).length > 0) {}
  }
}

// Server Entry

async function newConn(socket: net.Socket): Promise<void> {
  const conn = soInit(socket);
  try {
    await serveClient(conn);
  } catch (err) {
    console.error("exception:", err);
    if (err instanceof HTTPError) {
      const resp: HTTPRes = {
        code: err.code,
        headers: [],
        body: readerFromMemory(Buffer.from(err.message + "\n")),
      };
      try {
        await writeHTTPResp(conn, resp);
      } catch {}
    }
  } finally {
    socket.destroy();
  }
}

const server = net.createServer({ pauseOnConnect: true }, newConn);
server.listen({ host: "127.0.0.1", port: 1234 }, () =>
  console.log(" Basic HTTP Server listening on http://127.0.0.1:1234")
);
