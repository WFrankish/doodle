import fs = require('fs');
import http = require('http');

type ImageFile = {
  image: string;
  logicalTime: number;
  edits: Edit[];
};

function load(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fs.readFile(file, (err, data) => {
      err ? reject(err) : resolve(data);
    });
  });
}

function save(file: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.writeFile(file, data, 'utf8', (err) => {
      err ? reject(err) : resolve();
    });
  });
}

const drawings = new Map<string, Drawing>();
// Period at which we run cleanup work for the drawing. This includes culling
// open connections and saving the contents.
const runPeriod = 30 * 1000;
// Period of inactivity after which we drop the drawing from memory.
const cleanupDelay = 5 * 60 * 1000;
class Drawing {
  loadPromise: Promise<void> | null;
  id: string;
  image: string | null;
  lastAccess: number;
  edits: Edit[];
  logicalTime: number;
  waiters: TimerHandler[];
  lastSave: number;
  runTimer: NodeJS.Timeout;
  constructor(id: string) {
    this.loadPromise = null;
    this.id = id;
    this.image = null;
    this.lastAccess = Date.now();
    this.edits = [];
    // logicalTime advances by 1 for each edit.
    this.logicalTime = 0;
    // Callbacks awaiting writes.
    this.waiters = [];
    this.lastSave = 0; // Logical time of last save.
    this.runTimer = setInterval(() => this.run(), runPeriod);
  }
  async run(): Promise<void> {
    console.log('Running cleanup for ' + this.id + '.');
    // Dismiss all waiters. They will receive no updates. This prevents us from
    // accumulating waiters forever when nobody is drawing anything.
    for (const waiter of this.waiters) setTimeout(waiter, 0);
    this.waiters = [];
    // Save the file contents.
    await this.save();
    const lastAccess = this.lastAccess;
    if (Date.now() - lastAccess > cleanupDelay) {
      const name = 'images/' + this.id + '.json';
      // Only shut the file if it still hasn't been touched after saving.
      if (lastAccess == this.lastAccess) {
        clearInterval(this.runTimer);
        console.log('Closing ' + name);
        drawings.delete(this.id);
      }
    }
  }
  snapshotTime(): number {
    return this.logicalTime - this.edits.length;
  }
  apply(edits: Edit[]): number {
    if (edits.length == 0) throw new Error('Must append at least one thing.');
    this.lastAccess = Date.now();
    this.edits.push(...edits);
    this.logicalTime += edits.length;
    // Notify any waiters.
    for (const waiter of this.waiters) setTimeout(waiter, 0);
    this.waiters = [];
    return this.logicalTime;
  }
  anyUpdates(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
    });
  }
  async updates(logicalTime: number): Promise<Edit[]> {
    this.lastAccess = Date.now();
    if (logicalTime < this.snapshotTime()) {
      throw new Error('Cannot deliver updates before the snapshot.');
    }
    if (logicalTime == this.logicalTime) await this.anyUpdates();
    const amount = this.logicalTime - logicalTime;
    const start = this.edits.length - amount;
    return this.edits.slice(start);
  }
  async snapshot(logicalTime: number, value: string): Promise<void> {
    if (this.snapshotTime() < logicalTime) {
      this.image = value;
      this.edits.splice(0, logicalTime - this.snapshotTime());
    }
    await this.save();
  }
  async save(): Promise<void> {
    if (this.logicalTime == this.lastSave) return;
    const lastSave = this.logicalTime;
    const name = 'images/' + this.id + '.json';
    const data = {
      image: this.image,
      logicalTime: this.logicalTime,
      edits: this.edits,
    };
    console.log('Writing ' + name);
    await save(name, JSON.stringify(data));
    this.lastSave = lastSave;
  }
  static async load(id: string): Promise<Drawing> {
    if (drawings.has(id)) {
      const drawing = drawings.get(id)!;
      if (drawing.loadPromise) await drawing.loadPromise;
      return drawing;
    }
    const drawing = new Drawing(id);
    drawings.set(id, drawing);
    drawing.loadPromise = new Promise(async (resolve, reject) => {
      let data: ImageFile;
      try {
        const name = 'images/' + id + '.json';
        data = JSON.parse(await load(name) as any); // why does this work?
        console.log('Reading ' + name);
        drawing.image = data.image;
        drawing.logicalTime = data.logicalTime;
        drawing.edits = data.edits;
        drawing.lastSave = drawing.logicalTime;
      } catch (error) {
        console.log('Could not load ' + id + ': assuming it is new.');
      }
      drawing.loadPromise = null;
      resolve();
    });
    await drawing.loadPromise;
    return drawing;
  }
}

