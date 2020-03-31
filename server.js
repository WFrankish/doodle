const fs = require('fs');
const http = require('http');

function load(file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file, (err, data) => {
      err ? reject(err) : resolve(data);
    });
  });
}

const drawings = new Map;
class Drawing {
  constructor(id) {
    this.loadPromise = null;
    this.id = id;
    this.image = null;
    this.edits = [];
    // logicalTime advances by 1 for each edit.
    this.logicalTime = 0;
    // Callbacks awaiting writes.
    this.waiters = [];
    this.lastSave = 0;  // Logical time of last save.
    this.runTimer = setInterval(() => this.run(), 30000);
  }
  async run() {
    console.log('Running cleanup for ' + this.id + '.');
    // Dismiss all waiters. They will receive no updates. This prevents us from
    // accumulating waiters forever when nobody is drawing anything.
    for (const waiter of this.waiters) setInterval(waiter, 0);
    // Save the file contents.
    if (this.lastSave != this.logicalTime) {
      this.lastSave = this.logicalTime;
      await this.save();
    }
  }
  snapshotTime() { return this.logicalTime - this.edits.length }
  apply(edits) {
    if (edits.length == 0) throw new Error('Must append at least one thing.');
    this.edits.push(...edits);
    this.logicalTime += edits.length;
    // Notify any waiters.
    for (const waiter of this.waiters) setInterval(waiter, 0);
    this.waiters = [];
    return this.logicalTime;
  }
  anyUpdates() {
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
    });
  }
  async updates(logicalTime) {
    if (logicalTime < this.snapshotTime()) {
      throw new Error("Cannot deliver updates before the snapshot.");
    }
    if (logicalTime == this.logicalTime) await this.anyUpdates();
    const amount = this.logicalTime - logicalTime;
    const start = this.edits.length - amount;
    return this.edits.slice(start);
  }
  async snapshot(logicalTime, value) {
    if (this.snapshotTime() < logicalTime) {
      this.image = value;
      this.edits.splice(0, logicalTime - this.snapshotTime());
    }
    await this.save();
  }
  save() {
    return new Promise((resolve, reject) => {
      const name = 'images/' + this.id + '.json';
      const data = {
        image: this.image,
        logicalTime: this.logicalTime,
        edits: this.edits,
      };
      console.log('Writing ' + name);
      fs.writeFile(name, JSON.stringify(data), 'utf8', error => {
        error ? reject(error) : resolve();
      });
    });
  }
  static async load(id) {
    if (drawings.has(id)) {
      const drawing = drawings.get(id);
      if (drawing.loadPromise) await drawing.loadPromise;
      return drawing;
    }
    const drawing = new Drawing(id);
    drawings.set(id, drawing);
    drawing.loadPromise = new Promise(async (resolve, reject) => {
      let data;
      try {
        const name = 'images/' + id + '.json';
        data = JSON.parse(await load(name));
        console.log('Reading ' + name);
        drawing.image = data.image;
        drawing.logicalTime = data.logicalTime;
        drawing.edits = data.edits;
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

function respond(response, code, contentType, data) {
  response.writeHead(code, {'Content-Type': contentType});
  response.write(data);
  response.end();
}

function serve(response, contentType, data) {
  respond(response, 200, contentType, data);
}

function error(response, message) {
  respond(response, 404, 'text/plain', message);
}

async function get(id) { return await Drawing.load(id); }

async function commit(id, data, response) {
  const {logicalTime, imageData} = JSON.parse(data);
  const drawing = await get(id);
  await drawing.snapshot(logicalTime, imageData);
  serve(response, 'text/plain', 'You betcha buddy.');
}

async function draw(id, data, response) {
  const edits = JSON.parse(data);
  const drawing = await get(id);
  const logicalTime = drawing.apply(edits);
  serve(response, 'application/json', JSON.stringify({logicalTime}));
}

async function read(id, data, response) {
  const {from} = JSON.parse(data);
  const drawing = await get(id);
  const result = await drawing.updates(from);
  return serve(response, 'application/json', JSON.stringify(result));
}

async function snapshot(id, data, response) {
  const drawing = await get(id);
  if (drawing.image) {
    const result = {
      logicalTime: drawing.snapshotTime(),
      imageData: drawing.image,
    };
    return serve(response, 'application/json', JSON.stringify(result));
  } else {
    return error(response, 'No snapshot available.');
  }
}

async function wrap(f, id, data, response) {
  try {
    return await f(id, data, response);
  } catch (e) {
    console.error(e);
    return error(response, 'text/plain', 'Something went wrong.');
  }
}

function body(request) {
  return new Promise((resolve, reject) => {
    const body = [];
    request.on('data', chunk => body.push(chunk));
    request.on('end', () => resolve(Buffer.concat(body).toString()));
  });
}

async function main() {
  const indexPage = await load('index.html');
  const drawPage = await load('draw.html');
  const drawScript = await load('draw.js');

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost:8000');
    const path = url.pathname;
    if (path == '/') return serve(response, 'text/html', indexPage);
    if (path == '/draw.js') {
      return serve(response, 'text/javascript', drawScript);
    }
    const pathParts = path.split('/');  // '/a/b' -> ['', 'a', 'b']
    pathParts.splice(0, 1);  // Remove the empty string.
    const id = pathParts[0];
    if (pathParts.length == 1) {
      return serve(response, 'text/html', drawPage);
    } else if (pathParts.length == 2) {
      const data = await body(request);
      switch (pathParts[1]) {
        case "commit":
          return wrap(commit, id, data, response);
        case "draw":
          return wrap(draw, id, data, response);
        case "read":
          return wrap(read, id, data, response);
        case "snapshot":
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
