const committedCanvas = document.getElementById('committed');
const committedContext = committedCanvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay');
const overlayContext = overlayCanvas.getContext('2d');

const width = 1280;
const height = 1024;
let scale = 1;
committedCanvas.width = width;
committedCanvas.height = height;
overlayCanvas.width = width;
overlayCanvas.height = height;

// Resize the display dimensions of the canvas whenever the window changes size.
function resize() {
  const aspect = width / height;
  const actualAspect = innerWidth / innerHeight;
  if (aspect < actualAspect) {
    console.log('wide')
    scale = innerHeight / height;
    committedCanvas.style.width = innerHeight * aspect + 'px';
    committedCanvas.style.height = innerHeight + 'px';
    overlayCanvas.style.width = innerHeight * aspect + 'px';
    overlayCanvas.style.height = innerHeight + 'px';
  } else {
    console.log('narrow');
    scale = innerWidth / width;
    committedCanvas.style.width = innerWidth + 'px';
    committedCanvas.style.height = innerWidth / aspect + 'px';
    overlayCanvas.style.width = innerWidth + 'px';
    overlayCanvas.style.height = innerWidth / aspect + 'px';
  }
}
resize();
addEventListener('resize', resize);

function load(dataUri) {
  return new Promise((resolve, reject) => {
    const image = new Image;
    image.addEventListener('load', () => resolve(image));
    image.src = dataUri;
  });
}

function draw(context, edits) {
  context.lineCap = 'round';
  for (const edit of edits) {
    context.beginPath();
    context.strokeStyle = edit.color;
    context.lineWidth = edit.size;
    context.moveTo(edit.from[0], edit.from[1]);
    context.lineTo(edit.to[0], edit.to[1]);
    context.stroke();
  }
}

// Code for handling user inputs.
function randomColor() {
  const value = Math.floor(Math.random() * 256 * 256 * 256);
  return '#' + value.toString(16).padStart(6, '0');
}
let color = randomColor();
let size = 10;
let held = false;
let pendingEdits = [];  // Edits which have been sent but not received.
let newEdits = [];  // Edits which have not been sent.
let position = [0, 0];
addEventListener('mousedown', event => {
  position = [event.x / scale, event.y / scale];
  held = true;
  newEdits.push({
    from: [position[0] - 0.1, position[1]],
    to: [position[0] + 0.1, position[1]],
    color,
    size,
  });
});
addEventListener('mouseup', event => held = false);
addEventListener('mouseleave', event => held = false);
addEventListener('mousemove', event => {
  const newPosition = [event.x / scale, event.y / scale];
  if (held) {
    newEdits.push({from: position, to: newPosition, color, size});
  }
  position = newPosition;
});

// Code for delivering edits.
function delay(ms) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}
async function sendEdits(edits) {
  const response = await fetch(location + '/draw', {
    method: 'POST',
    body: JSON.stringify(edits),
  });
  return await response.json();
}
async function deliverEdits() {
  let nextStart = Date.now();
  const defaultSendInterval = 100;
  let sendInterval = defaultSendInterval;
  while (true) {
    await delay(nextStart - Date.now());
    nextStart = Date.now() + sendInterval;
    if (newEdits.length == 0) continue;
    try {
      const toSend = newEdits;
      newEdits = [];
      const {logicalTime} = await sendEdits(toSend);
      pendingEdits.push({logicalTime, edits: toSend});
      sendInterval = defaultSendInterval;
    } catch (error) {
      console.log("Delivery failed. Backing off.");
      sendInterval *= 2;
    }
  }
}
deliverEdits();

// Code for rendering the overlay canvas.
function animationFrame() {
  return new Promise((resolve, reject) => requestAnimationFrame(resolve));
}
function drawCursor(context) {
  context.beginPath();
  context.lineCap = 'round';
  context.strokeStyle = color;
  context.lineWidth = size;
  context.beginPath();
  context.moveTo(position[0] - 0.5, position[1]);
  context.lineTo(position[0] + 0.5, position[1]);
  context.stroke();
}
async function drawOverlay() {
  while (true) {
    await animationFrame();
    overlayContext.clearRect(0, 0, width, height);
    for (const pending of pendingEdits) {
      draw(overlayContext, pending.edits);
    }
    draw(overlayContext, newEdits);
    drawCursor(overlayContext);
  }
}
drawOverlay();

// Code for updating the committed data canvas.
async function readSnapshot() {
  const response = await fetch(location + '/snapshot');
  const {logicalTime, imageData} = await response.json();
  return {logicalTime, image: await load(imageData)};
}

async function readUpdates(from) {
  const response = await fetch(location + '/read', {
    method: 'POST',
    body: JSON.stringify({from}),
  });
  return await response.json();
}

const snapshotPeriod = 1000;
const snapshotParity = Math.floor(snapshotPeriod * Math.random());
function nextSnapshot(time) {
  const cycle =
      Math.floor((time - snapshotParity + snapshotPeriod - 1) / snapshotPeriod);
  return cycle * snapshotPeriod + snapshotParity;
}

async function sendSnapshot(logicalTime) {
  console.log('Submitting snapshot for %d.', logicalTime);
  const response = await fetch(location + '/commit', {
    method: 'POST',
    body: JSON.stringify({logicalTime, imageData: committedCanvas.toDataURL()}),
  });
}

async function updateCommitted() {
  let logicalTime = 0;
  while (true) {
    try {
      const edits = await readUpdates(logicalTime);
      const nextSnapshotAfter = nextSnapshot(logicalTime);
      draw(committedContext, edits);
      logicalTime += edits.length;
      if (logicalTime >= nextSnapshotAfter) sendSnapshot(logicalTime);
      // Remove pending edits which have arrived.
      while (pendingEdits.length > 0 &&
             pendingEdits[0].logicalTime < logicalTime) {
        pendingEdits.shift();
      }
    } catch (error) {
      console.log('Starting from snapshot.');
      const snapshot = await readSnapshot();
      committedContext.clearRect(0, 0, width, height);
      committedContext.drawImage(snapshot.image, 0, 0, width, height);
      logicalTime = snapshot.logicalTime;
    }
  }
}
updateCommitted();