function respond<T>(
  response: http.ServerResponse,
  code: number,
  contentType: string,
  data: T
): void {
  response.writeHead(code, { 'Content-Type': contentType });
  response.write(data);
  response.end();
}

function serve<T>(
  response: http.ServerResponse,
  contentType: string,
  data: T
): void {
  respond(response, 200, contentType, data);
}

function error(response: http.ServerResponse, message: string): void {
  respond(response, 404, 'text/plain', message);
}

async function get(id: string): Promise<Drawing> {
  return await Drawing.load(id);
}

async function commit(
  id: string,
  data: string,
  response: http.ServerResponse
): Promise<void> {
  const { logicalTime, imageData } = JSON.parse(data) as ImageMessage;
  const drawing = await get(id);
  await drawing.snapshot(logicalTime, imageData);
  serve(response, 'text/plain', 'You betcha buddy.');
}

async function draw(
  id: string,
  data: string,
  response: http.ServerResponse
): Promise<void> {
  const edits = JSON.parse(data);
  const drawing = await get(id);
  const logicalTime = drawing!.apply(edits);
  serve(response, 'application/json', JSON.stringify({ logicalTime }));
}

async function read(
  id: string,
  data: string,
  response: http.ServerResponse
): Promise<void> {
  const { from } = JSON.parse(data);
  const drawing = await get(id);
  const result = await drawing!.updates(from);
  return serve(response, 'application/json', JSON.stringify(result));
}

async function snapshot(
  id: string,
  data: string,
  response: http.ServerResponse
): Promise<void> {
  const drawing = await get(id);
  if (drawing!.image) {
    const result = {
      logicalTime: drawing!.snapshotTime(),
      imageData: drawing!.image,
    };
    return serve(response, 'application/json', JSON.stringify(result));
  } else {
    return error(response, 'No snapshot available.');
  }
}

async function wrap(
  f: (id: string, data: string, response: http.ServerResponse) => Promise<any>,
  id: string,
  data: string,
  response: http.ServerResponse
): Promise<void> {
  try {
    return await f(id, data, response);
  } catch (e) {
    console.error(e);
    return error(response, 'Something went wrong.');
  }
}

function body(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const body: Uint8Array[] = [];
    request.on('data', (chunk: Uint8Array) => body.push(chunk));
    request.on('end', () => resolve(Buffer.concat(body).toString()));
  });
}

async function main(): Promise<void> {
  const indexPage = await load('index.html');
  const drawPage = await load('draw.html');
  const drawScript = await load('draw.js');
  const drawSourceMap = await load('draw.js.map');
  const drawSource = await load('draw.ts');

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost:8000');
    const path = url.pathname;
    if (path == '/') return serve(response, 'text/html', indexPage);
    if (path == '/draw.js') {
      return serve(response, 'text/javascript', drawScript);
    }
    if (path == '/draw.js.map') {
      return serve(response, 'application/octet-stream', drawSourceMap);
    }
    if (path == '/draw.ts') {
      return serve(response, 'application/octet-stream', drawSource);
    }
    const pathParts = path.split('/'); // '/a/b' -> ['', 'a', 'b']
    pathParts.splice(0, 1); // Remove the empty string.
    const id = pathParts[0];
    if (pathParts.length == 1) {
      return serve(response, 'text/html', drawPage);
    } else if (pathParts.length == 2) {
      const data = await body(request);
      switch (pathParts[1]) {
        case 'commit':
          return wrap(commit, id, data, response);
        case 'draw':
          return wrap(draw, id, data, response);
        case 'read':
          return wrap(read, id, data, response);
        case 'snapshot':
          return wrap(snapshot, id, data, response);
        default:
          return error(response, 'Invalid operation.');
      }
    } else {
      return error(response, 'This request is garbage.');
    }
  });
  server.listen(8000);
}
main();
